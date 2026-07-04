import {
  BedrockRuntimeClient,
  ConverseCommand,
  type ContentBlock,
  type ConverseCommandInput,
  type SystemContentBlock,
  type ToolConfiguration,
} from "@aws-sdk/client-bedrock-runtime";
import type {
  ChapterMarker,
  CleanTranscript,
  CorrelatedSegment,
  ExtractedActionItem,
  ExtractedItem,
  ExtractionResult,
  LabeledSegment,
  ModelTier,
  VerificationVerdict,
  VerifiedClaim,
} from "@teams-agent-core/shared";

const bedrock = new BedrockRuntimeClient({});

const MODEL_BY_TIER: Record<ModelTier, string> = {
  haiku:
    process.env.MODEL_HAIKU ??
    process.env.BEDROCK_MODEL_ID ??
    "us.anthropic.claude-haiku-4-5-20251001-v1:0",
  sonnet:
    process.env.MODEL_SONNET ?? "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
  opus: process.env.MODEL_OPUS ?? "us.anthropic.claude-opus-4-5-20251101-v1:0",
};

/**
 * Structured output stayed unusable after the in-call corrective retry. Callers
 * publish `needs_review` on this — never a terminal "failed" (§2-P7).
 * `correctable: false` skips the corrective retry (e.g. a max_tokens truncation
 * would deterministically truncate again at the same cap and temperature 0).
 */
export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly correctable: boolean = true,
  ) {
    super(message);
  }
}

// ---------------------------------------------------------------------------
// Cache-prefix discipline (§2-P4, non-negotiable): ONE system block and ONE
// tool configuration (union of all phase tools, toolChoice included) shared by
// every call; the transcript context block + cachePoint open the user turn;
// all per-phase instructions live strictly AFTER the breakpoint. Bedrock's
// cache key hashes tools → system → messages byte-exactly up to the
// cachePoint, so any per-phase drift here silently triples P6/P7 input cost.
// ---------------------------------------------------------------------------

const SHARED_SYSTEM = `You are the analysis engine of a meeting-intelligence pipeline that processes Microsoft Teams meeting transcripts.

Input format: the user turn always starts with one meeting context block, then a task instruction. Transcripts come in one of two forms:
- Raw diarized segments: lines like "[s12] [03:41] Maria Lopez: text", where s12 is the stable segment id.
- Clean turns: lines like "[T4] [03:41] Maria Lopez: text", where T4 is the stable turn id, optionally preceded by chapter headings like "## [12:30] Topic".

Non-negotiable rules, in priority order:
1. Ground every output in the provided transcript. Never invent facts, numbers, names, dates, owners or commitments that are not in it.
2. Verbatim quotes must be copied exactly from the transcript and must come from a single segment or turn — never stitch a quote across turns.
3. Reference turns and segments only by their stable ids ([Tn] / [sn]); never by position or paraphrase.
4. Preserve numbers, dates, amounts, proper names and negations exactly as spoken; never round, convert, translate or paraphrase them.
5. All text written for end users (summaries, key points, action items, answers) is written in Spanish. Structural values (ids, ISO dates, enum values, tool argument keys) keep their required format.
6. Complete every task by calling exactly the single tool named in the task instruction, with a complete, schema-valid argument object. Never respond with plain text instead of the tool call.`;

const EXTRACTED_ITEM_SCHEMA = {
  type: "object",
  properties: {
    text: { type: "string", description: "Concise Spanish statement of the item." },
    verbatimQuote: {
      type: "string",
      description: "Exact quote from ONE single turn supporting the item.",
    },
    turnId: { type: "string", description: "Stable id of the quoted turn." },
    inferred: {
      type: "boolean",
      description: "True when implied rather than explicitly stated.",
    },
  },
  required: ["text", "verbatimQuote", "turnId", "inferred"],
};

