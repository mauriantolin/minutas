import type {
  AsrScores,
  CleanTranscript,
  CleanTurn,
  CorrelatedSegment,
  CorrelationScores,
  ExtractedActionItem,
  ExtractedItem,
  ExtractionResult,
  GateBScores,
  GateId,
  HighlightTap,
  Meeting,
  MeetingIngestPayload,
  MeetingStatus,
  MeetingSummary,
  ModelTier,
  PipelinePhase,
  PipelineScores,
  PipelineState,
  SummaryArtifact,
  VerificationReport,
  VerifiedClaim,
} from "@teams-agent-core/shared";
import {
  correlateSpeakersV2,
  findQuote,
  tokenize,
} from "@teams-agent-core/shared";
import {
  audioKey,
  audioObjectExists,
  batchTranscriptKey,
  deleteAudioObjects,
  getBatchTranscriptJson,
  getCleanTranscript,
  getExtraction,
  getLabeledTranscript,
  getMeetingItem,
  getRawPayload,
  getSummaryDraft,
  getVerification,
  putBatchJobToken,
  putCleanTranscript,
  putExtraction,
  putLabeledTranscript,
  putMergedTranscript,
  putSummaryArtifact,
  putSummaryDraft,
  putTranscript,
  putVerification,
  updateMeeting,
} from "../lib/store.js";
import {
  batchJobName,
  mergeBatchTranscript,
  parseBatchTranscript,
  startBatchTranscription,
} from "../lib/batch.js";
import { emitPublishMetrics } from "../lib/telemetry.js";
import {
  cleanTranscriptContext,
  generateCleanTranscript,
  generateExtraction,
  generateSummary,
  generateVerification,
  parseTurnAnchors,
  rejudgeClaims,
  repairSummary,
  StructuredOutputError,
  type CleanDraft,
} from "../lib/agent.js";
import { auditTurnInvariants, hasViolations, type TurnAudit } from "../lib/invariants.js";

/**
 * Single pipeline worker — every state in the MeetingPipeline state machine
 * invokes this Lambda with a phase discriminator.
 */
export type PipelineWorkerPhase =
  | "correlate"
  | "asrScore"
  | "waitAudio"
  | "batchAsr"
  | "mergeBatch"
  | "clean"
  | "extract"
  | "synthesize"
  | "verify"
  | "repair"
  | "publish"
  | "fail";

export interface PipelineWorkerEvent {
  tenantId: string;
  meetingId: string;
  executionArn: string;
  phase: PipelineWorkerPhase;
  modelTier?: ModelTier;
  /** `$$.Task.Token` of the waitForTaskToken state; present only on `batchAsr`. */
  taskToken?: string;
  /** `$$.Execution.StartTime`; present only on `waitAudio` (poll deadline anchor). */
  executionStartTime?: string;
  /** SFN Catch payload; present only on `fail`. */
  error?: { Error?: string; Cause?: string };
}

/** Flat result so SFN Choice states can read gate scores/actions directly. */
export interface PipelineWorkerResult {
  meetingId: string;
  phase: PipelinePhase;
  scores: PipelineScores;
  status?: MeetingStatus;
  /**
   * Gate B routing, emitted by `asrScore`. Consent is part of the decision, so
   * the SFN Choice reads this action rather than re-deriving it from scores —
   * "batchAsr" also implies audioPending was declared (the poll loop's target).
   */
  gateBAction?: "batchAsr" | "proceed";
  /** Gate E routing, emitted by `verify`: next state the ladder demands. */
  gateEAction?: "publish" | "repair" | "synthesize";
  /** Tier the re-synthesis must run on when gateEAction === "synthesize". */
  escalateTier?: ModelTier;
  /** Poll outcome, emitted by `waitAudio` (SFN reads it at `$.audioWait`). */
  audioReady?: boolean;
  audioTimedOut?: boolean;
}

// Mirrored from the SFN Choice thresholds (baked at synth time) so the worker's
// GateDecision audit trail can never disagree with the routing.
const GATE_A_MAX_UNRESOLVED_PCT = Number(
  process.env.GATE_A_MAX_UNRESOLVED_PCT ?? "15",
);
const GATE_A_MIN_LABEL_MARGIN = Number(
  process.env.GATE_A_MIN_LABEL_MARGIN ?? "0.3",
);
const GATE_A_MIN_CAPTION_AGREEMENT_PCT = Number(
  process.env.GATE_A_MIN_CAPTION_AGREEMENT_PCT ?? "80",
);
// Stricter than Gate C's: Gate B spends real money (+$1.44/hr tab re-ASR), so
// it fires on clearly bad tab audio, not merely "escalate the synth tier" bad.
const GATE_B_MIN_TAB_MEAN_CONFIDENCE = Number(
  process.env.GATE_B_MIN_TAB_MEAN_CONFIDENCE ?? "0.7",
);
const GATE_B_MIN_TAB_P10_CONFIDENCE = Number(
  process.env.GATE_B_MIN_TAB_P10_CONFIDENCE ?? "0.4",
);
const AUDIO_WAIT_TIMEOUT_SEC = Number(
  process.env.AUDIO_WAIT_TIMEOUT_SEC ?? "1200",
);
const GATE_C_MIN_MEAN_CONFIDENCE = Number(
  process.env.GATE_C_MIN_MEAN_CONFIDENCE ?? "0.8",
);
const GATE_C_MIN_P10_CONFIDENCE = Number(
  process.env.GATE_C_MIN_P10_CONFIDENCE ?? "0.5",
);
const GATE_C_MAX_CAPTION_WER = Number(
  process.env.GATE_C_MAX_CAPTION_WER ?? "0.35",
);
const GATE_C_MIN_SELF_QUALITY = Number(
  process.env.GATE_C_MIN_SELF_QUALITY ?? "0.5",
);
const GATE_C_MAX_GARBLED_PCT = Number(
  process.env.GATE_C_MAX_GARBLED_PCT ?? "20",
);
const GATE_E_MAX_UNSUPPORTED_RATE = Number(
  process.env.GATE_E_MAX_UNSUPPORTED_RATE ?? "0.1",
);

