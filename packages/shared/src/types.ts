/**
 * Core domain types shared across extension, backend, infra and web.
 * Times inside a meeting (segment/timeline) are seconds relative to capture start.
 * Wall-clock timestamps are ISO-8601 UTC strings.
 */

export interface Tenant {
  tenantId: string;
  name: string;
}

export interface MeetingParticipant {
  /** Display name as read from the Teams roster / active-speaker DOM. */
  name: string;
}

export interface Meeting {
  tenantId: string;
  meetingId: string;
  /** Client-minted idempotency key for the start call; absent on legacy records. */
  captureId?: string;
  title: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  /** ISO-8601 UTC; absent while the meeting is still in progress. */
  endedAt?: string;
  participants: MeetingParticipant[];
  status: MeetingStatus;
  /** Async-pipeline progress; absent on legacy records and while `capturing`. */
  pipeline?: PipelineState;
  /** Per-meeting audio consent (§7); absent = tier 0 (no recording anywhere). */
  audioConsent?: AudioConsent;
  /** Audio declared at finalize but possibly still uploading — Gate B's poll target. */
  audioPending?: AudioPendingDeclaration;
}

// ---------------------------------------------------------------------------
// Privacy consent ladder (§7) + opt-in audio upload (M5).
// ---------------------------------------------------------------------------

/**
 * Per-meeting audio consent: 0 = no recording anywhere (Gate B can never fire),
 * 1 = local OPFS buffer only, 2 = explicit upload consent (enables batch re-ASR).
 */
export type ConsentTier = 0 | 1 | 2;

/** Consent record stored on the meeting item. */
export interface AudioConsent {
  tier: ConsentTier;
  /** ISO-8601 UTC. */
  grantedAt: string;
}

/** MediaRecorder Opus in WebM — the only capture container today. */
export type AudioUploadFormat = "webm-opus";

/**
 * Declared at finalize under consent Tier 2: which recorded sources the extension
 * will upload. Gate B's bounded Wait/HeadObject poll loop waits on exactly these
 * declared sources — never an opportunistic S3 check (the upload races the pipeline).
 */
export interface AudioPendingDeclaration {
  /** Sources to be uploaded; Gate B batch re-ASR only ever consumes "tab". */
  sources: AudioSource[];
  format: AudioUploadFormat;
  /** Recorded duration in seconds — sizes the poll timeout and the batch job. */
  durationSec: number;
}

/**
 * Coarse user-facing lifecycle: capturing → processing → ready | needs_review | failed.
 * `needs_review` = published with unresolved verification flags — a valid terminal state.
 * Fine-grained progress lives in `PipelineState.phase`.
 */
export type MeetingStatus =
  | "capturing"
  | "processing"
  | "ready"
  | "needs_review"
  | "failed";

/** Which audio source a diarized segment came from. */
export type AudioSource = "tab" | "mic";

/**
 * A raw segment as emitted by Amazon Transcribe streaming (with ShowSpeakerLabel).
 * `speakerLabel` is Transcribe's opaque label (e.g. "spk_0") — NOT a real name yet.
 */
export interface DiarizedSegment {
  source: AudioSource;
  speakerLabel: string;
  /** Seconds from capture start. */
  startTime: number;
  endTime: number;
  text: string;
  /**
   * Average per-word Transcribe confidence, 0–1. Absent on legacy payloads and in
   * captions-primary mode (captions carry no confidence signal).
   */
  confidence?: number;
}

/** A point-in-time reading of who Teams shows as the active speaker. */
export interface SpeakerTimelineEntry {
  /** Seconds from capture start. */
  t: number;
  participantName: string;
}

/**
 * One live-caption utterance scraped from the Teams caption pane (captured
 * on-mutation — Teams virtualizes and prunes old caption nodes).
 */
export interface CaptionEvent {
  /** Seconds from capture start. */
  t: number;
  /** Native per-utterance display name — strictly better than the speaker ring. */
  speakerName: string;
  text: string;
  /** True once Teams finalized the utterance (partials mutate in place). */
  final: boolean;
}

/** A segment after correlating diarization with the active-speaker timeline. */
export interface LabeledSegment {
  /** Resolved real name, or the raw speaker label when correlation was inconclusive. */
  speaker: string;
  /** True when the name came from the active-speaker timeline (vs. raw label fallback). */
  resolved: boolean;
  startTime: number;
  endTime: number;
  text: string;
}

