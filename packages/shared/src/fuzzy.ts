/**
 * Normalized fuzzy text matching — the $0 programmatic signal behind Gate D
 * (P5 quote validation) and P7 (claim-quote re-validation), and the caption↔ASR
 * overlap scorer used by correlation v2. Pure functions, no I/O.
 */

/** Lowercase, strip accents and punctuation, collapse whitespace. */
export function normalizeForMatch(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function tokenize(text: string): string[] {
  const normalized = normalizeForMatch(text);
  return normalized ? normalized.split(" ") : [];
}

/** Minimum containment score for a quote to count as present (Gate D / P7). */
export const QUOTE_MATCH_MIN = 0.8;

/**
 * Best sliding-window multiset containment of `needle` tokens in `haystack`, 0–1.
 * Window is needle length + 25% slack so ASR filler insertions don't sink exact quotes.
 */
export function tokenContainment(needle: string, haystack: string): number {
  const needleNorm = normalizeForMatch(needle);
  const haystackNorm = normalizeForMatch(haystack);
  if (!needleNorm || !haystackNorm) return 0;
  // Token-aligned fast path: a raw substring test would score "ok" inside
  // "broker" or "si" inside "así" as a perfect match.
  if (` ${haystackNorm} `.includes(` ${needleNorm} `)) return 1;

  const needleTokens = needleNorm.split(" ");
  const haystackTokens = haystackNorm.split(" ");
  const window = Math.min(
    haystackTokens.length,
    needleTokens.length + Math.ceil(needleTokens.length / 4),
  );

  const needleCounts = new Map<string, number>();
  for (const tok of needleTokens) {
    needleCounts.set(tok, (needleCounts.get(tok) ?? 0) + 1);
  }

  let best = 0;
  for (let i = 0; i + window <= haystackTokens.length; i++) {
    const counts = new Map(needleCounts);
    let matches = 0;
    for (const tok of haystackTokens.slice(i, i + window)) {
      const left = counts.get(tok) ?? 0;
      if (left > 0) {
        counts.set(tok, left - 1);
        matches++;
      }
    }
    best = Math.max(best, matches / needleTokens.length);
    if (best === 1) break;
  }
  return best;
}

/** Symmetric overlap: max containment in either direction (caption↔segment scoring). */
export function textOverlapScore(a: string, b: string): number {
  return Math.max(tokenContainment(a, b), tokenContainment(b, a));
}

/** True when `quote` fuzzily appears inside `text` (Gate D per-transcript check). */
export function quoteExists(
  quote: string,
  text: string,
  minScore: number = QUOTE_MATCH_MIN,
): boolean {
  return tokenContainment(quote, text) >= minScore;
}

export interface QuoteMatch {
  /** Id of the turn (or segment) holding the quote. */
  turnId: string;
  /** Containment score of the winning turn, 0–1. */
  score: number;
}

/**
 * Locates a quote inside a list of turns; best-scoring turn at or above `minScore`
 * wins. Quotes are expected within a single turn (P5 contract), not across turns.
 */
export function findQuote(
  quote: string,
  turns: readonly { id: string; text: string }[],
  minScore: number = QUOTE_MATCH_MIN,
): QuoteMatch | undefined {
  let best: QuoteMatch | undefined;
  for (const turn of turns) {
    const score = tokenContainment(quote, turn.text);
    if (score >= minScore && (!best || score > best.score)) {
      best = { turnId: turn.id, score };
      if (score === 1) break;
    }
  }
  return best;
}
