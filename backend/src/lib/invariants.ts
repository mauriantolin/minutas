import { tokenize } from "@teams-agent-core/shared";

/**
 * P4 invariant gate inputs — pure regex/token diffs between raw source text and
 * the LLM-cleaned rewrite ($0, runs before any verification token is spent).
 * Spanish-first negation lexicon: transcripts come from es-US ASR; English
 * contractions tokenize apart ("don't" → "don t") and are deliberately not
 * modeled — "no"/"not"/"never" cover the standalone English cases.
 */
const NEGATION_TOKENS = new Set([
  "no",
  "not",
  "never",
  "nunca",
  "jamas",
  "ni",
  "tampoco",
  "nadie",
  "ninguno",
  "ninguna",
  "nada",
  "sin",
]);

/** Digit-bearing tokens, canonicalized (separators stripped) for set-diffing. */
export function extractNumbers(text: string): Set<string> {
  return new Set(
    (text.match(/\d+(?:[.,]\d+)*/g) ?? []).map((n) => n.replace(/[.,]/g, "")),
  );
}

export function extractNegations(text: string): Set<string> {
  return new Set(tokenize(text).filter((t) => NEGATION_TOKENS.has(t)));
}

export interface TurnAudit {
  missingNumbers: string[];
  introducedNumbers: string[];
  /** Negation tokens present on one side only — a possible polarity flip. */
  negationFlips: string[];
}

export function auditTurnInvariants(
  rawText: string,
  cleanText: string,
): TurnAudit {
  const rawNums = extractNumbers(rawText);
  const cleanNums = extractNumbers(cleanText);
  const rawNeg = extractNegations(rawText);
  const cleanNeg = extractNegations(cleanText);
  return {
    missingNumbers: [...rawNums].filter((n) => !cleanNums.has(n)),
    introducedNumbers: [...cleanNums].filter((n) => !rawNums.has(n)),
    negationFlips: [
      ...[...rawNeg].filter((t) => !cleanNeg.has(t)),
      ...[...cleanNeg].filter((t) => !rawNeg.has(t)),
    ],
  };
}

export function hasViolations(a: TurnAudit): boolean {
  return (
    a.missingNumbers.length + a.introducedNumbers.length + a.negationFlips.length >
    0
  );
}