/** Which signal decided a segment's speaker in correlation v2. */
export type SpeakerLabelSource = "mic" | "caption" | "timeline" | "unresolved";

/**
 * P2 v2 output segment (`transcript.labeled.json`): stable id + numeric
 * confidence. Extends LabeledSegment so v1 consumers keep working unchanged.
 */
export interface CorrelatedSegment extends LabeledSegment {
  /** Stable id (`s{n}` in raw-payload order) — survives every downstream rewrite. */
  segId: string;
  source: AudioSource;
  labelSource: SpeakerLabelSource;
  /** 0–1: caption match score / vote share; 1 for mic; 0 when unresolved. */
  speakerConfidence: number;
  /** Winner-vs-runner-up margin of the decision that labeled this segment, 0–1. */
  labelMargin: number;
  /** ASR confidence carried over from the diarized segment when present. */
  asrConfidence?: number;
}

/** Full P2 v2 output: labeled segments plus the Gate A score inputs. */
export interface CorrelationResult {
  segments: CorrelatedSegment[];
  scores: CorrelationScores;
}

/**
 * Health of the free DOM-derived capture signals, measured during capture.
 * Converts silent Teams-DOM selector death into a gate input (captured from M4;
 * the type is part of the finalize contract now).
 */
export interface SignalHealth {
  /** At least one finalized live-caption mutation was observed. */
  captionsSeen: boolean;
  /** At least one active-speaker ring reading was observed. */
  speakerRingSeen: boolean;
  /** Total successful DOM reads (caption mutations + speaker-ring polls). */
  domReadCount: number;
  /** Seconds from capture start of the last caption mutation; absent when none. */
  captionHeartbeatLastT?: number;
  /**
   * Capture-time ASR mode; "rearmed" = the caption-heartbeat watchdog re-armed
   * Transcribe Streaming mid-meeting. Absent on pre-Gate-0 payloads = "streaming".
   */
  asrMode?: AsrCaptureMode;
  /** Watchdog re-arm count; > 0 only when `asrMode` is "rearmed". */
  rearmCount?: number;
  /**
   * The forced cross-check tab stream ran alongside captions (Gate 0). Meetings
   * captured captions-only without it are flagged and Gate C defaults conservative.
   */
  crossCheckActive?: boolean;
}

/**
 * How the extension sourced ASR during capture (Gate 0). Distinct from AsrSource,
 * which records what text the pipeline ended up grounded on.
 */
export type AsrCaptureMode = "streaming" | "captions-primary" | "rearmed";

/** Gate 0 extension flags (per-tenant; default OFF until telemetry proves captions). */
export interface CaptionsPrimaryConfig {
  captionsPrimaryEnabled: boolean;
  /**
   * Fraction of captions-primary meetings (0–1) with the cross-check tab stream
   * forced ON — mandatory until the captions-mode P3 signals are validated.
   */
  crossCheckFraction: number;
}

/** Fine-grained pipeline progress (internal; users see the coarse MeetingStatus). */
export type PipelinePhase =
  | "INGESTED"
  | "CORRELATED"
  | "ASR_SCORED"
  | "CLEANED"
  | "EXTRACTED"
  | "DRAFTED"
  | "VERIFIED"
  | "PUBLISHED";

export type ModelTier = "haiku" | "sonnet" | "opus";

/** Which ASR text the pipeline is grounded on. */
export type AsrSource = "streaming" | "captions" | "both" | "batch-merged";

/** P2 output: per-meeting speaker-correlation quality. */
export interface CorrelationScores {
  /** Minimum winner-vs-runner-up vote margin across labels, 0–1. */
  labelMarginMin: number;
  /** % of segments left with a raw speaker label, 0–100. */
  unresolvedPct: number;
  /** % agreement with caption speaker names, 0–100; absent when captions were off. */
  captionAgreementPct?: number;
}

/** P3 output: programmatic ASR quality (drives Gate C). */
export interface AsrScores {
  /** Mean of per-segment `confidence`, 0–1. */
  meanConfidence: number;
  /** 10th percentile of per-segment `confidence`, 0–1. */
  p10Confidence: number;
  /** Rough WER between caption text and ASR text, 0–1; absent when captions were off. */
  captionWerProxy?: number;
}

