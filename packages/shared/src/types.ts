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
  /** unsupported / claims, 0–1. */
  unsupportedRate: number;
}

/** Gate scores accumulate as phases complete — each is absent until its phase ran. */
export interface PipelineScores {
  correlation?: CorrelationScores;
  asr?: AsrScores;
  invariants?: InvariantScores;
  verification?: VerificationScores;
}

/** Gate B task-token lookup: the Transcribe job-state event carries only the job name. */
export interface BatchJobRef {
  jobName: string;
  taskToken: string;
  /** ISO-8601 UTC. */
  startedAt: string;
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
  /** Display name of the local user (mic source resolves to this). */
  localUserName: string;
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

/**
 * POST /meetings/{id}/finalize — full final payload; idempotent by `meetingId`
 * (SFN execution name = meetingId, deduped by AWS), so blind retries after a 5xx
 * or timeout are safe. `captureId` enables upsert when the start call never landed.
 */
export interface MeetingFinalizeRequest extends MeetingIngestPayload {
  captureId: string;
  signalHealth?: SignalHealth;
}

/** Returned with 202 — processing continues asynchronously in the pipeline. */
export interface MeetingFinalizeResponse {
  meetingId: string;
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