const TOOL_CONFIG: ToolConfiguration = {
  tools: [
    {
      toolSpec: {
        name: "record_clean_transcript",
        description:
          "Deliver the cleaned transcript: merged same-speaker turns, chapter markers, and a self-assessment of input quality.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              turns: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    sourceIds: {
                      type: "array",
                      items: { type: "string" },
                      description:
                        "Ids of the raw segments merged into this turn, in chronological order.",
                    },
                    speaker: { type: "string" },
                    text: { type: "string" },
                  },
                  required: ["sourceIds", "speaker", "text"],
                },
              },
              chapters: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    startTime: {
                      type: "number",
                      description: "Seconds from capture start.",
                    },
                    title: { type: "string" },
                  },
                  required: ["startTime", "title"],
                },
              },
              qualityScore: {
                type: "number",
                description: "Self-assessed input transcript quality, 0-1.",
              },
              garbledPct: {
                type: "number",
                description: "Share of input text that is garbled, 0-100.",
              },
            },
            required: ["turns", "chapters", "qualityScore", "garbledPct"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "record_extraction",
        description:
          "Deliver the structured extraction: decisions, action items, open questions, key numbers and participants — every item backed by a verbatim quote and turn id.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              decisions: { type: "array", items: EXTRACTED_ITEM_SCHEMA },
              actionItems: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    ...EXTRACTED_ITEM_SCHEMA.properties,
                    owner: {
                      type: "string",
                      description: "Only when explicitly attributed.",
                    },
                    due: {
                      type: "string",
                      description: "ISO-8601 date, only when explicitly stated.",
                    },
                    done: { type: "boolean" },
                  },
                  required: [...EXTRACTED_ITEM_SCHEMA.required, "done"],
                },
              },
              openQuestions: { type: "array", items: EXTRACTED_ITEM_SCHEMA },
              keyNumbers: { type: "array", items: EXTRACTED_ITEM_SCHEMA },
              participants: { type: "array", items: { type: "string" } },
            },
            required: [
              "decisions",
              "actionItems",
              "openQuestions",
              "keyNumbers",
              "participants",
            ],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "record_summary",
        description:
          "Deliver the meeting summary as Spanish Markdown where every substantive claim carries [Tn] turn anchors.",
        inputSchema: {
          json: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "record_verification",
        description:
          "Deliver the claim-by-claim verification of a summary against the transcript.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              claims: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    claim: { type: "string" },
                    verdict: {
                      type: "string",
                      enum: ["SUPPORTED", "PARTIAL", "UNSUPPORTED", "UNCERTAIN"],
                    },
                    quote: {
                      type: "string",
                      description:
                        "Exact single-turn supporting quote; omit on UNSUPPORTED.",
                    },
                    turnId: {
                      type: "string",
                      description: "Turn id of the quote; omit on UNSUPPORTED.",
                    },
                    critical: {
                      type: "boolean",
                      description:
                        "True when the claim involves numbers/amounts/dates, action items or decisions.",
                    },
                  },
                  required: ["claim", "verdict", "critical"],
                },
              },
            },
            required: ["claims"],
          },
        },
      },
    },
    {
      toolSpec: {
        name: "record_answer",
        description: "Deliver the answer to a user question about the meeting.",
        inputSchema: {
          json: {
            type: "object",
            properties: {
              answer: { type: "string" },
              sufficient: {
                type: "boolean",
                description:
                  "False when the provided context was not enough to answer.",
              },
            },
            required: ["answer", "sufficient"],
          },
        },
      },
    },
  ],
  // Forced tool use, but identical across phases: tool SELECTION lives in the
  // post-breakpoint instruction because toolChoice participates in the cache key.
  toolChoice: { any: {} },
};

const SYSTEM: SystemContentBlock[] = [{ text: SHARED_SYSTEM }];

// ---------------------------------------------------------------------------
// Core converse call: throttle backoff + forced tool use + schema validation
// with one corrective retry (only post-breakpoint content changes on retry).
// ---------------------------------------------------------------------------

