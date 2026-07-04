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
  title: string;
  /** ISO-8601 UTC. */
  startedAt: string;
  /** ISO-8601 UTC; absent while the meeting is still in progress. */
  endedAt?: string;
  participants: MeetingParticipant[];
  status: MeetingStatus;
}

export type MeetingStatus = "capturing" | "processing" | "ready" | "failed";

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
