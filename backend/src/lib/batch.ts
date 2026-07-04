import { createHash } from "node:crypto";
import {
  StartTranscriptionJobCommand,
  TranscribeClient,
  type LanguageCode,
} from "@aws-sdk/client-transcribe";
import type {
  BatchMergeResult,
  BatchSegment,
  DiarizedSegment,
  MergedSegment,
} from "@teams-agent-core/shared";

const transcribe = new TranscribeClient({});

const BUCKET = process.env.TRANSCRIPT_BUCKET!;
// Must match the streaming capture config — a language mismatch would make the
// "quality pass" strictly worse than the text it replaces.
const LANGUAGE_CODE = process.env.TRANSCRIBE_LANGUAGE_CODE ?? "es-US";

/**
 * Transcribe job names allow only [0-9a-zA-Z._-]; meeting ids carry ISO
 * timestamps. Deterministic sanitization — the name is both the DDB token
 * lookup key and the idempotency key for SFN retries of the batchAsr state.
 * The executionArn hash makes the name unique per execution: job names are
 * permanently unique per account, and the attempt counter alone can repeat
 * (reprocess crash between StartExecution and updateMeeting) — a collision
 * with a long-finished job would swallow ConflictException below and dead-wait
 * the full 2 h task timeout on an event that never fires.
 */
export function batchJobName(
  tenantId: string,
  meetingId: string,
  attempt: number,
  executionArn: string,
): string {
  const runId = createHash("sha256").update(executionArn).digest("hex").slice(0, 8);
  const base = `${tenantId}--${meetingId}--${attempt}`
    .replace(/[^0-9a-zA-Z._-]/g, "-")
    .slice(0, 190);
  return `${base}--${runId}`;
}

/**
 * Batch re-ASR on the tab source only (doc §2-P3): mic text from streaming is
 * already speaker-known and high-confidence. No diarization — speaker mapping
 * comes from the P2 re-correlation pass over the merged transcript, so batch
 * spk_N labels would be discarded anyway.
 */
export async function startBatchTranscription(opts: {
  jobName: string;
  mediaKey: string;
  outputKey: string;
}): Promise<void> {
  try {
    await transcribe.send(
      new StartTranscriptionJobCommand({
        TranscriptionJobName: opts.jobName,
        LanguageCode: LANGUAGE_CODE as LanguageCode,
        MediaFormat: "webm",
        Media: { MediaFileUri: `s3://${BUCKET}/${opts.mediaKey}` },
        OutputBucketName: BUCKET,
        OutputKey: opts.outputKey,
      }),
    );
  } catch (err) {
    // An SFN retry after a transient failure may find the job already running —
    // the execution-suffixed name makes that the same logical job, not a dupe.
    if ((err as Error).name !== "ConflictException") throw err;
  }
}

// ---------------------------------------------------------------------------
// Batch output parsing — the Transcribe JSON is an external edge, so shape is
// validated defensively here (and nowhere downstream).
// ---------------------------------------------------------------------------

interface BatchWord {
  start: number;
  end: number;
  /** Word plus any punctuation items that followed it. */
  text: string;
  confidence: number;
}

interface TranscribeItem {
  type: "pronunciation" | "punctuation";
  start_time?: string;
  end_time?: string;
  alternatives?: { content?: string; confidence?: string }[];
}

/** Pause/length bounds for grouping words into fine-grained BatchSegments. */
const SEGMENT_GAP_S = 0.8;
const SEGMENT_MAX_WORDS = 20;
const SENTENCE_END = /[.?!…]$/;

/**
 * Parses the batch job output into fine-grained segments. Fine granularity is
 * deliberate: each BatchSegment is assigned whole to one streaming segment in
 * the merge, so smaller units mean less text bleeding across segment
 * boundaries (batch emits its own segmentation, unrelated to streaming's).
 */
export function parseBatchTranscript(output: unknown): BatchSegment[] {
  const items =
    ((output as { results?: { items?: TranscribeItem[] } }).results?.items ??
      []) as TranscribeItem[];

  const words: BatchWord[] = [];
  for (const item of items) {
    if (item.type === "punctuation") {
      const last = words[words.length - 1];
      if (last) last.text += item.alternatives?.[0]?.content ?? "";
      continue;
    }
    const content = item.alternatives?.[0]?.content;
    if (!content || item.start_time === undefined || item.end_time === undefined)
      continue;
    words.push({
      start: Number(item.start_time),
      end: Number(item.end_time),
      text: content,
      confidence: Number(item.alternatives?.[0]?.confidence ?? 0),
    });
  }

  const segments: BatchSegment[] = [];
  let group: BatchWord[] = [];
  const flush = () => {
    if (!group.length) return;
    segments.push({
      speakerLabel: "spk_0",
      startTime: group[0]!.start,
      endTime: group[group.length - 1]!.end,
      text: group.map((w) => w.text).join(" "),
      confidence:
        group.reduce((a, w) => a + w.confidence, 0) / group.length,
    });
    group = [];
  };
  for (const word of words) {
    const prev = group[group.length - 1];
    if (prev && word.start - prev.end > SEGMENT_GAP_S) flush();
    group.push(word);
    if (SENTENCE_END.test(word.text) || group.length >= SEGMENT_MAX_WORDS) {
      flush();
    }
  }
  flush();
  return segments;
}

// ---------------------------------------------------------------------------
// Merge (doc §2-P3): prefer batch text per aligned span, keep stable ids.
// ---------------------------------------------------------------------------

/** A batch segment fully in a streaming gap still merges if this close. */
const MERGE_SLACK_S = 2;

/**
 * Aligns batch segments to streaming tab segments by time overlap and prefers
 * batch text where alignment found a match. The merged array preserves the
 * raw-payload order and length, so P2 re-derives the exact same `s{n}` segIds
 * and every anchor/edit survives the merge.
 */
export function mergeBatchTranscript(
  streaming: DiarizedSegment[],
  batch: BatchSegment[],
): BatchMergeResult {
  const tabIdx = streaming
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.source === "tab");

  const assigned = new Map<number, BatchSegment[]>();
  for (const b of batch) {
    let best = -1;
    let bestOverlap = 0;
    for (const { s, i } of tabIdx) {
      const overlap =
        Math.min(s.endTime, b.endTime) - Math.max(s.startTime, b.startTime);
      if (overlap > bestOverlap) {
        best = i;
        bestOverlap = overlap;
      }
    }
    if (best === -1) {
      // Batch caught speech in a streaming gap: attach to the nearest tab
      // segment when close enough, so recovered text is kept, not dropped.
      let bestGap = MERGE_SLACK_S;
      for (const { s, i } of tabIdx) {
        const gap = Math.max(s.startTime - b.endTime, b.startTime - s.endTime);
        if (gap < bestGap) {
          best = i;
          bestGap = gap;
        }
      }
    }
    if (best === -1) continue;
    const bucket = assigned.get(best) ?? [];
    bucket.push(b);
    assigned.set(best, bucket);
  }

  const segments: MergedSegment[] = streaming.map((s, i) => {
    const hits = assigned.get(i);
    if (!hits?.length) return { ...s, segId: `s${i}`, provenance: "streaming" };
    hits.sort((a, b) => a.startTime - b.startTime);
    return {
      ...s,
      segId: `s${i}`,
      provenance: "batch",
      text: hits.map((h) => h.text).join(" "),
      confidence:
        hits.reduce((a, h) => a + h.confidence, 0) / hits.length,
    };
  });

  const batchCount = segments.filter((s) => s.provenance === "batch").length;
  return {
    segments,
    batchFraction: segments.length ? batchCount / segments.length : 0,
  };
}
