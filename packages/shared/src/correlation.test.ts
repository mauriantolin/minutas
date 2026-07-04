import { test } from "node:test";
import assert from "node:assert/strict";
import { correlateSpeakers } from "./correlation.js";
import type { DiarizedSegment, SpeakerTimelineEntry } from "./types.js";

const timeline: SpeakerTimelineEntry[] = [
  { t: 0, participantName: "Juan Pérez" },
  { t: 10, participantName: "María López" },
  { t: 20, participantName: "Juan Pérez" },
  { t: 30, participantName: "María López" },
];

test("mic segments resolve to the local user", () => {
  const segments: DiarizedSegment[] = [
    { source: "mic", speakerLabel: "spk_0", startTime: 2, endTime: 5, text: "hola" },
  ];
  const [seg] = correlateSpeakers(segments, timeline, "Mauricio");
  assert.equal(seg?.speaker, "Mauricio");
  assert.equal(seg?.resolved, true);
});

test("tab segments map to the active speaker by time overlap", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 1, endTime: 8, text: "punto A" },
    { source: "tab", speakerLabel: "spk_1", startTime: 11, endTime: 18, text: "punto B" },
  ];
  const result = correlateSpeakers(segments, timeline, "Mauricio");
  assert.equal(result[0]?.speaker, "Juan Pérez");
  assert.equal(result[1]?.speaker, "María López");
  assert.ok(result.every((s) => s.resolved));
});

test("per-label votes are aggregated across segments for consistency", () => {
  // spk_0 overlaps Juan for 7s (0-7) and María for 2s (10-12) → should resolve to Juan.
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 0, endTime: 7, text: "largo" },
    { source: "tab", speakerLabel: "spk_0", startTime: 10, endTime: 12, text: "corto" },
  ];
  const result = correlateSpeakers(segments, timeline, "Mauricio");
  assert.ok(result.every((s) => s.speaker === "Juan Pérez"));
});

test("segments with no timeline overlap fall back to the raw label", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_9", startTime: 100, endTime: 110, text: "fuera" },
  ];
  const [seg] = correlateSpeakers(segments, timeline, "Mauricio");
  assert.equal(seg?.speaker, "spk_9");
  assert.equal(seg?.resolved, false);
});
