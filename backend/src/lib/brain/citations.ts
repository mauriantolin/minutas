import type { BrainCitation } from "@teams-agent-core/shared";
import type { QueryHit } from "./vectorstore.js";

const REF_RE = /\[M:([A-Za-z0-9._-]+):(T\d+)\]|\[N:([A-Za-z0-9._-]+)\]/g;

export interface ParsedRef {
  ref: string;
  kind: "meeting" | "note";
  id: string;
  turnId?: string;
}

export function parseRefs(answerMd: string): ParsedRef[] {
  const refs: ParsedRef[] = [];
  const seen = new Set<string>();
  for (const m of answerMd.matchAll(REF_RE)) {
    const parsed: ParsedRef =
      m[1] !== undefined
        ? { ref: `M:${m[1]}:${m[2]}`, kind: "meeting", id: m[1], turnId: m[2] as string }
        : { ref: `N:${m[3]}`, kind: "note", id: m[3] as string };
    if (seen.has(parsed.ref)) continue;
    seen.add(parsed.ref);
    refs.push(parsed);
  }
  return refs;
}

function resolveHit(parsed: ParsedRef, hits: QueryHit[]): QueryHit | undefined {
  return hits.find((h) =>
    parsed.kind === "meeting"
      ? h.metadata["meetingId"] === parsed.id
      : h.metadata["noteId"] === parsed.id && h.metadata["type"] === "note",
  );
}

function citationUrl(parsed: ParsedRef): string {
  if (parsed.kind === "note") return `/notes?id=${encodeURIComponent(parsed.id)}`;
  const turn = parsed.turnId ? `&turn=${parsed.turnId}` : "";
  return `/meeting?id=${encodeURIComponent(parsed.id)}${turn}`;
}

export function resolveCitations(
  answerMd: string,
  hits: QueryHit[],
): { answerMd: string; citations: BrainCitation[] } {
  const citations: BrainCitation[] = [];
  let text = answerMd;
  let stripped = false;
  for (const parsed of parseRefs(answerMd)) {
    const hit = resolveHit(parsed, hits);
    if (!hit) {
      text = text.split(`[${parsed.ref}]`).join("");
      stripped = true;
      continue;
    }
    const dateEpoch = hit.metadata["dateEpoch"];
    citations.push({
      ref: parsed.ref,
      kind: parsed.kind,
      id: parsed.id,
      ...(parsed.turnId ? { turnId: parsed.turnId } : {}),
      title: String(hit.metadata["title"] ?? ""),
      ...(dateEpoch
        ? { date: new Date(Number(dateEpoch) * 1000).toISOString().slice(0, 10) }
        : {}),
      url: citationUrl(parsed),
    });
  }
  if (stripped) text = text.replace(/[ \t]{2,}/g, " ").trim();
  return { answerMd: text, citations };
}
