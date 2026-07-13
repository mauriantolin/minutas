import type {
  CleanTranscript,
  CleanTurn,
  ExtractedItem,
  ExtractionResult,
  Meeting,
  MeetingSummary,
  Note,
  SummaryArtifact,
} from "@teams-agent-core/shared";
import { EMBED_VERSION } from "./embed.js";

export interface BrainChunk {
  key: string;
  text: string;
  metadata: {
    type: "chapter" | "extraction" | "summary" | "digest" | "note";
    meetingId?: string;
    noteId?: string;
    dateEpoch: number;
    ownerSub?: string;
    embedVersion: string;
    title: string;
    chapterTitle?: string;
    turnStart?: string;
    turnEnd?: string;
  };
}

const CHAPTER_TARGET_TOKENS = 500;
const CHAPTER_MAX_TOKENS = 700;
const NOTE_WINDOW_TOKENS = 650;

const estimateTokens = (text: string): number => Math.ceil(text.length / 4);

const EXTRACTION_KINDS = [
  { field: "decisions", slug: "dec", label: "Decisión" },
  { field: "actionItems", slug: "act", label: "Tarea" },
  { field: "openQuestions", slug: "opq", label: "Pregunta abierta" },
  { field: "keyNumbers", slug: "num", label: "Cifra clave" },
] as const satisfies ReadonlyArray<{
  field: keyof ExtractionResult;
  slug: string;
  label: string;
}>;

type MeetingWithDigest = Meeting & { summary?: MeetingSummary };

interface MeetingContext {
  meetingId: string;
  title: string;
  fecha: string;
  dateEpoch: number;
}

export function chunkMeeting(
  meeting: MeetingWithDigest,
  artifacts: {
    extraction?: ExtractionResult;
    clean?: CleanTranscript;
    summary?: SummaryArtifact;
  },
): BrainChunk[] {
  const ctx: MeetingContext = {
    meetingId: meeting.meetingId,
    title: meeting.title,
    fecha: meeting.startedAt.slice(0, 10),
    dateEpoch: Math.floor(Date.parse(meeting.startedAt) / 1000),
  };
  const chunks: BrainChunk[] = [];
  if (artifacts.extraction) chunks.push(...extractionChunks(ctx, artifacts.extraction));
  if (artifacts.clean) chunks.push(...chapterChunks(ctx, artifacts.clean));
  if (artifacts.summary) chunks.push(...summaryChunks(ctx, artifacts.summary));
  chunks.push(digestChunk(ctx, meeting));
  return chunks;
}

export function chunkNote(note: Note): BrainChunk[] {
  const fecha = note.createdAt.slice(0, 10);
  const header = `Nota personal — ${fecha} — ${note.title}\n\n`;
  return splitPlainText(note.cleanText, NOTE_WINDOW_TOKENS).map((body, n) => ({
    key: `note#${note.noteId}#${n}`,
    text: header + body,
    metadata: {
      type: "note" as const,
      noteId: note.noteId,
      dateEpoch: Math.floor(Date.parse(note.createdAt) / 1000),
      ownerSub: note.ownerSub,
      embedVersion: EMBED_VERSION,
      title: note.title,
    },
  }));
}

function meetingMetadata(ctx: MeetingContext) {
  return {
    meetingId: ctx.meetingId,
    dateEpoch: ctx.dateEpoch,
    embedVersion: EMBED_VERSION,
    title: ctx.title,
  };
}

function extractionChunks(ctx: MeetingContext, extraction: ExtractionResult): BrainChunk[] {
  const chunks: BrainChunk[] = [];
  for (const kind of EXTRACTION_KINDS) {
    let i = 0;
    for (const item of extraction[kind.field] as ExtractedItem[]) {
      if (!item.text.trim()) continue;
      chunks.push({
        key: `${ctx.meetingId}#ex#${kind.slug}#${i}`,
        text: `${kind.label} (${ctx.fecha}, reunión "${ctx.title}"): ${item.text} — cita: "${item.verbatimQuote}" [${item.turnId}]`,
        metadata: {
          type: "extraction",
          ...meetingMetadata(ctx),
          turnStart: item.turnId,
        },
      });
      i++;
    }
  }
  return chunks;
}