const TIER_RANK: Record<ModelTier, number> = { haiku: 0, sonnet: 1, opus: 2 };

export const handler = async (
  event: PipelineWorkerEvent,
): Promise<PipelineWorkerResult> => {
  const { tenantId, meetingId } = event;
  const meeting = await getMeetingItem(tenantId, meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);

  const pipeline: PipelineState = meeting.pipeline ?? {
    phase: "INGESTED",
    tier: "haiku",
    attempts: 0,
    scores: {},
    asrSource: "streaming",
  };
  pipeline.executionArn = event.executionArn;
  if (
    event.modelTier &&
    TIER_RANK[event.modelTier] > TIER_RANK[pipeline.tier]
  ) {
    pipeline.tier = event.modelTier;
  }

  // A parse/validation failure in an LLM phase is never terminal "failed":
  // the meeting publishes as needs_review with lastError and stays reprocessable.
  const llmPhase = async (
    fn: () => Promise<PipelineWorkerResult>,
  ): Promise<PipelineWorkerResult> => {
    try {
      return await fn();
    } catch (err) {
      if (!(err instanceof StructuredOutputError)) throw err;
      pipeline.lastError = `${event.phase}: ${err.message}`;
      await updateMeeting(tenantId, meetingId, {
        pipeline,
        status: "needs_review",
      });
      // This IS a publish (needs_review is a terminal published state): without
      // a datapoint here the NeedsReviewRate alarm is blind to fleet-wide
      // structured-output regressions — the exact class it exists to catch.
      await emitPublishMetrics(pipeline, true);
      return result(meetingId, pipeline, "needs_review");
    }
  };

  switch (event.phase) {
    case "correlate": {
      const payload = await getRawPayload(tenantId, meetingId);
      const { segments: labeled, scores } = correlateSpeakersV2({
        segments: payload.segments,
        speakerTimeline: payload.speakerTimeline,
        captionTimeline: payload.captionTimeline,
        localUserName: payload.localUserName,
      });
      // transcript.json keeps the v1 contract (CorrelatedSegment extends
      // LabeledSegment); transcript.labeled.json is the durable P2 artifact.
      await putTranscript(tenantId, meetingId, labeled);
      await putLabeledTranscript(tenantId, meetingId, labeled);
      const participants = [
        ...new Set(labeled.filter((s) => s.resolved).map((s) => s.speaker)),
      ].map((name) => ({ name }));
      pipeline.phase = "CORRELATED";
      pipeline.scores.correlation = scores;
      recordGate(pipeline, "gateA", ...gateAEval(scores));
      await updateMeeting(tenantId, meetingId, { pipeline, participants });
      return result(meetingId, pipeline);
    }

    case "asrScore": {
      const payload = await getRawPayload(tenantId, meetingId);
      pipeline.phase = "ASR_SCORED";
      pipeline.scores.asr = asrScores(payload);
      // Tab-only stats: the always-high-confidence mic stream would mask a bad
      // tab stream in the meeting-wide numbers (batch re-ASR is tab-only).
      pipeline.scores.gateB = gateBScores(payload);
      const [gateBFired, gateBReason] = gateBEval(
        meeting,
        pipeline.scores.gateB,
      );
      recordGate(pipeline, "gateB", gateBFired, gateBReason);
      await updateMeeting(tenantId, meetingId, { pipeline });
      return {
        ...result(meetingId, pipeline),
        gateBAction: gateBFired ? "batchAsr" : "proceed",
      };
    }

    // One turn of the SFN Wait/HeadObject poll loop (doc D3): the worker owns
    // the bounded deadline so the loop stays counter-free. Only the tab source
    // matters — batch re-ASR never consumes mic, and gateBEval guarantees tab
    // was declared at finalize.
    case "waitAudio": {
      if (await audioObjectExists(tenantId, meetingId, "tab")) {
        return { ...result(meetingId, pipeline), audioReady: true };
      }
      // Deadline anchors on execution start, NOT meeting end: a retried or
      // orphan-recovered finalize can run hours after endedAt, and its upload
      // starts right after that finalize's 202 — an endedAt anchor would time
      // out on the first poll in exactly those recovery cases. Recorded on
      // timeout, never a silent skip of a consented re-ASR (doc §2-P3).
      // NaN-safe: an unparsable anchor times out instead of looping for 5 h.
      const anchor = Date.parse(event.executionStartTime ?? "");
      if (!(Date.now() - anchor <= AUDIO_WAIT_TIMEOUT_SEC * 1000)) {
        pipeline.audioTimeout = true;
        await updateMeeting(tenantId, meetingId, { pipeline });
        return { ...result(meetingId, pipeline), audioTimedOut: true };
      }
      return result(meetingId, pipeline);
    }

    case "batchAsr": {
      const jobName = batchJobName(
        tenantId,
        meetingId,
        pipeline.attempts,
        event.executionArn,
      );
      const startedAt = new Date().toISOString();
      // Token record first: a short file could complete (and fire the
      // EventBridge event) before a post-start write landed.
      await putBatchJobToken({
        jobName,
        taskToken: event.taskToken!,
        tenantId,
        meetingId,
        startedAt,
      });
      await startBatchTranscription({
        jobName,
        mediaKey: audioKey(tenantId, meetingId, "tab"),
        outputKey: batchTranscriptKey(tenantId, meetingId),
      });
      pipeline.batch = { jobName, taskToken: event.taskToken!, startedAt };
      await updateMeeting(tenantId, meetingId, { pipeline });
      // The state is .waitForTaskToken: this return does NOT complete it — the
      // callback Lambda's SendTaskSuccess/Failure does, on the job-state event.
      return result(meetingId, pipeline);
    }

    case "mergeBatch": {
      const payload = await getRawPayload(tenantId, meetingId);
      const batchSegments = parseBatchTranscript(
        await getBatchTranscriptJson(tenantId, meetingId),
      );
      const merged = mergeBatchTranscript(payload.segments, batchSegments);
      await putMergedTranscript(tenantId, meetingId, merged);

      // P2 re-runs over the merged text (order/length preserved → identical
      // segIds): batch emits its own segmentation, so without re-anchoring the
      // quality pass would regress speaker attribution (doc §2-P3).
      const { segments: labeled, scores } = correlateSpeakersV2({
        segments: merged.segments,
        speakerTimeline: payload.speakerTimeline,
        captionTimeline: payload.captionTimeline,
        localUserName: payload.localUserName,
      });
      await putTranscript(tenantId, meetingId, labeled);
      await putLabeledTranscript(tenantId, meetingId, labeled);
      const participants = [
        ...new Set(labeled.filter((s) => s.resolved).map((s) => s.speaker)),
      ].map((name) => ({ name }));

      pipeline.phase = "CORRELATED";
      pipeline.asrSource = "batch-merged";
      pipeline.scores.correlation = scores;
      // Gate C downstream must read the merged text's quality, not the
      // streaming stats the batch pass just replaced.
      pipeline.scores.asr = asrScores({ ...payload, segments: merged.segments });
      recordGate(pipeline, "gateA", ...gateAEval(scores));
      await updateMeeting(tenantId, meetingId, { pipeline, participants });
      return result(meetingId, pipeline);
    }

    case "clean":
      return llmPhase(async () => {
        const [labeled, rawPayload] = await Promise.all([
          getLabeledTranscript(tenantId, meetingId),
          getRawPayload(tenantId, meetingId),
        ]);
        const gateAFired =
          pipeline.scores.gates?.some((g) => g.gate === "gateA" && g.fired) ??
          false;
        const repairSegIds = gateAFired
          ? labeled
              .filter(
                (s) =>
                  s.source !== "mic" &&
                  (s.labelSource === "unresolved" ||
                    s.labelMargin < GATE_A_MIN_LABEL_MARGIN),
              )
              .map((s) => s.segId)
          : undefined;
        const participantNames = meeting.participants.map((p) => p.name);

        let draft = await generateCleanTranscript({
          tier: event.modelTier ?? "haiku",
          segments: labeled,
          repairSegIds,
          participantNames,
        });
        let clean = buildCleanTranscript(draft, labeled);
        let audit = auditClean(clean, labeled);

        if (audit.violations.length) {
          draft = await generateCleanTranscript({
            tier: event.modelTier ?? "haiku",
            segments: labeled,
            repairSegIds,
            participantNames,
            correctionNote: describeViolations(audit.violations),
          });
          clean = buildCleanTranscript(draft, labeled);
          audit = auditClean(clean, labeled);
        }

        // Second mismatch: the affected turns fall back to raw-grounded text,
        // so a P4 rewrite error can never be laundered past verification.
        let groundedOn: "clean" | "raw" = "clean";
        if (audit.violations.length) {
          substituteRawTurns(clean, audit.violations, labeled);
          groundedOn = "raw";
        }
        applyHighlightTaps(clean, rawPayload.highlights);
        pipeline.scores.invariants = {
          numberMismatches: audit.numberMismatches,
          negationMismatches: audit.negationMismatches,
          groundedOn,
        };

        recordGate(
          pipeline,
          "gateC",
          ...gateCEval(pipeline.scores.asr, draft),
        );

        await putCleanTranscript(tenantId, meetingId, clean);
        pipeline.phase = "CLEANED";
        stampTier(pipeline, "CLEANED", event.modelTier ?? "haiku");
        await updateMeeting(tenantId, meetingId, { pipeline });
        return result(meetingId, pipeline);
      });

    case "extract":
      return llmPhase(async () => {
        const [clean, labeled] = await Promise.all([
          getCleanTranscript(tenantId, meetingId),
          getLabeledTranscript(tenantId, meetingId),
        ]);
        const raw = await generateExtraction(cleanTranscriptContext(clean));

        // Gate D ($0): every quote must fuzzily exist in the clean transcript,
        // falling back to raw so a P4 rewrite can't launder a quote away.
        const rawTurns = labeled.map((s) => ({ id: s.segId, text: s.text }));
        let dropped = 0;
        const validated = <T extends ExtractedItem>(items: T[]): T[] =>
          items.flatMap((item) => {
            const hit =
              findQuote(item.verbatimQuote, clean.turns) ??
              findQuote(item.verbatimQuote, rawTurns);
            if (!hit) {
              dropped++;
              return [];
            }
            return [{ ...item, turnId: hit.turnId }];
          });

        const extraction: ExtractionResult = {
          decisions: validated(raw.decisions),
          actionItems: validated<ExtractedActionItem>(raw.actionItems),
          openQuestions: validated(raw.openQuestions),
          keyNumbers: validated(raw.keyNumbers),
          participants: [...new Set(raw.participants)],
        };
        recordGate(
          pipeline,
          "gateD",
          dropped > 0,
          dropped > 0 ? `${dropped} item(s) dropped: quote not found` : undefined,
        );

        await putExtraction(tenantId, meetingId, extraction);
        pipeline.phase = "EXTRACTED";
        stampTier(pipeline, "EXTRACTED", "haiku");
        await updateMeeting(tenantId, meetingId, { pipeline });
        return result(meetingId, pipeline);
      });

    case "synthesize":
      return llmPhase(async () => {
        const [clean, extraction] = await Promise.all([
          getCleanTranscript(tenantId, meetingId),
          getExtraction(tenantId, meetingId),
        ]);
        // The SFN Gate C hint only sees meanConfidence; the recorded gateC
        // decision also covers p10, caption WER and the P4 self-report, so the
        // worker may out-escalate a haiku hint — never downgrade a higher one.
        const hinted = event.modelTier ?? "haiku";
        const tier =
          hinted === "haiku" && gateCFired(pipeline) ? "sonnet" : hinted;
        const text = await generateSummary({
          tier,
          context: cleanTranscriptContext(clean),
          extraction,
          chapters: clean.chapters,
          validTurnIds: new Set(clean.turns.map((t) => t.id)),
        });
        const artifact: SummaryArtifact = {
          text,
          anchoredTurnIds: parseTurnAnchors(text),
          tier,
        };
        await putSummaryDraft(tenantId, meetingId, artifact);
        pipeline.phase = "DRAFTED";
        if (TIER_RANK[tier] > TIER_RANK[pipeline.tier]) pipeline.tier = tier;
        stampTier(pipeline, "DRAFTED", tier);
        await updateMeeting(tenantId, meetingId, { pipeline });
        return result(meetingId, pipeline);
      });

    case "verify":
      return llmPhase(async () => {
        const [clean, labeled, draft, extraction] = await Promise.all([
          getCleanTranscript(tenantId, meetingId),
          getLabeledTranscript(tenantId, meetingId),
          getSummaryDraft(tenantId, meetingId),
          getExtraction(tenantId, meetingId),
        ]);
        const context = cleanTranscriptContext(clean);
        const proposed = await generateVerification(context, draft.text);

        // Programmatic first ($0): quotes are re-validated with the fuzzy
        // matcher (clean, then raw); only ambiguous claims get a second LLM pass.
        const rawTurns = labeled.map((s) => ({ id: s.segId, text: s.text }));
        const locate = (quote: string) =>
          findQuote(quote, clean.turns) ?? findQuote(quote, rawTurns);

        const claims: VerifiedClaim[] = [];
        const ambiguous: VerifiedClaim[] = [];
        for (const c of proposed) {
          if (c.verdict === "UNSUPPORTED") {
            claims.push(unsupported(c));
            continue;
          }
          // A non-UNSUPPORTED verdict without a locatable quote is model
          // self-certification — it must earn its quote in the rejudge pass
          // or be demoted, never counted as supported.
          if (!c.quote) {
            ambiguous.push(c);
            continue;
          }
          const hit = locate(c.quote);
          if (hit) claims.push({ ...c, turnId: hit.turnId });
          else ambiguous.push(c);
        }
        if (ambiguous.length) {
          const rejudged = await rejudgeClaims(
            context,
            ambiguous.map((c) => c.claim),
          );
          ambiguous.forEach((orig, i) => {
            const re = rejudged[i];
            if (!re || re.verdict === "UNSUPPORTED" || !re.quote) {
              claims.push(unsupported(orig));
              return;
            }
            const hit = locate(re.quote);
            claims.push(
              hit ? { ...orig, ...re, turnId: hit.turnId } : unsupported(orig),
            );
          });
        }

        // Critical floor: claims grounded on turns that carry keyNumbers,
        // action items or decisions are critical even if the model said no.
        const criticalTurnIds = new Set(
          [
            ...extraction.keyNumbers,
            ...extraction.actionItems,
            ...extraction.decisions,
          ].map((i) => i.turnId),
        );
        for (const c of claims) {
          if (c.turnId && criticalTurnIds.has(c.turnId)) c.critical = true;
        }

        const tally = (v: VerifiedClaim["verdict"]) =>
          claims.filter((c) => c.verdict === v).length;
        const unsupportedCount = tally("UNSUPPORTED");
        const criticalUnsupported = claims.filter(
          (c) => c.critical && c.verdict === "UNSUPPORTED",
        ).length;
        const scores = {
          claims: claims.length,
          supported: tally("SUPPORTED"),
          partial: tally("PARTIAL"),
          unsupported: unsupportedCount,
          uncertain: tally("UNCERTAIN"),
          unsupportedRate: claims.length ? unsupportedCount / claims.length : 0,
          criticalUnsupported,
        };
        const report: VerificationReport = {
          claims,
          scores,
          groundedOn: pipeline.scores.invariants?.groundedOn ?? "clean",
        };
        await putVerification(tenantId, meetingId, report);
        pipeline.scores.verification = scores;
        pipeline.phase = "VERIFIED";
        stampTier(pipeline, "VERIFIED", "haiku");

        const { action, escalateTier, reason } = gateEEval(
          pipeline,
          criticalUnsupported,
          scores.unsupportedRate,
          unsupportedCount,
          draft.tier,
        );
        recordGate(pipeline, "gateE", unsupportedCount > 0, reason);
        await updateMeeting(tenantId, meetingId, { pipeline });
        return {
          ...result(meetingId, pipeline),
          gateEAction: action,
          ...(escalateTier ? { escalateTier } : {}),
        };
      });

    case "repair":
      return llmPhase(async () => {
        const [clean, draft, verification] = await Promise.all([
          getCleanTranscript(tenantId, meetingId),
          getSummaryDraft(tenantId, meetingId),
          getVerification(tenantId, meetingId),
        ]);
        const tier = event.modelTier ?? draft.tier;
        const text = await repairSummary({
          tier,
          context: cleanTranscriptContext(clean),
          summaryMarkdown: draft.text,
          failedClaims: verification.claims.filter(
            (c) => c.verdict === "UNSUPPORTED",
          ),
          validTurnIds: new Set(clean.turns.map((t) => t.id)),
        });
        const artifact: SummaryArtifact = {
          text,
          anchoredTurnIds: parseTurnAnchors(text),
          tier,
        };
        await putSummaryDraft(tenantId, meetingId, artifact);
        pipeline.phase = "DRAFTED";
        stampTier(pipeline, "DRAFTED", tier);
        await updateMeeting(tenantId, meetingId, { pipeline });
        return result(meetingId, pipeline);
      });

    case "publish": {
      const [draft, extraction, verification] = await Promise.all([
        getSummaryDraft(tenantId, meetingId),
        getExtraction(tenantId, meetingId),
        getVerification(tenantId, meetingId),
      ]);
      await putSummaryArtifact(tenantId, meetingId, draft);

      const v = verification.scores;
      const criticalUnsupported = verification.claims.some(
        (c) => c.critical && c.verdict === "UNSUPPORTED",
      );
      // "ready" means fully verified: any residual unsupported claim (repair
      // that didn't ground, exhausted ladder) publishes with review flags.
      const ready = v.unsupported === 0;
      pipeline.phase = "PUBLISHED";
      if (ready) {
        delete pipeline.lastError;
      } else {
        pipeline.lastError = `verification: ${v.unsupported}/${v.claims} claims unsupported (rate ${v.unsupportedRate.toFixed(2)})${criticalUnsupported ? ", critical field affected" : ""}`;
      }
      const status: MeetingStatus = ready ? "ready" : "needs_review";
      // The consumed declaration is cleared with the audio (§7): a later
      // reprocess must not re-fire Gate B and poll for objects deliberately
      // deleted below.
      await updateMeeting(tenantId, meetingId, {
        pipeline,
        summary: toMeetingSummary(draft, extraction),
        status,
        ...(ready && meeting.audioPending ? { audioPending: undefined } : {}),
      });
      // §7 Tier 2: audio is deleted the moment a verified transcript exists;
      // needs_review keeps it (a reprocess may still want the Gate B pass)
      // under the 7-day lifecycle hard cap.
      if (ready && meeting.audioPending) {
        await deleteAudioObjects(tenantId, meetingId);
      }
      await emitPublishMetrics(pipeline, !ready);
      return result(meetingId, pipeline, status);
    }

    case "fail": {
      // An llmPhase already published needs_review with a useful lastError; a
      // downstream crash on the missing artifact must not make that terminal.
      if (meeting.status === "needs_review") {
        return result(meetingId, pipeline, "needs_review");
      }
      pipeline.lastError =
        event.error?.Cause || event.error?.Error || "pipeline execution failed";
      await updateMeeting(tenantId, meetingId, { pipeline, status: "failed" });
      return result(meetingId, pipeline, "failed");
    }
  }
};

