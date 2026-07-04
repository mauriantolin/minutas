import type {
  CaptionEvent,
  CorrelatedSegment,
  CorrelationResult,
  CorrelationScores,
  DiarizedSegment,
  LabeledSegment,
  SpeakerLabelSource,
  SpeakerTimelineEntry,
} from "./types.js";
import { textOverlapScore, tokenize } from "./fuzzy.js";

/**
 * Maps diarized segments to real participant names.
 *
 * Two sources feed this:
 *  - `mic` segments are the local user by definition → labeled with `localUserName`.
 *  - `tab` segments carry Transcribe's opaque speaker labels ("spk_0", …). Their real
 *    name is recovered by correlating each segment's time window against the
 *    active-speaker timeline scraped from the Teams DOM.
 *
 * Robustness: per-label votes are aggregated across the whole meeting, so a label whose
 * individual segments are ambiguous still resolves to the name it overlapped most overall.
 */
export function correlateSpeakers(
  segments: DiarizedSegment[],
  timeline: SpeakerTimelineEntry[],
  localUserName: string,
): LabeledSegment[] {
  const intervals = buildActiveIntervals(timeline);

  // Pass 1: tally, per tab speaker label, how long it overlapped each candidate name.
  const votesByLabel = new Map<string, Map<string, number>>();
  for (const seg of segments) {
    if (seg.source === "mic") continue;
    const overlaps = overlapByName(seg.startTime, seg.endTime, intervals);
    const tally = votesByLabel.get(seg.speakerLabel) ?? new Map<string, number>();
    for (const [name, dur] of overlaps) {
      tally.set(name, (tally.get(name) ?? 0) + dur);
    }
    votesByLabel.set(seg.speakerLabel, tally);
  }

  const nameByLabel = new Map<string, string>();
  for (const [label, tally] of votesByLabel) {
    const winner = argmax(tally);
    if (winner) nameByLabel.set(label, winner);
  }

  // Pass 2: emit labeled segments.
  return segments.map((seg) => {
    if (seg.source === "mic") {
      return toLabeled(seg, localUserName, true);
    }
    const name = nameByLabel.get(seg.speakerLabel);
    return name
      ? toLabeled(seg, name, true)
      : toLabeled(seg, seg.speakerLabel, false);
  });
}

export interface CorrelateV2Input {
  segments: DiarizedSegment[];
  speakerTimeline: SpeakerTimelineEntry[];
  captionTimeline?: CaptionEvent[];
  localUserName: string;
}

/** A caption may lag/lead its segment by this much and still anchor it. */
const CAPTION_TIME_SLACK_S = 5;
/** Minimum caption↔segment text overlap for a caption anchor to hold. */
const CAPTION_MATCH_MIN = 0.5;
/**
 * Captions shorter than this can't anchor: backchannels ("Sí.", "ok") from a
 * listener trivially reach a perfect overlap score against the true speaker's
 * segment and would hijack the label.
 */
const CAPTION_ANCHOR_MIN_TOKENS = 3;
/** Adapter sentinel for captions whose author node was never found. */
const UNATTRIBUTED_SPEAKER = "Unknown";
/** Half-width of the voting window around a segment (label-recycling killer). */
const VOTE_WINDOW_S = 30;

/**
 * Correlation v2 (P2): stable segIds, caption anchors as primary signal,
 * windowed voting against the active-speaker timeline as fallback, numeric
 * per-segment confidence/margin, and the Gate A score inputs.
 *
 * segIds are `s{n}` in raw-payload array order — raw-payload.json is durable
 * and order-stable, so ids are identical on every reprocess.
 */
export function correlateSpeakersV2(input: CorrelateV2Input): CorrelationResult {
  const { segments, speakerTimeline, localUserName } = input;
  const captions = (input.captionTimeline ?? []).filter((c) => c.final);
  const intervals = buildActiveIntervals(speakerTimeline);

  const out: CorrelatedSegment[] = [];
  let labelMarginMin = 1;
  let captionChecked = 0;
  let captionAgreed = 0;

  segments.forEach((seg, i) => {
    const segId = `s${i}`;
    if (seg.source === "mic") {
      out.push(toCorrelated(seg, segId, localUserName, 1, 1, "mic"));
      return;
    }

    const anchor = bestCaptionAnchor(seg, captions);
    const vote = windowedVote(seg, segments, intervals);

    if (anchor) {
      // Agreement measures how well the fallback ring signal tracks caption truth.
      if (vote) {
        captionChecked++;
        if (vote.name === anchor.name) captionAgreed++;
      }
      // Anchor margins feed Gate A too — a caption tie is exactly the kind of
      // ambiguity the gate exists to catch.
      labelMarginMin = Math.min(labelMarginMin, anchor.margin);
      out.push(
        toCorrelated(seg, segId, anchor.name, anchor.score, anchor.margin, "caption"),
      );
      return;
    }

    if (vote) {
      labelMarginMin = Math.min(labelMarginMin, vote.margin);
      out.push(
        toCorrelated(seg, segId, vote.name, vote.share, vote.margin, "timeline"),
      );
      return;
    }

    out.push(toCorrelated(seg, segId, seg.speakerLabel, 0, 0, "unresolved"));
  });

  const unresolved = out.filter((s) => s.labelSource === "unresolved").length;
  const scores: CorrelationScores = {
    labelMarginMin,
    unresolvedPct: out.length ? (unresolved / out.length) * 100 : 0,
    ...(captionChecked > 0
      ? { captionAgreementPct: (captionAgreed / captionChecked) * 100 }
      : {}),
  };
  return { segments: out, scores };
}

