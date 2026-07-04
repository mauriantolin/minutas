import type {
  DiarizedSegment,
  LabeledSegment,
  SpeakerTimelineEntry,
} from "./types.js";

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
