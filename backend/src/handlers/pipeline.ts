import type {
  AsrScores,
  CorrelationScores,
  DiarizedSegment,
  LabeledSegment,
  MeetingStatus,
  ModelTier,
  PipelinePhase,
  PipelineScores,
  PipelineState,
  SpeakerTimelineEntry,
} from "@teams-agent-core/shared";
import { correlateSpeakers } from "@teams-agent-core/shared";
import {
  getMeetingItem,
  getRawPayload,
  getTranscript,
  putTranscript,
  updateMeeting,
} from "../lib/store.js";
import { summarizeMeeting } from "../lib/agent.js";

/**
 * Single pipeline worker — every state in the MeetingPipeline state machine
 * invokes this Lambda with a phase discriminator. M3 adds "clean", "extract",
 * "synthesize" and "verify" as new switch cases; the dispatch shape is final.
 */
export type PipelineWorkerPhase = "correlate" | "asrScore" | "publish" | "fail";

export interface PipelineWorkerEvent {
  tenantId: string;
  meetingId: string;
  executionArn: string;
  phase: PipelineWorkerPhase;
  modelTier?: ModelTier;
  /** SFN Catch payload; present only on `fail`. */
  error?: { Error?: string; Cause?: string };
}

/** Flat result so SFN Choice states can read gate scores directly. */
export interface PipelineWorkerResult {
  meetingId: string;
  phase: PipelinePhase;
  scores: PipelineScores;
  status?: MeetingStatus;
}

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

  switch (event.phase) {
    case "correlate": {
      const payload = await getRawPayload(tenantId, meetingId);
      const labeled = correlateSpeakers(
        payload.segments,
        payload.speakerTimeline,
        payload.localUserName,
      );
      await putTranscript(tenantId, meetingId, labeled);
      const participants = [
        ...new Set(labeled.filter((s) => s.resolved).map((s) => s.speaker)),
      ].map((name) => ({ name }));
      pipeline.phase = "CORRELATED";
      pipeline.scores.correlation = correlationScores(
        payload.segments,
        payload.speakerTimeline,
        labeled,
      );
      await updateMeeting(tenantId, meetingId, { pipeline, participants });
      return result(meetingId, pipeline);
    }

    case "asrScore": {
      const payload = await getRawPayload(tenantId, meetingId);
      pipeline.phase = "ASR_SCORED";
      pipeline.scores.asr = asrScores(payload.segments);
      await updateMeeting(tenantId, meetingId, { pipeline });
      return result(meetingId, pipeline);
    }

    // M3: "clean" (P4), "extract" (P5), "synthesize" (P6), "verify" (P7).

    case "publish": {
      const segments = await getTranscript(tenantId, meetingId);
      try {
        const summary = await summarizeMeeting(segments);
        pipeline.phase = "PUBLISHED";
        delete pipeline.lastError;
        await updateMeeting(tenantId, meetingId, {
          pipeline,
          summary,
          status: "ready",
        });
        return result(meetingId, pipeline, "ready");
      } catch (err) {
        // Service errors propagate to the SFN Retry/Catch; only a parse failure
        // publishes as needs_review — never terminal "failed" for parse issues.
        if (!(err instanceof SyntaxError)) throw err;
        pipeline.phase = "PUBLISHED";
        pipeline.lastError = `summary parse failed: ${String(err)}`;
        await updateMeeting(tenantId, meetingId, {
          pipeline,
          status: "needs_review",
        });
        return result(meetingId, pipeline, "needs_review");
      }
    }

    case "fail": {
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

function correlationScores(
  segments: DiarizedSegment[],
  timeline: SpeakerTimelineEntry[],
  labeled: LabeledSegment[],
): CorrelationScores {
  const unresolvedPct = labeled.length
    ? (labeled.filter((s) => !s.resolved).length / labeled.length) * 100
    : 0;
  return {
    labelMarginMin: labelMarginMin(segments, timeline),
    unresolvedPct,
  };
}

/**
 * Mirrors the vote tally inside `correlateSpeakers`, which does not expose it.
 * Duplicated here until correlation v2 (M4) emits numeric confidence itself.
 */
function labelMarginMin(
  segments: DiarizedSegment[],
  timeline: SpeakerTimelineEntry[],
): number {
  const sorted = [...timeline].sort((a, b) => a.t - b.t);
  const intervals: { start: number; end: number; name: string }[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (next.t > cur.t) {
      intervals.push({ start: cur.t, end: next.t, name: cur.participantName });
    }
  }

  const tallies = new Map<string, Map<string, number>>();
  for (const seg of segments) {
    if (seg.source === "mic") continue;
    const tally = tallies.get(seg.speakerLabel) ?? new Map<string, number>();
    for (const iv of intervals) {
      const lo = Math.max(seg.startTime, iv.start);
      const hi = Math.min(seg.endTime, iv.end);
      if (hi > lo) tally.set(iv.name, (tally.get(iv.name) ?? 0) + (hi - lo));
    }
    tallies.set(seg.speakerLabel, tally);
  }

  // No tab labels at all → nothing to disambiguate → perfect margin.
  let min = 1;
  for (const tally of tallies.values()) {
    const votes = [...tally.values()].sort((a, b) => b - a);
    const total = votes.reduce((a, b) => a + b, 0);
    const margin = total ? ((votes[0] ?? 0) - (votes[1] ?? 0)) / total : 0;
    min = Math.min(min, margin);
  }
  return min;
}

function asrScores(segments: DiarizedSegment[]): AsrScores {
  const confs = segments
    .map((s) => s.confidence)
    .filter((c): c is number => c !== undefined)
    .sort((a, b) => a - b);
  // No confidence data (legacy payload / captions mode): score 0 so Gate C
  // defaults conservative rather than optimistic.
  if (confs.length === 0) return { meanConfidence: 0, p10Confidence: 0 };
  return {
    meanConfidence: confs.reduce((a, b) => a + b, 0) / confs.length,
    p10Confidence: confs[Math.floor(0.1 * (confs.length - 1))]!,
  };
}