/** P4 invariant gate: raw↔clean diff of numbers/names/negations. */
export interface InvariantScores {
  numberMismatches: number;
  negationMismatches: number;
  /** Which transcript P5–P7 ground against after the gate ran. */
  groundedOn: "clean" | "raw";
}

/** P7 output: claim-level verification tallies (drives Gate E). */
export interface VerificationScores {
  claims: number;
  supported: number;
  partial: number;
  unsupported: number;
  /** UNCERTAIN verdicts; Gate E counts them like `partial`, never as unsupported. */
  uncertain?: number;
  /** unsupported / claims, 0–1. */
  unsupportedRate: number;
  /** Claims with critical=true and verdict UNSUPPORTED — the Gate E absolute floor. */
  criticalUnsupported?: number;
}

/** Programmatic escalation gates (§2 of the architecture doc). */
export type GateId = "gate0" | "gateA" | "gateB" | "gateC" | "gateD" | "gateE";

/** One gate evaluation; a gate may re-appear after a repair/re-verify loop. */
export interface GateDecision {
  gate: GateId;
  fired: boolean;
  /** ISO-8601 UTC. */
  decidedAt: string;
  /** Trigger detail, e.g. "unresolvedPct 22.0 > 15". */
  reason?: string;
}

/**
 * Gate B inputs: tab-source confidence stats. Batch re-ASR runs on the tab source
 * only, so the meeting-wide AsrScores (mic included) would mask a bad tab stream.
 */
export interface GateBScores {
  /** Mean per-segment ASR confidence over tab-source segments, 0–1. */
  tabMeanConfidence: number;
  /** 10th percentile over tab-source segments, 0–1. */
  tabP10Confidence: number;
  tabSegmentCount: number;
  /** User flagged the meeting important — OR-trigger alongside the stats. */
  flaggedImportant?: boolean;
}

/** Gate scores accumulate as phases complete — each is absent until its phase ran. */
export interface PipelineScores {
  correlation?: CorrelationScores;
  asr?: AsrScores;
  gateB?: GateBScores;
  invariants?: InvariantScores;
  verification?: VerificationScores;
  /** Gate evaluations in execution order — the per-meeting escalation audit trail. */
  gates?: GateDecision[];
  /** Highest model tier actually used per LLM phase (P4–P8). */
  tierByPhase?: Partial<Record<PipelinePhase, ModelTier>>;
}

/** Gate B task-token lookup: the Transcribe job-state event carries only the job name. */
export interface BatchJobRef {
  jobName: string;
  taskToken: string;
  /** ISO-8601 UTC. */
  startedAt: string;
}

/**
 * jobName-keyed bookkeeping item for the Gate B `.waitForTaskToken` wait: the
 * EventBridge job-state event carries only the job name, so the callback Lambda
 * resolves the token and the owning meeting from this record before SendTaskSuccess.
 */
export interface BatchJobTokenRecord {
  /** `{tenantId}--{meetingId}--{attempt}` — the lookup key. */
  jobName: string;
  taskToken: string;
  tenantId: string;
  meetingId: string;
  /** ISO-8601 UTC. */
  startedAt: string;
}

// ---------------------------------------------------------------------------
// Batch re-ASR (Gate B, M5): Transcribe Batch on the tab source, merged by time,
// then looped back through P2 — batch spk_N labels are never trusted raw.
// ---------------------------------------------------------------------------

/**
 * One diarized segment from the Transcribe Batch pass. Batch emits its own
 * segmentation and its own `spk_N` numbering, unrelated to streaming labels —
 * which is why the merged transcript must re-run P2 before P4.
 */
export interface BatchSegment {
  /** Batch's opaque diarization label (e.g. "spk_0"). */
  speakerLabel: string;
  /** Seconds from capture start. */
  startTime: number;
  endTime: number;
  text: string;
  /** Average per-word confidence, 0–1. */
  confidence: number;
}

/** Which ASR pass a merged segment's text survived from. */
export type SegmentProvenance = "streaming" | "batch";

/**
 * Post-merge segment: batch text preferred where time alignment found a match,
 * P2 `segId` preserved so anchors/edits survive the merge.
 */
export interface MergedSegment extends DiarizedSegment {
  segId: string;
  provenance: SegmentProvenance;
}

/** Merge output — fed back through P2, published with `asrSource: "batch-merged"`. */
export interface BatchMergeResult {
  segments: MergedSegment[];
  /** Fraction of segments whose text came from the batch pass, 0–1. */
  batchFraction: number;
}