function result(
  meetingId: string,
  pipeline: PipelineState,
  status?: MeetingStatus,
): PipelineWorkerResult {
  return { meetingId, phase: pipeline.phase, scores: pipeline.scores, status };
}

// ---------------------------------------------------------------------------
// Gates — code, not model judgment (§1 principle 1).
// ---------------------------------------------------------------------------

function recordGate(
  pipeline: PipelineState,
  gate: GateId,
  fired: boolean,
  reason?: string,
): void {
  (pipeline.scores.gates ??= []).push({
    gate,
    fired,
    decidedAt: new Date().toISOString(),
    ...(reason ? { reason } : {}),
  });
}

function gateAEval(scores: CorrelationScores): [boolean, string?] {
  if (scores.unresolvedPct > GATE_A_MAX_UNRESOLVED_PCT) {
    return [
      true,
      `unresolvedPct ${scores.unresolvedPct.toFixed(1)} > ${GATE_A_MAX_UNRESOLVED_PCT}`,
    ];
  }
  if (scores.labelMarginMin < GATE_A_MIN_LABEL_MARGIN) {
    return [
      true,
      `labelMarginMin ${scores.labelMarginMin.toFixed(2)} < ${GATE_A_MIN_LABEL_MARGIN}`,
    ];
  }
  if (
    scores.captionAgreementPct !== undefined &&
    scores.captionAgreementPct < GATE_A_MIN_CAPTION_AGREEMENT_PCT
  ) {
    return [
      true,
      `captionAgreementPct ${scores.captionAgreementPct.toFixed(1)} < ${GATE_A_MIN_CAPTION_AGREEMENT_PCT}`,
    ];
  }
  return [false];
}