interface CaptionAnchor {
  name: string;
  score: number;
  margin: number;
}

function bestCaptionAnchor(
  seg: DiarizedSegment,
  captions: CaptionEvent[],
): CaptionAnchor | undefined {
  const bySpeaker = new Map<string, number>();
  for (const cap of captions) {
    if (
      cap.t < seg.startTime - CAPTION_TIME_SLACK_S ||
      cap.t > seg.endTime + CAPTION_TIME_SLACK_S
    ) {
      continue;
    }
    // Sentinel-authored captions (legacy checkpoints) must fall through to the
    // windowed vote instead of anchoring segments to a fake name.
    if (cap.speakerName === UNATTRIBUTED_SPEAKER) continue;
    if (tokenize(cap.text).length < CAPTION_ANCHOR_MIN_TOKENS) continue;
    const score = textOverlapScore(cap.text, seg.text);
    if (score > (bySpeaker.get(cap.speakerName) ?? 0)) {
      bySpeaker.set(cap.speakerName, score);
    }
  }

  const ranked = [...bySpeaker.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top || top[1] < CAPTION_MATCH_MIN) return undefined;
  const rival = ranked[1]?.[1] ?? 0;
  return { name: top[0], score: top[1], margin: top[1] - rival };
}

interface VoteResult {
  name: string;
  /** Winner's share of the window's votes, 0–1. */
  share: number;
  /** (winner − runner-up) / total, 0–1. */
  margin: number;
}

/**
 * Tallies the segment's label against the active-speaker timeline inside a
 * window around the segment — a label is resolved per window, not per meeting,
 * so a label Transcribe recycles across speakers stops poisoning the vote.
 */
function windowedVote(
  seg: DiarizedSegment,
  segments: DiarizedSegment[],
  intervals: ActiveInterval[],
): VoteResult | undefined {
  const winStart = seg.startTime - VOTE_WINDOW_S;
  const winEnd = seg.endTime + VOTE_WINDOW_S;
  const tally = new Map<string, number>();
  for (const s of segments) {
    if (s.source === "mic" || s.speakerLabel !== seg.speakerLabel) continue;
    if (s.endTime < winStart || s.startTime > winEnd) continue;
    for (const [name, dur] of overlapByName(s.startTime, s.endTime, intervals)) {
      tally.set(name, (tally.get(name) ?? 0) + dur);
    }
  }

  const ranked = [...tally.entries()].sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  if (!top) return undefined;
  const total = ranked.reduce((acc, [, v]) => acc + v, 0);
  const runnerUp = ranked[1]?.[1] ?? 0;
  return {
    name: top[0],
    share: top[1] / total,
    margin: (top[1] - runnerUp) / total,
  };
}

function toCorrelated(
  seg: DiarizedSegment,
  segId: string,
  speaker: string,
  speakerConfidence: number,
  labelMargin: number,
  labelSource: SpeakerLabelSource,
): CorrelatedSegment {
  return {
    segId,
    source: seg.source,
    speaker,
    resolved: labelSource !== "unresolved",
    startTime: seg.startTime,
    endTime: seg.endTime,
    text: seg.text,
    speakerConfidence,
    labelMargin,
    labelSource,
    ...(seg.confidence !== undefined ? { asrConfidence: seg.confidence } : {}),
  };
}

interface ActiveInterval {
  start: number;
  end: number;
  name: string;
}

/**
 * Turns a series of point-in-time active-speaker readings into intervals, assuming each
 * reading holds until the next one. The last reading is dropped (no known end).
 */
function buildActiveIntervals(
  timeline: SpeakerTimelineEntry[],
): ActiveInterval[] {
  const sorted = [...timeline].sort((a, b) => a.t - b.t);
  const intervals: ActiveInterval[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const cur = sorted[i]!;
    const next = sorted[i + 1]!;
    if (next.t > cur.t) {
      intervals.push({ start: cur.t, end: next.t, name: cur.participantName });
    }
  }
  return intervals;
}

function overlapByName(
  start: number,
  end: number,
  intervals: ActiveInterval[],
): Map<string, number> {
  const out = new Map<string, number>();
  for (const iv of intervals) {
    const lo = Math.max(start, iv.start);
    const hi = Math.min(end, iv.end);
    if (hi > lo) out.set(iv.name, (out.get(iv.name) ?? 0) + (hi - lo));
  }
  return out;
}

function argmax(tally: Map<string, number>): string | undefined {
  let best: string | undefined;
  let bestVal = 0;
  for (const [name, val] of tally) {
    if (val > bestVal) {
      bestVal = val;
      best = name;
    }
  }
  return best;
}

function toLabeled(
  seg: DiarizedSegment,
  speaker: string,
  resolved: boolean,
): LabeledSegment {
  return {
    speaker,
    resolved,
    startTime: seg.startTime,
    endTime: seg.endTime,
    text: seg.text,
  };
}