interface ToolCall<T> {
  /** CloudWatch usage-metric tag (phase name). */
  label: string;
  tier: ModelTier;
  /** Pre-breakpoint block — byte-identical across phases sharing a cache. */
  context: string;
  /** Post-breakpoint task instruction. */
  instruction: string;
  tool: string;
  maxTokens: number;
  /** Extended cache TTL for the Q&A transcript path; phases use the 5m default. */
  cacheTtl?: "5m" | "1h";
  /** Throttle-backoff retry cap; API-synchronous paths need a tighter budget. */
  throttleRetries?: number;
  validate: (input: unknown) => T;
}

async function converseTool<T>(call: ToolCall<T>): Promise<T> {
  const attempt = async (correction?: string): Promise<T> => {
    const content: ContentBlock[] = [
      { text: call.context },
      {
        cachePoint: {
          type: "default",
          ...(call.cacheTtl === "1h" ? { ttl: "1h" as const } : {}),
        },
      },
      {
        text: correction
          ? `${call.instruction}\n\nYour previous attempt was invalid: ${correction}\nCall ${call.tool} again with a fully schema-valid argument object.`
          : call.instruction,
      },
    ];
    const input: ConverseCommandInput = {
      modelId: MODEL_BY_TIER[call.tier],
      system: SYSTEM,
      messages: [{ role: "user", content }],
      toolConfig: TOOL_CONFIG,
      inferenceConfig: { maxTokens: call.maxTokens, temperature: 0 },
    };
    const res = await sendWithBackoff(input, call.throttleRetries);
    logUsage(call, res.usage);
    if (res.stopReason === "max_tokens") {
      throw new StructuredOutputError(
        `output truncated at maxTokens=${call.maxTokens}`,
        false,
      );
    }
    const blocks = res.output?.message?.content ?? [];
    const toolUse = blocks
      .flatMap((b) => ("toolUse" in b && b.toolUse ? [b.toolUse] : []))
      .find((t) => t.name === call.tool);
    if (!toolUse) {
      throw new StructuredOutputError(`model did not call ${call.tool}`);
    }
    return call.validate(toolUse.input);
  };

  try {
    return await attempt();
  } catch (err) {
    if (!(err instanceof StructuredOutputError) || !err.correctable) throw err;
    return attempt(err.message);
  }
}

const RETRYABLE = new Set([
  "ThrottlingException",
  "TooManyRequestsException",
  "ServiceUnavailableException",
  "ModelNotReadyException",
]);

async function sendWithBackoff(
  input: ConverseCommandInput,
  maxRetries: number = 4,
) {
  for (let i = 0; ; i++) {
    try {
      return await bedrock.send(new ConverseCommand(input));
    } catch (err) {
      const e = err as Error & { $metadata?: { httpStatusCode?: number } };
      const throttled =
        RETRYABLE.has(e.name) || e.$metadata?.httpStatusCode === 429;
      if (!throttled || i >= maxRetries) throw err;
      await new Promise((r) =>
        setTimeout(r, 500 * 2 ** i + Math.random() * 250),
      );
    }
  }
}

/** The cost model depends on cache hits — emit them so CI/alarms can assert. */
function logUsage(
  call: ToolCall<unknown>,
  usage:
    | {
        inputTokens?: number;
        outputTokens?: number;
        cacheReadInputTokens?: number;
        cacheWriteInputTokens?: number;
      }
    | undefined,
): void {
  console.log(
    JSON.stringify({
      metric: "bedrock_usage",
      label: call.label,
      tier: call.tier,
      inputTokens: usage?.inputTokens ?? 0,
      outputTokens: usage?.outputTokens ?? 0,
      cacheReadInputTokens: usage?.cacheReadInputTokens ?? 0,
      cacheWriteInputTokens: usage?.cacheWriteInputTokens ?? 0,
    }),
  );
}

// ---------------------------------------------------------------------------
// Deterministic transcript rendering — the byte-stable cached prefix. Any
// change here is a cache-schema change for every phase at once.
// ---------------------------------------------------------------------------

