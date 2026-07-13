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

export type NoteSource = "typed" | "voice";

export interface Note {
  noteId: string;
  title: string;
  rawText: string;
  cleanText: string;
  source: NoteSource;
  createdAt: string;
  updatedAt: string;
}

export interface BrainCitation {
  ref: string;
  kind: "meeting" | "note";
  id: string;
  turnId?: string;
  title: string;
  date?: string;
  url: string;
}

export interface BrainMessage {
  role: "user" | "assistant";
  text: string;
  citations?: BrainCitation[];
  at: string;
}

export interface BrainThreadSummary {
  threadId: string;
  title: string;
  updatedAt: string;
}

export interface BrainThread {
  threadId: string;
  title: string;
  messages: BrainMessage[];
  createdAt: string;
  updatedAt: string;
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

export const brainAsk = (
  t: string,
  body: { threadId?: string; message: string },
): Promise<{ threadId: string; answer: string; citations: BrainCitation[] }> =>
  req(t, "/brain/ask", { method: "POST", body: JSON.stringify(body) });

export const listBrainThreads = (t: string): Promise<{ threads: BrainThreadSummary[] }> =>
  req(t, "/brain/threads");

export const getBrainThread = (t: string, id: string): Promise<BrainThread> =>
  req(t, `/brain/threads/${encodeURIComponent(id)}`);

export const deleteBrainThread = (t: string, id: string): Promise<{ ok: boolean }> =>
  req(t, `/brain/threads/${encodeURIComponent(id)}`, { method: "DELETE" });

export const listNotes = (t: string): Promise<{ notes: Note[] }> =>
  req(t, "/notes");

export const createNote = (t: string, body: { rawText: string; source: NoteSource }): Promise<Note> =>
  req(t, "/notes", { method: "POST", body: JSON.stringify(body) });

export const getNote = (t: string, id: string): Promise<Note> =>
  req(t, `/notes/${encodeURIComponent(id)}`);

export const updateNote = (
  t: string,
  id: string,
  body: { title?: string; rawText?: string; cleanText?: string; reclean?: boolean },
): Promise<Note> =>
  req(t, `/notes/${encodeURIComponent(id)}`, { method: "PUT", body: JSON.stringify(body) });

export const deleteNote = (t: string, id: string): Promise<{ ok: boolean }> =>
  req(t, `/notes/${encodeURIComponent(id)}`, { method: "DELETE" });
