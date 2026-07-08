import { CONFIG } from "./config";

async function req(token: string, path: string, init?: RequestInit) {
  const res = await fetch(`${CONFIG.apiUrl}${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${token}`,
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) throw new Error(`${res.status}`);
  return res.json();
}

export type MeetingStatus =
  | "capturing"
  | "processing"
  | "ready"
  | "needs_review"
  | "failed";

export type PipelinePhase =
  | "INGESTED"
  | "CORRELATED"
  | "ASR_SCORED"
  | "CLEANED"
  | "EXTRACTED"
  | "DRAFTED"
  | "VERIFIED"
  | "PUBLISHED";

export interface PipelineState {
  phase: PipelinePhase;
  tier: "haiku" | "sonnet" | "opus";
  attempts: number;
  lastError?: string;
}

export interface Meeting {
  meetingId: string;
  title: string;
  startedAt: string;
  endedAt?: string;
  // string fallback: legacy records predate the status machine
  status: MeetingStatus | (string & {});
  participants: { name: string }[];
  pipeline?: PipelineState;
}

export interface Segment {
  segId?: string;
  speaker: string;
  startTime: number;
  endTime?: number;
  text: string;
}

/** Clean-transcript turn served by GET /meetings/{id} — `id` is the `[Tn]` anchor target. */
export interface CleanTurn {
  id: string;
  sourceIds: string[];
  speaker: string;
  startTime: number;
  endTime: number;
  text: string;
  tags: string[];
}

export interface ExtractedItem {
  text: string;
  turnId?: string;
  inferred?: boolean;
}

export interface ExtractedActionItem extends ExtractedItem {
  owner?: string;
  due?: string;
  done?: boolean;
}

export interface Extraction {
  decisions?: ExtractedItem[];
  actionItems?: ExtractedActionItem[];
  openQuestions?: ExtractedItem[];
  keyNumbers?: ExtractedItem[];
}

export interface VerifiedClaim {
  claim: string;
  verdict: string;
  turnId?: string;
  critical?: boolean;
}

export interface MeetingDetail extends Meeting {
  segments: Segment[];
  summary?: { summary: string; keyPoints: string[]; actionItems: { text: string; owner?: string }[] };
  /** P4 artifact — canonical turns for the detail view; absent on legacy/live meetings. */
  cleanTranscript?: { turns: CleanTurn[]; chapters?: { startTime: number; title: string }[] };
  /** P5 artifact — decisions/actions/questions/numbers with `[Tn]` grounding. */
  extraction?: Extraction;
  /** P6/P8 artifact — full published summary Markdown with `[Tn]` anchors. */
  summaryArtifact?: { text: string; anchoredTurnIds?: string[] };
  /** P7 artifact — claim-level verification report. */
  verification?: { claims?: VerifiedClaim[] };
}

export const listMeetings = (t: string): Promise<{ meetings: Meeting[] }> =>
  req(t, "/meetings");

export const getMeeting = (t: string, id: string): Promise<MeetingDetail> =>
  req(t, `/meetings/${encodeURIComponent(id)}`);

export const askMeeting = (t: string, id: string, question: string): Promise<{ answer: string }> =>
  req(t, `/meetings/${encodeURIComponent(id)}/ask`, { method: "POST", body: JSON.stringify({ question }) });

export const deleteMeeting = (t: string, id: string): Promise<{ deleted: string }> =>
  req(t, `/meetings/${encodeURIComponent(id)}`, { method: "DELETE" });

export const reprocessMeeting = (t: string, id: string): Promise<{ meetingId: string; executionArn: string }> =>
  req(t, `/meetings/${encodeURIComponent(id)}/reprocess`, { method: "POST", body: JSON.stringify({}) });
