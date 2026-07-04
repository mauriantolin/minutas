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

export interface MeetingDetail extends Meeting {
  segments: Segment[];
  summary?: { summary: string; keyPoints: string[]; actionItems: { text: string; owner?: string }[] };
}

export const listMeetings = (t: string): Promise<{ meetings: Meeting[] }> =>
  req(t, "/meetings");

export const getMeeting = (t: string, id: string): Promise<MeetingDetail> =>
  req(t, `/meetings/${id}`);

export const askMeeting = (t: string, id: string, question: string): Promise<{ answer: string }> =>
  req(t, `/meetings/${id}/ask`, { method: "POST", body: JSON.stringify({ question }) });

export const deleteMeeting = (t: string, id: string): Promise<{ deleted: string }> =>
  req(t, `/meetings/${id}`, { method: "DELETE" });

export const reprocessMeeting = (t: string, id: string): Promise<{ meetingId: string; executionArn: string }> =>
  req(t, `/meetings/${id}/reprocess`, { method: "POST", body: JSON.stringify({}) });