/**
 * Gate B (batch re-ASR): hard-gated on §7 consent — without Tier 2 and a
 * declared tab upload there is no audio to re-transcribe, whatever the stats
 * say. Confidence-free tab segments score 0 and fire the gate: when consented
 * audio exists, "no signal" upgrades conservatively (a dead tab stream is the
 * strongest case for the batch pass, not a reason to skip it).
 */
function gateBEval(meeting: Meeting, scores: GateBScores): [boolean, string?] {
  if (meeting.audioConsent?.tier !== 2) {
    return [false, "no upload consent (tier < 2): re-ASR unavailable"];
  }
  if (!meeting.audioPending?.sources.includes("tab")) {
    return [false, "no tab audio declared at finalize"];
  }
  if (scores.flaggedImportant) return [true, "meeting flagged important"];
  if (scores.tabMeanConfidence < GATE_B_MIN_TAB_MEAN_CONFIDENCE) {
    return [
      true,
      `tabMeanConfidence ${scores.tabMeanConfidence.toFixed(2)} < ${GATE_B_MIN_TAB_MEAN_CONFIDENCE}`,
    ];
  }
  if (scores.tabP10Confidence < GATE_B_MIN_TAB_P10_CONFIDENCE) {
    return [
      true,
      `tabP10Confidence ${scores.tabP10Confidence.toFixed(2)} < ${GATE_B_MIN_TAB_P10_CONFIDENCE}`,
    ];
  }
  return [false];
}

