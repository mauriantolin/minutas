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

export interface Meeting {
  meetingId: string;
  title: string;
  startedAt: string;
  status: string;
  participants: { name: string }[];
}

export interface Segment {
  speaker: string;
  startTime: number;
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