/** `pipeline` attribute on the meeting item — the per-meeting fidelity audit trail. */
export interface PipelineState {
  phase: PipelinePhase;
  /** Highest model tier used so far. */
  tier: ModelTier;
  attempts: number;
  scores: PipelineScores;
  asrSource: AsrSource;
  signalHealth?: SignalHealth;
  batch?: BatchJobRef;
  /** Consented audio never arrived in time; pipeline proceeded on streaming text. */
  audioTimeout?: boolean;
  lastError?: string;
  executionArn?: string;
}

/** Payload the extension POSTs to the backend when a meeting ends. */
export interface MeetingIngestPayload {
  title: string;
  startedAt: string;
  endedAt: string;
  segments: DiarizedSegment[];
  speakerTimeline: SpeakerTimelineEntry[];
  /** Live-caption utterances when captions were on — primary P2 signal. */
  captionTimeline?: CaptionEvent[];
  /** Display name of the local user (mic source resolves to this). */
  localUserName: string;
  /** Widget tag taps during capture — P4 anchors them onto clean turns. */
  highlights?: HighlightTap[];
}

// ---------------------------------------------------------------------------
// Meeting lifecycle API (P1): start → segments* → finalize; reprocess anytime.
// ---------------------------------------------------------------------------

/**
 * POST /meetings — registers the meeting at capture start (`status: "capturing"`).
 * Idempotent by `captureId` (client-minted UUID, conditional put): a retry returns
 * the meetingId already minted for that captureId.
 */
export interface MeetingStartRequest {
  captureId: string;
  title?: string;
  /** ISO-8601 UTC. */
  startedAt: string;
}

export interface MeetingStartResponse {
  meetingId: string;
}

/**
 * POST /meetings/{id}/segments — batched append of finalized segments (server-side
 * checkpoint + live view). `seq` is a client-minted, monotonically increasing batch
 * number: the server drops batches whose seq it has already applied, so retries
 * never duplicate segments.
 */
export interface SegmentsAppendRequest {
  seq: number;
  segments: DiarizedSegment[];
}

export interface SegmentsAppendResponse {
  /** Total segments stored for the meeting after this batch. */
  segmentCount: number;
}

/** One in-meeting widget tag tap (§4.2), timed relative to capture start. */
export interface HighlightTap {
  /** Seconds from capture start. */
  t: number;
  /** Tag id, e.g. "decision", "action", "question", "highlight". */
  tag: string;
}

/**
 * POST /meetings/{id}/finalize — full final payload; idempotent by `meetingId`
 * (SFN execution name = meetingId, deduped by AWS), so blind retries after a 5xx
 * or timeout are safe. `captureId` enables upsert when the start call never landed.
 */
export interface MeetingFinalizeRequest extends MeetingIngestPayload {
  captureId: string;
  signalHealth?: SignalHealth;
  /** Consent recorded on the meeting item (§7); absent = tier 0. */
  audioConsent?: AudioConsent;
  /** Present only under consent Tier 2 — makes the 202 carry presigned PUT URLs. */
  audioPending?: AudioPendingDeclaration;
}

/** Returned with 202 — processing continues asynchronously in the pipeline. */
export interface MeetingFinalizeResponse {
  meetingId: string;
  /**
   * Presigned S3 PUT URL per declared source (Tier 2 only). Backend-signed
   * because the identity-pool role cannot be IAM-scoped to the
   * `{tenantId}/{meetingId}/audio/*` prefix.
   */
  audioUploadUrls?: Partial<Record<AudioSource, string>>;
}

/**
 * POST /meetings/{id}/reprocess — restarts the pipeline; every artifact is durable
 * and every anchor is id-keyed, so any phase is a valid restart point.
 */
export interface MeetingReprocessRequest {
  /** Phase to restart from; defaults to the beginning (INGESTED). */
  fromPhase?: PipelinePhase;
}

export interface MeetingReprocessResponse {
  meetingId: string;
  executionArn: string;
}

// ---------------------------------------------------------------------------
// Pipeline artifacts (P4–P8): clean transcript, extraction, summary, verification.
// Every cross-reference keys by stable id — never by array index (§4 anchor rule).
// ---------------------------------------------------------------------------

/** Chapter marker inserted by P4 (`## [mm:ss] Topic`). */
export interface ChapterMarker {
  /** Seconds from capture start. */
  startTime: number;
  title: string;
}