export function renderRawTranscript(segments: CorrelatedSegment[]): string {
  return segments
    .map((s) => `[${s.segId}] [${fmt(s.startTime)}] ${s.speaker}: ${s.text}`)
    .join("\n");
}

export function renderCleanTranscript(t: CleanTranscript): string {
  const chapters = [...t.chapters].sort((a, b) => a.startTime - b.startTime);
  const lines: string[] = [];
  let ci = 0;
  for (const turn of t.turns) {
    while (ci < chapters.length && chapters[ci]!.startTime <= turn.startTime) {
      lines.push(`## [${fmt(chapters[ci]!.startTime)}] ${chapters[ci]!.title}`);
      ci++;
    }
    lines.push(
      `[${turn.id}] [${fmt(turn.startTime)}] ${turn.speaker}: ${turn.text}`,
    );
  }
  for (; ci < chapters.length; ci++) {
    lines.push(`## [${fmt(chapters[ci]!.startTime)}] ${chapters[ci]!.title}`);
  }
  return lines.join("\n");
}

/** Shared prefix for P5–P8 and full-transcript Q&A. */
export function cleanTranscriptContext(clean: CleanTranscript): string {
  return `MEETING TRANSCRIPT (clean turns with stable [Tn] ids):\n\n${renderCleanTranscript(clean)}`;
}

function rawTranscriptContext(segments: CorrelatedSegment[]): string {
  return `RAW DIARIZED TRANSCRIPT (stable [sn] segment ids):\n\n${renderRawTranscript(segments)}`;
}

export function parseTurnAnchors(text: string): string[] {
  return [...new Set([...text.matchAll(/\[(T\d+)\]/g)].map((m) => m[1]!))];
}