/**
 * Gate C is driven by the programmatic P3 scores; the P4 self-report may only
 * OR-escalate, never satisfy the gate. Missing scores (legacy payloads,
 * captions mode) default conservative.
 */
function gateCEval(
  asr: AsrScores | undefined,
  draft: CleanDraft,
): [boolean, string?] {
  if (!asr) return [true, "no asr scores: conservative tier"];
  if (asr.meanConfidence < GATE_C_MIN_MEAN_CONFIDENCE) {
    return [
      true,
      `meanConfidence ${asr.meanConfidence.toFixed(2)} < ${GATE_C_MIN_MEAN_CONFIDENCE}`,
    ];
  }
  if (asr.p10Confidence < GATE_C_MIN_P10_CONFIDENCE) {
    return [
      true,
      `p10Confidence ${asr.p10Confidence.toFixed(2)} < ${GATE_C_MIN_P10_CONFIDENCE}`,
    ];
  }
  if (
    asr.captionWerProxy !== undefined &&
    asr.captionWerProxy > GATE_C_MAX_CAPTION_WER
  ) {
    return [
      true,
      `captionWerProxy ${asr.captionWerProxy.toFixed(2)} > ${GATE_C_MAX_CAPTION_WER}`,
    ];
  }
  if (draft.qualityScore < GATE_C_MIN_SELF_QUALITY) {
    return [true, `self-report qualityScore ${draft.qualityScore.toFixed(2)}`];
  }
  if (draft.garbledPct > GATE_C_MAX_GARBLED_PCT) {
    return [true, `self-report garbledPct ${draft.garbledPct.toFixed(1)}`];
  }
  return [false];
}