function chapterChunks(ctx: MeetingContext, clean: CleanTranscript): BrainChunk[] {
  const chapters = [...clean.chapters].sort((a, b) => a.startTime - b.startTime);
  const groups: Array<{ title: string; turns: CleanTurn[] }> = [
    { title: "Inicio", turns: [] },
    ...chapters.map((c) => ({ title: c.title, turns: [] as CleanTurn[] })),
  ];
  for (const turn of clean.turns) {
    let g = 0;
    for (let k = 0; k < chapters.length; k++) {
      const chapter = chapters[k];
      if (chapter && chapter.startTime <= turn.startTime) g = k + 1;
    }
    groups[g]?.turns.push(turn);
  }

  const chunks: BrainChunk[] = [];
  let n = 0;
  for (const group of groups) {
    if (group.turns.length === 0) continue;
    const header = `Reunión: "${ctx.title}" — ${ctx.fecha} — Capítulo: "${group.title}"\n\n`;
    for (const window of splitTurnWindows(group.turns)) {
      const first = window[0];
      const last = window[window.length - 1];
      if (!first || !last) continue;
      chunks.push({
        key: `${ctx.meetingId}#ch#${n}`,
        text: header + window.map(renderTurn).join("\n"),
        metadata: {
          type: "chapter",
          ...meetingMetadata(ctx),
          chapterTitle: group.title,
          turnStart: first.id,
          turnEnd: last.id,
        },
      });
      n++;
    }
  }
  return chunks;
}

const renderTurn = (turn: CleanTurn): string => `[${turn.id}] ${turn.speaker}: ${turn.text}`;

function splitTurnWindows(turns: CleanTurn[]): CleanTurn[][] {
  const lineTokens = turns.map((t) => estimateTokens(renderTurn(t)));
  const windows: CleanTurn[][] = [];
  let i = 0;
  while (i < turns.length) {
    let j = i;
    let tokens = 0;
    while (j < turns.length) {
      const t = lineTokens[j] ?? 0;
      if (j > i && tokens + t > CHAPTER_MAX_TOKENS) break;
      tokens += t;
      j++;
      if (tokens >= CHAPTER_TARGET_TOKENS) break;
    }
    windows.push(turns.slice(i, j));
    if (j >= turns.length) break;
    i = j - 1;
  }
  return windows;
}

function summaryChunks(ctx: MeetingContext, summary: SummaryArtifact): BrainChunk[] {
  const header = `Resumen de reunión "${ctx.title}" — ${ctx.fecha}\n\n`;
  return splitSummarySections(summary.text).map((section, n) => ({
    key: `${ctx.meetingId}#sum#${n}`,
    text: header + section,
    metadata: {
      type: "summary" as const,
      ...meetingMetadata(ctx),
    },
  }));
}

function splitSummarySections(text: string): string[] {
  const starts = [...text.matchAll(/^## /gm)].map((m) => m.index);
  const sections: string[] = [];
  const preamble = text.slice(0, starts[0] ?? text.length).trim();
  if (preamble) sections.push(preamble);
  starts.forEach((start, k) => {
    const section = text.slice(start, starts[k + 1] ?? text.length).trim();
    if (section) sections.push(section);
  });
  return sections;
}

function digestChunk(ctx: MeetingContext, meeting: MeetingWithDigest): BrainChunk {
  const lines = [`Reunión: "${ctx.title}"`, `Fecha: ${ctx.fecha}`];
  if (meeting.participants.length > 0) {
    lines.push(`Participantes: ${meeting.participants.map((p) => p.name).join(", ")}`);
  }
  const keyPoints = meeting.summary?.keyPoints ?? [];
  if (keyPoints.length > 0) {
    lines.push("Puntos clave:", ...keyPoints.map((k) => `- ${k}`));
  }
  return {
    key: `${ctx.meetingId}#dig`,
    text: lines.join("\n"),
    metadata: {
      type: "digest",
      ...meetingMetadata(ctx),
    },
  };
}

function splitPlainText(text: string, maxTokens: number): string[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  if (estimateTokens(trimmed) <= maxTokens) return [trimmed];
  const maxChars = maxTokens * 4;
  const paragraphs = trimmed.split(/\n{2,}/).flatMap((p) => {
    const pieces: string[] = [];
    for (let i = 0; i < p.length; i += maxChars) pieces.push(p.slice(i, i + maxChars));
    return pieces;
  });
  const windows: string[] = [];
  let current: string[] = [];
  let currentTokens = 0;
  for (const paragraph of paragraphs) {
    const t = estimateTokens(paragraph);
    if (current.length > 0 && currentTokens + t > maxTokens) {
      windows.push(current.join("\n\n"));
      current = [];
      currentTokens = 0;
    }
    current.push(paragraph);
    currentTokens += t;
  }
  if (current.length > 0) windows.push(current.join("\n\n"));
  return windows;
}