function fmt(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${m.toString().padStart(2, "0")}:${s.toString().padStart(2, "0")}`;
}

// ---------------------------------------------------------------------------
// Validators (the model boundary is an external edge — validate everything).
// ---------------------------------------------------------------------------

function rec(v: unknown, path: string): Record<string, unknown> {
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new StructuredOutputError(`${path}: expected object`);
  }
  return v as Record<string, unknown>;
}

function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new StructuredOutputError(`${path}: expected array`);
  return v;
}

function str(v: unknown, path: string): string {
  if (typeof v !== "string") {
    throw new StructuredOutputError(`${path}: expected string`);
  }
  return v;
}

function num(v: unknown, path: string): number {
  if (typeof v !== "number" || Number.isNaN(v)) {
    throw new StructuredOutputError(`${path}: expected number`);
  }
  return v;
}

function optStr(v: unknown, path: string): string | undefined {
  if (v === undefined || v === null || v === "") return undefined;
  return str(v, path);
}

const VERDICTS: readonly VerificationVerdict[] = [
  "SUPPORTED",
  "PARTIAL",
  "UNSUPPORTED",
  "UNCERTAIN",
];

function extractedItem(v: unknown, path: string): ExtractedItem {
  const o = rec(v, path);
  return {
    text: str(o.text, `${path}.text`),
    verbatimQuote: str(o.verbatimQuote, `${path}.verbatimQuote`),
    turnId: str(o.turnId, `${path}.turnId`),
    inferred: o.inferred === true,
  };
}

// ---------------------------------------------------------------------------
// P4 — transcript refinement (Haiku, "clean, don't paraphrase").
// ---------------------------------------------------------------------------

export interface CleanDraftTurn {
  sourceIds: string[];
  speaker: string;
  text: string;
}

export interface CleanDraft {
  turns: CleanDraftTurn[];
  chapters: ChapterMarker[];
  /** Model self-report — Gate C OR-escalation input only, never a pass signal. */
  qualityScore: number;
  garbledPct: number;
}

export async function generateCleanTranscript(opts: {
  tier: ModelTier;
  segments: CorrelatedSegment[];
  /** Gate A repair targets: only these segments may be relabeled. */
  repairSegIds?: string[];
  participantNames?: string[];
  /** Invariant-gate re-run feedback. */
  correctionNote?: string;
}): Promise<CleanDraft> {
  // Repair instructions stay in a separate section so repair never licenses
  // paraphrase (§2-P4).
  const repair = opts.repairSegIds?.length
    ? `\n\nSPEAKER REPAIR — applies ONLY to these low-confidence segments: ${opts.repairSegIds.join(", ")}.
Using conversational cues (direct address, self-reference, speaker handoffs) and this participant list: ${(opts.participantNames ?? []).join(", ") || "(unknown)"}, assign a better speaker name to those segments' turns when the cues are clear; otherwise keep the current label. Every other segment's speaker is high-confidence and OFF-LIMITS — copy it unchanged. Repair never licenses rewording the text.`
    : "";
  const correction = opts.correctionNote
    ? `\n\nCORRECTION — your previous output violated the preservation contract:\n${opts.correctionNote}\nRegenerate the full output fixing exactly these violations.`
    : "";
  const instruction = `TASK: Clean the raw diarized transcript above into merged turns, then call record_clean_transcript.

Cleanup contract — clean, don't paraphrase:
- Merge consecutive segments by the same speaker into one turn; list every merged segment id in sourceIds. Every input segment id must appear in exactly one turn, in chronological order.
- Remove disfluencies (filler like "eh", "este", "o sea" used as muletilla), false starts and ASR stutter; fix punctuation and casing.
- Keep the original language and wording otherwise. PRESERVE verbatim every number, date, amount, proper name and negation.
- Insert chapter markers at topic changes: startTime in seconds aligned with the first turn of the topic, short Spanish title.
- Self-assess the INPUT transcript: qualityScore (0-1) and garbledPct (0-100).${repair}${correction}`;

  const context = rawTranscriptContext(opts.segments);
  // Clean re-emits the whole transcript inside the tool call, so a fixed cap
  // deterministically truncates long meetings: size the cap from the input
  // (~1 token per 4 chars, ×2 for the JSON envelope), clamped to the 64K
  // output ceiling shared by all three tiers.
  const maxTokens = Math.min(
    64000,
    Math.max(24000, Math.ceil(context.length / 2)),
  );

  return converseTool({
    label: "clean",
    tier: opts.tier,
    context,
    instruction,
    tool: "record_clean_transcript",
    maxTokens,
    validate: (input) => {
      const o = rec(input, "$");
      const turns = arr(o.turns, "$.turns").map((t, i) => {
        const to = rec(t, `$.turns[${i}]`);
        const sourceIds = arr(to.sourceIds, `$.turns[${i}].sourceIds`).map(
          (s, j) => str(s, `$.turns[${i}].sourceIds[${j}]`),
        );
        if (!sourceIds.length) {
          throw new StructuredOutputError(`$.turns[${i}].sourceIds: empty`);
        }
        return {
          sourceIds,
          speaker: str(to.speaker, `$.turns[${i}].speaker`),
          text: str(to.text, `$.turns[${i}].text`),
        };
      });
      if (!turns.length) throw new StructuredOutputError("$.turns: empty");
      const chapters = arr(o.chapters ?? [], "$.chapters").map((c, i) => {
        const co = rec(c, `$.chapters[${i}]`);
        return {
          startTime: num(co.startTime, `$.chapters[${i}].startTime`),
          title: str(co.title, `$.chapters[${i}].title`),
        };
      });
      return {
        turns,
        chapters,
        qualityScore: num(o.qualityScore ?? 1, "$.qualityScore"),
        garbledPct: num(o.garbledPct ?? 0, "$.garbledPct"),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// P5 — structured extraction (pre-Gate-D; the pipeline validates quotes).
// ---------------------------------------------------------------------------

export async function generateExtraction(
  context: string,
): Promise<ExtractionResult> {
  const instruction = `TASK: Extract structured items from the clean transcript above, then call record_extraction.
- decisions: decisions explicitly made in the meeting.
- actionItems: commitments and tasks. owner only when explicitly attributed; due only when an explicit date/deadline was stated (ISO-8601); done=true only when stated as already completed.
- openQuestions: questions raised and left unanswered.
- keyNumbers: figures, amounts, dates and metrics that matter.
- participants: every distinct speaker name in the transcript.
For every item: text is a concise Spanish statement; verbatimQuote is copied EXACTLY from ONE single turn (a quote may never span turns); turnId is that turn's id; inferred=true when the item is implied rather than stated.
Extract only what the transcript supports — when in doubt, leave it out.`;

  return converseTool({
    label: "extract",
    tier: "haiku",
    context,
    instruction,
    tool: "record_extraction",
    maxTokens: 8192,
    validate: (input) => {
      const o = rec(input, "$");
      const items = (key: string) =>
        arr(o[key] ?? [], `$.${key}`).map((v, i) =>
          extractedItem(v, `$.${key}[${i}]`),
        );
      const actionItems: ExtractedActionItem[] = arr(
        o.actionItems ?? [],
        "$.actionItems",
      ).map((v, i) => {
        const base = extractedItem(v, `$.actionItems[${i}]`);
        const ao = rec(v, `$.actionItems[${i}]`);
        return {
          ...base,
          ...(optStr(ao.owner, `$.actionItems[${i}].owner`)
            ? { owner: str(ao.owner, `$.actionItems[${i}].owner`) }
            : {}),
          ...(optStr(ao.due, `$.actionItems[${i}].due`)
            ? { due: str(ao.due, `$.actionItems[${i}].due`) }
            : {}),
          done: ao.done === true,
        };
      });
      return {
        decisions: items("decisions"),
        actionItems,
        openQuestions: items("openQuestions"),
        keyNumbers: items("keyNumbers"),
        participants: arr(o.participants ?? [], "$.participants").map((p, i) =>
          str(p, `$.participants[${i}]`),
        ),
      };
    },
  });
}

// ---------------------------------------------------------------------------
// P6 — synthesis (Haiku default, Sonnet/Opus per Gate C / Gate E ladder).
// ---------------------------------------------------------------------------

export async function generateSummary(opts: {
  tier: ModelTier;
  context: string;
  extraction: ExtractionResult;
  chapters: ChapterMarker[];
  validTurnIds: ReadonlySet<string>;
}): Promise<string> {
  const instruction = `TASK: Write the meeting summary, then call record_summary.

- Markdown, in Spanish: one short executive paragraph first, then sections (### Decisiones / ### Acciones / ### Temas / ### Preguntas abiertas) as warranted by the content.
- EVERY substantive claim ends with the [Tn] anchor(s) of the turn(s) supporting it, e.g. "Se aprobó el presupuesto de 500 mil [T12].". Use only turn ids that exist in the transcript above.
- Only claims grounded in the transcript; prefer the validated items from the extraction JSON below; preserve numbers, names and dates exactly.
- Concise: 250-450 words.

VALIDATED EXTRACTION JSON:
${JSON.stringify(opts.extraction)}

CHAPTERS:
${JSON.stringify(opts.chapters)}`;

  return converseTool({
    label: "synthesize",
    tier: opts.tier,
    context: opts.context,
    instruction,
    tool: "record_summary",
    maxTokens: 4096,
    validate: (input) => summaryText(input, opts.validTurnIds),
  });
}

function summaryText(input: unknown, validTurnIds: ReadonlySet<string>): string {
  const text = str(rec(input, "$").text, "$.text");
  if (!text.trim()) throw new StructuredOutputError("$.text: empty");
  const anchors = parseTurnAnchors(text);
  if (!anchors.length) {
    throw new StructuredOutputError("$.text: no [Tn] anchors present");
  }
  const unknown = anchors.filter((a) => !validTurnIds.has(a));
  if (unknown.length) {
    throw new StructuredOutputError(
      `$.text: anchors reference unknown turns: ${unknown.join(", ")}`,
    );
  }
  return text;
}

// ---------------------------------------------------------------------------
// P7 — verification (decompose + judge; the pipeline re-validates quotes).
// ---------------------------------------------------------------------------

function validateClaims(input: unknown): VerifiedClaim[] {
  const claims = arr(rec(input, "$").claims, "$.claims").map((c, i) => {
    const co = rec(c, `$.claims[${i}]`);
    const verdict = str(co.verdict, `$.claims[${i}].verdict`);
    if (!VERDICTS.includes(verdict as VerificationVerdict)) {
      throw new StructuredOutputError(
        `$.claims[${i}].verdict: not one of ${VERDICTS.join("|")}`,
      );
    }
    const quote = optStr(co.quote, `$.claims[${i}].quote`);
    const turnId = optStr(co.turnId, `$.claims[${i}].turnId`);
    return {
      claim: str(co.claim, `$.claims[${i}].claim`),
      verdict: verdict as VerificationVerdict,
      ...(quote ? { quote } : {}),
      ...(turnId ? { turnId } : {}),
      critical: co.critical === true,
    };
  });
  if (!claims.length) throw new StructuredOutputError("$.claims: empty");
  return claims;
}

export async function generateVerification(
  context: string,
  summaryMarkdown: string,
): Promise<VerifiedClaim[]> {
  const instruction = `TASK: Verify the summary below claim by claim against the transcript above, then call record_verification.

- Decompose the summary into atomic factual claims, each verifiable on its own.
- Per claim: verdict SUPPORTED (fully entailed by the transcript), PARTIAL (partly supported or details off), UNSUPPORTED (no transcript support), UNCERTAIN (cannot decide).
- For every verdict except UNSUPPORTED include quote (copied EXACTLY from ONE single turn) and turnId.
- critical=true when the claim involves numbers/amounts/dates, action items or decisions.
- Judge strictly: a claim with a wrong number, wrong owner or flipped negation is UNSUPPORTED, not PARTIAL.

SUMMARY TO VERIFY:
${summaryMarkdown}`;

  return converseTool({
    label: "verify",
    tier: "haiku",
    context,
    instruction,
    tool: "record_verification",
    maxTokens: 8192,
    validate: validateClaims,
  });
}

/** Second-opinion pass for claims whose proposed quotes failed the fuzzy check. */
export async function rejudgeClaims(
  context: string,
  claims: string[],
): Promise<VerifiedClaim[]> {
  const instruction = `TASK: Re-judge ONLY the claims listed below against the transcript above, then call record_verification with exactly these claims, in this order.
Their previously proposed supporting quotes could not be found in the transcript. For each claim search the transcript again: if support exists, return the verdict with an EXACT single-turn quote and its turnId; if not, verdict UNSUPPORTED. Apply the same critical flag rules as always.

CLAIMS:
${claims.map((c, i) => `${i + 1}. ${c}`).join("\n")}`;

  return converseTool({
    label: "verify-rejudge",
    tier: "haiku",
    context,
    instruction,
    tool: "record_verification",
    maxTokens: 8192,
    validate: validateClaims,
  });
}

// ---------------------------------------------------------------------------
// Gate E targeted repair — regenerate only the flagged sentences.
// ---------------------------------------------------------------------------

export async function repairSummary(opts: {
  tier: ModelTier;
  context: string;
  summaryMarkdown: string;
  failedClaims: VerifiedClaim[];
  validTurnIds: ReadonlySet<string>;
}): Promise<string> {
  const instruction = `TASK: Repair the summary below, then call record_summary with the FULL corrected text.

The listed claims failed verification against the transcript above. Rewrite ONLY the sentences carrying those claims: correct each so it is fully supported by the transcript (with correct [Tn] anchors), or remove it when the transcript gives no support. Every other sentence must be preserved verbatim.

SUMMARY:
${opts.summaryMarkdown}

FAILED CLAIMS:
${opts.failedClaims.map((c) => `- ${c.claim}`).join("\n")}`;

  return converseTool({
    label: "repair",
    tier: opts.tier,
    context: opts.context,
    instruction,
    tool: "record_summary",
    maxTokens: 4096,
    validate: (input) => summaryText(input, opts.validTurnIds),
  });
}

// ---------------------------------------------------------------------------
// Q&A — summary-first routing, then the cached full-transcript path (1h TTL).
// ---------------------------------------------------------------------------

export interface RoutedAnswer {
  answer: string;
  sufficient: boolean;
}

export async function answerFromSummary(opts: {
  summaryMarkdown: string;
  extraction?: ExtractionResult;
  question: string;
}): Promise<RoutedAnswer> {
  const context = `MEETING SUMMARY AND EXTRACTION (NOT the full transcript):

SUMMARY:
${opts.summaryMarkdown}

EXTRACTION JSON:
${JSON.stringify(opts.extraction ?? null)}`;
  const instruction = `TASK: Answer the user's question, then call record_answer.
- If the summary/extraction context above is enough to answer confidently and completely: sufficient=true and answer in Spanish, keeping the [Tn] anchors of the supporting claims.
- If the question needs the full transcript (verbatim wording, details, anything the context does not cover): sufficient=false and answer="".

QUESTION: ${opts.question}`;

  return converseTool({
    label: "ask-summary",
    tier: "haiku",
    context,
    instruction,
    tool: "record_answer",
    maxTokens: 2048,
    // API-synchronous path: API Gateway HTTP APIs abandon the request at 30s.
    throttleRetries: 2,
    validate: (input) => {
      const o = rec(input, "$");
      return {
        answer: str(o.answer ?? "", "$.answer"),
        sufficient: o.sufficient === true,
      };
    },
  });
}

export async function answerFromTranscript(
  context: string,
  question: string,
): Promise<string> {
  const instruction = `TASK: Answer the user's question from the transcript above, then call record_answer with sufficient=true.
- Spanish, concise; cite the supporting [Tn] anchor(s) after each factual statement.
- If the transcript does not contain the answer, say so explicitly (still sufficient=true — the transcript is the full context).

QUESTION: ${question}`;

  return converseTool({
    label: "ask-transcript",
    tier: "haiku",
    context,
    instruction,
    tool: "record_answer",
    maxTokens: 2048,
    // 1h TTL keeps the transcript cache warm across a Q&A session (§2-P8).
    cacheTtl: "1h",
    throttleRetries: 2,
    validate: (input) => {
      const answer = str(rec(input, "$").answer, "$.answer");
      if (!answer.trim()) throw new StructuredOutputError("$.answer: empty");
      return answer;
    },
  });
}

// ---------------------------------------------------------------------------
// Legacy Q&A over v1 labeled segments (meetings ingested before the pipeline).
// ---------------------------------------------------------------------------

export async function askMeeting(
  segments: LabeledSegment[],
  question: string,
): Promise<string> {
  const transcript = segments
    .map((s) => `[${fmt(s.startTime)}] ${s.speaker}: ${s.text}`)
    .join("\n");
  const res = await sendWithBackoff(
    {
      modelId: MODEL_BY_TIER.haiku,
      system: [
        {
          text: `Respondés preguntas sobre la reunión basándote SOLO en la transcripción provista.
Si la respuesta no está en la transcripción, decílo explícitamente. Sé conciso.`,
        },
      ],
      messages: [
        {
          role: "user",
          content: [
            { text: `Transcripción:\n\n${transcript}\n\nPregunta: ${question}` },
          ],
        },
      ],
      inferenceConfig: { maxTokens: 2048, temperature: 0 },
    },
    2,
  );
  const block = res.output?.message?.content?.find((c) => "text" in c);
  return block && "text" in block ? (block.text ?? "") : "";
}