function gateCFired(pipeline: PipelineState): boolean {
  const decisions = (pipeline.scores.gates ?? []).filter(
    (g) => g.gate === "gateC",
  );
  const last = decisions[decisions.length - 1];
  // No recorded decision (reprocess from a later phase): conservative.
  return last ? last.fired : true;
}

/**
 * Gate E ladder (rate-based + critical-field floor):
 * 0 unsupported → publish; acceptable rate → one targeted repair, then publish;
 * otherwise escalate haiku → sonnet → opus; exhausted → publish (needs_review).
 */
function gateEEval(
  pipeline: PipelineState,
  criticalUnsupported: number,
  unsupportedRate: number,
  unsupportedCount: number,
  draftTier: ModelTier,
): {
  action: "publish" | "repair" | "synthesize";
  escalateTier?: ModelTier;
  reason: string;
} {
  if (unsupportedCount === 0) return { action: "publish", reason: "0 unsupported" };

  const rate = `unsupportedRate ${unsupportedRate.toFixed(2)}`;
  const priorEvals = (pipeline.scores.gates ?? []).filter(
    (g) => g.gate === "gateE",
  ).length;

  if (
    unsupportedRate <= GATE_E_MAX_UNSUPPORTED_RATE &&
    criticalUnsupported === 0
  ) {
    return priorEvals === 0
      ? { action: "repair", reason: `${rate} ≤ ${GATE_E_MAX_UNSUPPORTED_RATE}, no critical: targeted repair` }
      : { action: "publish", reason: `${rate}, no critical: acceptable residual` };
  }
  const trigger =
    criticalUnsupported > 0
      ? `${criticalUnsupported} critical claim(s) unsupported`
      : `${rate} > ${GATE_E_MAX_UNSUPPORTED_RATE}`;
  if (draftTier === "haiku") {
    return { action: "synthesize", escalateTier: "sonnet", reason: `${trigger}: escalate to sonnet` };
  }
  if (draftTier === "sonnet") {
    return { action: "synthesize", escalateTier: "opus", reason: `${trigger}: escalate to opus` };
  }
  return { action: "publish", reason: `${trigger}: ladder exhausted, publish needs_review` };
}