/**
 * One merged same-speaker turn in the clean transcript. `id` is the target of
 * `[Tn]` anchors (id === `T{n}`); `sourceIds` trace back to P2 segIds so user
 * edits/tags/highlights survive every rewrite and reprocess.
 */
export interface CleanTurn {
  id: string;
  sourceIds: string[];
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
  /** Free-form tags (pipeline- or user-applied), e.g. "decision", "highlight". */
  tags: string[];
}

/** P4 output (`transcript.clean.json`) — the canonical artifact GET serves. */
export interface CleanTranscript {
  turns: CleanTurn[];
  chapters: ChapterMarker[];
}

/** Base of every extracted item: quote + turn ref make Gate D and P7 mechanical. */
export interface ExtractedItem {
  text: string;
  /** Verbatim transcript quote backing the item; fuzzy-checked by Gate D. */
  verbatimQuote: string;
  /** CleanTurn id (or segId when grounded on raw) the quote came from. */
  turnId: string;
  /** True when the value was inferred rather than stated explicitly. */
  inferred: boolean;
}

export interface ExtractedActionItem extends ExtractedItem {
  /** Only when explicitly attributed in the meeting. */
  owner?: string;
  /** ISO-8601 date; only when explicitly stated. */
  due?: string;
  done: boolean;
}

/** P5 output (`extraction.json`), after Gate D quote validation. */
export interface ExtractionResult {
  decisions: ExtractedItem[];
  actionItems: ExtractedActionItem[];
  openQuestions: ExtractedItem[];
  keyNumbers: ExtractedItem[];
  participants: string[];
}

/**
 * P6 draft / P8 published summary (`summary.json`). `text` is Markdown where
 * every substantive claim carries a `[Tn]` anchor resolving to a CleanTurn id —
 * the web renders anchors as links, never as literal text.
 */
export interface SummaryArtifact {
  text: string;
  /** Turn ids referenced by anchors in `text` (parsed once, served to the web). */
  anchoredTurnIds: string[];
  /** Tier that produced this draft (Gate C choice / Gate E ladder). */
  tier: ModelTier;
}

export type VerificationVerdict =
  | "SUPPORTED"
  | "PARTIAL"
  | "UNSUPPORTED"
  | "UNCERTAIN";

/** One atomic claim decomposed from the summary and judged in P7. */
export interface VerifiedClaim {
  claim: string;
  verdict: VerificationVerdict;
  /** Supporting transcript quote; absent on UNSUPPORTED. */
  quote?: string;
  /** Turn id of the supporting quote; absent on UNSUPPORTED. */
  turnId?: string;
  /** True when the claim touches keyNumbers/actionItems/decisions (Gate E floor). */
  critical: boolean;
}

/** P7 output (`verification.json`) — the per-meeting fidelity audit trail. */
export interface VerificationReport {
  claims: VerifiedClaim[];
  scores: VerificationScores;
  /** Transcript the claims were judged against (P4 invariant gate may demote to raw). */
  groundedOn: "clean" | "raw";
}

export interface ActionItem {
  text: string;
  /** Resolved owner name when the agent could attribute it. */
  owner?: string;
}

export interface MeetingSummary {
  summary: string;
  keyPoints: string[];
  actionItems: ActionItem[];
}

/** Full meeting record as stored/returned to the dashboard. */
export interface MeetingRecord extends Meeting {
  segments: LabeledSegment[];
  summary?: MeetingSummary;
}

// ---------------------------------------------------------------------------
// Fleet telemetry (M6): escalation / needs_review rate counters feeding the
// CloudWatch alarms on the calibrated gate thresholds.
// ---------------------------------------------------------------------------

/**
 * Aggregated counters over a time window. Rates are precomputed at emission so
 * alarms read a single metric instead of a math expression.
 */
export interface PipelineTelemetryCounters {
  meetings: number;
  /** Meetings where any gate escalated past the default tier/path. */
  escalations: number;
  /** Meetings published with status "needs_review". */
  needsReview: number;
  /** escalations / meetings, 0–1; 0 when `meetings` is 0. */
  escalationRate: number;
  /** needsReview / meetings, 0–1; 0 when `meetings` is 0. */
  needsReviewRate: number;
  /** ISO-8601 UTC. */
  windowStart: string;
  windowEnd: string;
}