function stampTier(
  pipeline: PipelineState,
  phase: PipelinePhase,
  tier: ModelTier,
): void {
  (pipeline.scores.tierByPhase ??= {})[phase] = tier;
}

// ---------------------------------------------------------------------------
// P3 — programmatic ASR scoring.
// ---------------------------------------------------------------------------

function asrScores(payload: MeetingIngestPayload): AsrScores {
  const confs = payload.segments
    .map((s) => s.confidence)
    .filter((c): c is number => c !== undefined)
    .sort((a, b) => a - b);
  // No confidence data (legacy payload / captions mode): score 0 so Gate C
  // defaults conservative rather than optimistic.
  const base: AsrScores =
    confs.length === 0
      ? { meanConfidence: 0, p10Confidence: 0 }
      : {
          meanConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
          p10Confidence: confs[Math.floor(0.1 * (confs.length - 1))]!,
        };
  const wer = captionWerProxy(payload);
  return wer === undefined ? base : { ...base, captionWerProxy: wer };
}

function gateBScores(payload: MeetingIngestPayload): GateBScores {
  const tab = payload.segments.filter((s) => s.source === "tab");
  const confs = tab
    .map((s) => s.confidence)
    .filter((c): c is number => c !== undefined)
    .sort((a, b) => a - b);
  if (confs.length === 0) {
    return { tabMeanConfidence: 0, tabP10Confidence: 0, tabSegmentCount: tab.length };
  }
  return {
    tabMeanConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
    tabP10Confidence: confs[Math.floor(0.1 * (confs.length - 1))]!,
    tabSegmentCount: tab.length,
  };
}

/** Token-multiset F1 distance between caption text and tab ASR text — the free
 * second opinion on ASR quality (a rough WER stand-in, not aligned WER). */
function captionWerProxy(payload: MeetingIngestPayload): number | undefined {
  const captions = (payload.captionTimeline ?? []).filter((c) => c.final);
  if (!captions.length) return undefined;
  const capTokens = tokenize(captions.map((c) => c.text).join(" "));
  // Captions cover ALL speakers (local user included) while tab audio excludes
  // the local mic — compare against every segment so both sides cover the same
  // speaker population.
  const asrTokens = tokenize(payload.segments.map((s) => s.text).join(" "));
  if (!capTokens.length || !asrTokens.length) return undefined;
  const counts = new Map<string, number>();
  for (const t of capTokens) counts.set(t, (counts.get(t) ?? 0) + 1);
  let overlap = 0;
  for (const t of asrTokens) {
    const left = counts.get(t) ?? 0;
    if (left > 0) {
      counts.set(t, left - 1);
      overlap++;
    }
  }
  return 1 - (2 * overlap) / (capTokens.length + asrTokens.length);
}

// ---------------------------------------------------------------------------
// P4 — clean-transcript assembly + programmatic invariant gate.
// ---------------------------------------------------------------------------

/**
 * Ids and times are assigned programmatically — never trusted from the model:
 * turns sort chronologically, ids are `T{n}` in that order (the [Tn] anchor IS
 * the id), and any segment the model dropped is re-inserted as its own raw
 * turn so cleanup can never lose content.
 */
function buildCleanTranscript(
  draft: CleanDraft,
  segments: CorrelatedSegment[],
): CleanTranscript {
  const byId = new Map(segments.map((s) => [s.segId, s]));
  const used = new Set<string>();
  const proto: Omit<CleanTurn, "id">[] = [];

  for (const t of draft.turns) {
    const sourceIds = t.sourceIds.filter((id) => byId.has(id) && !used.has(id));
    if (!sourceIds.length) continue;
    sourceIds.forEach((id) => used.add(id));
    const sources = sourceIds.map((id) => byId.get(id)!);
    proto.push({
      sourceIds,
      speaker: t.speaker,
      text: t.text,
      startTime: Math.min(...sources.map((s) => s.startTime)),
      endTime: Math.max(...sources.map((s) => s.endTime)),
      tags: [],
    });
  }
  for (const seg of segments) {
    if (used.has(seg.segId)) continue;
    proto.push({
      sourceIds: [seg.segId],
      speaker: seg.speaker,
      text: seg.text,
      startTime: seg.startTime,
      endTime: seg.endTime,
      tags: ["raw-fallback"],
    });
  }
  proto.sort((a, b) => a.startTime - b.startTime);

  return {
    turns: proto.map((t, i) => ({ id: `T${i + 1}`, ...t })),
    chapters: [...draft.chapters].sort((a, b) => a.startTime - b.startTime),
  };
}

/**
 * Widget taps carry no turn reference — only a capture-clock timestamp — so
 * each anchors to the turn spanning `t`, falling back to the latest turn that
 * started before it (taps usually land moments after the highlighted speech).
 */
function applyHighlightTaps(
  clean: CleanTranscript,
  taps?: HighlightTap[],
): void {
  if (!taps?.length) return;
  for (const tap of taps) {
    let turn: CleanTurn | undefined;
    for (const t of clean.turns) {
      if (t.startTime > tap.t) break;
      turn = t;
    }
    turn ??= clean.turns[0];
    if (turn && !turn.tags.includes(tap.tag)) turn.tags.push(tap.tag);
  }
}

interface CleanViolation {
  turn: CleanTurn;
  audit: TurnAudit;
}

function auditClean(
  clean: CleanTranscript,
  segments: CorrelatedSegment[],
): {
  violations: CleanViolation[];
  numberMismatches: number;
  negationMismatches: number;
} {
  const byId = new Map(segments.map((s) => [s.segId, s]));
  const violations: CleanViolation[] = [];
  let numberMismatches = 0;
  let negationMismatches = 0;
  for (const turn of clean.turns) {
    const rawText = turn.sourceIds.map((id) => byId.get(id)!.text).join(" ");
    const audit = auditTurnInvariants(rawText, turn.text);
    if (hasViolations(audit)) {
      numberMismatches +=
        audit.missingNumbers.length + audit.introducedNumbers.length;
      negationMismatches += audit.negationFlips.length;
      violations.push({ turn, audit });
    }
  }
  return { violations, numberMismatches, negationMismatches };
}

function describeViolations(violations: CleanViolation[]): string {
  return violations
    .map(({ turn, audit }) => {
      const parts: string[] = [];
      if (audit.missingNumbers.length) {
        parts.push(`numbers lost: ${audit.missingNumbers.join(", ")}`);
      }
      if (audit.introducedNumbers.length) {
        parts.push(`numbers introduced: ${audit.introducedNumbers.join(", ")}`);
      }
      if (audit.negationFlips.length) {
        parts.push(`negations changed: ${audit.negationFlips.join(", ")}`);
      }
      return `- segments ${turn.sourceIds.join(", ")}: ${parts.join("; ")}`;
    })
    .join("\n");
}

function substituteRawTurns(
  clean: CleanTranscript,
  violations: CleanViolation[],
  segments: CorrelatedSegment[],
): void {
  const byId = new Map(segments.map((s) => [s.segId, s]));
  for (const { turn } of violations) {
    turn.text = turn.sourceIds.map((id) => byId.get(id)!.text).join(" ");
    if (!turn.tags.includes("raw-grounded")) turn.tags.push("raw-grounded");
  }
}

// ---------------------------------------------------------------------------
// P7/P8 helpers.
// ---------------------------------------------------------------------------

/** Contract: quote/turnId are absent on UNSUPPORTED. */
function unsupported(c: VerifiedClaim): VerifiedClaim {
  return { claim: c.claim, verdict: "UNSUPPORTED", critical: c.critical };
}

/**
 * The dashboard keeps reading the old `summary` attribute from the meeting
 * item (unchanged contract); the full artifacts live in S3.
 */
function toMeetingSummary(
  draft: SummaryArtifact,
  extraction: ExtractionResult,
): MeetingSummary {
  const firstParagraph = draft.text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .find((p) => p && !p.startsWith("#"));
  return {
    summary: firstParagraph ?? draft.text.trim(),
    keyPoints: [...extraction.decisions, ...extraction.keyNumbers].map(
      (i) => i.text,
    ),
    actionItems: extraction.actionItems.map((i) => ({
      text: i.text,
      ...(i.owner ? { owner: i.owner } : {}),
    })),
  };
}
