import { test } from "node:test";
import assert from "node:assert/strict";
import { correlateSpeakers, correlateSpeakersV2 } from "./correlation.js";
import { findQuote, quoteExists, textOverlapScore } from "./fuzzy.js";
import type {
  CaptionEvent,
  DiarizedSegment,
  SpeakerTimelineEntry,
} from "./types.js";

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

// --- correlateSpeakersV2 ----------------------------------------------------

test("v2: mic segments stay hard-labeled as the local user", () => {
  const segments: DiarizedSegment[] = [
    { source: "mic", speakerLabel: "spk_0", startTime: 2, endTime: 5, text: "hola" },
  ];
  const { segments: out } = correlateSpeakersV2({
    segments,
    speakerTimeline: timeline,
    localUserName: "Mauricio",
  });
  assert.equal(out[0]?.speaker, "Mauricio");
  assert.equal(out[0]?.labelSource, "mic");
  assert.equal(out[0]?.speakerConfidence, 1);
  assert.equal(out[0]?.labelMargin, 1);
});

test("v2: caption anchor wins over the active-speaker ring", () => {
  // The ring shows Juan the whole time; the caption for the same words says María.
  const ringOnlyJuan: SpeakerTimelineEntry[] = [
    { t: 0, participantName: "Juan Pérez" },
    { t: 60, participantName: "Juan Pérez" },
  ];
  const segments: DiarizedSegment[] = [
    {
      source: "tab",
      speakerLabel: "spk_0",
      startTime: 10,
      endTime: 15,
      text: "revisemos el presupuesto del tercer trimestre",
    },
  ];
  const captionTimeline: CaptionEvent[] = [
    {
      t: 11,
      speakerName: "María López",
      text: "Revisemos el presupuesto del tercer trimestre.",
      final: true,
    },
    { t: 12, speakerName: "Pedro Gómez", text: "tema totalmente distinto", final: true },
    { t: 13, speakerName: "Ana Ruiz", text: "revisemos el presupuesto", final: false },
  ];
  const { segments: out } = correlateSpeakersV2({
    segments,
    speakerTimeline: ringOnlyJuan,
    captionTimeline,
    localUserName: "Mauricio",
  });
  assert.equal(out[0]?.speaker, "María López");
  assert.equal(out[0]?.labelSource, "caption");
  assert.ok(out[0]!.speakerConfidence >= 0.5);
});

test("v2: windowed voting resolves recycled labels per window", () => {
  // Transcribe recycles spk_0 across two different people; the meeting-global
  // argmax would label both with Juan (more total overlap).
  const tl: SpeakerTimelineEntry[] = [
    { t: 0, participantName: "Juan Pérez" },
    { t: 100, participantName: "María López" },
    { t: 200, participantName: "María López" },
  ];
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 10, endTime: 25, text: "a" },
    { source: "tab", speakerLabel: "spk_0", startTime: 150, endTime: 160, text: "b" },
  ];
  const v1 = correlateSpeakers(segments, tl, "Mauricio");
  assert.equal(v1[1]?.speaker, "Juan Pérez");

  const { segments: out } = correlateSpeakersV2({
    segments,
    speakerTimeline: tl,
    localUserName: "Mauricio",
  });
  assert.equal(out[0]?.speaker, "Juan Pérez");
  assert.equal(out[1]?.speaker, "María López");
  assert.equal(out[1]?.labelSource, "timeline");
});

test("v2: emits stable segIds, numeric margins and unresolvedPct", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 1, endTime: 8, text: "punto A", confidence: 0.9 },
    { source: "tab", speakerLabel: "spk_9", startTime: 500, endTime: 510, text: "fuera" },
  ];
  const { segments: out, scores } = correlateSpeakersV2({
    segments,
    speakerTimeline: timeline,
    localUserName: "Mauricio",
  });
  assert.deepEqual(out.map((s) => s.segId), ["s0", "s1"]);
  assert.equal(out[0]?.asrConfidence, 0.9);
  assert.equal(out[1]?.labelSource, "unresolved");
  assert.equal(out[1]?.resolved, false);
  assert.equal(out[1]?.speakerConfidence, 0);
  assert.equal(scores.unresolvedPct, 50);
  assert.ok(scores.labelMarginMin >= 0 && scores.labelMarginMin <= 1);
  assert.equal(scores.captionAgreementPct, undefined);
});

test("v2: captionAgreementPct measures ring agreement with caption truth", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 1, endTime: 8, text: "estado del proyecto" },
  ];
  const captionTimeline: CaptionEvent[] = [
    { t: 2, speakerName: "Juan Pérez", text: "estado del proyecto", final: true },
  ];
  const { scores } = correlateSpeakersV2({
    segments,
    speakerTimeline: timeline,
    captionTimeline,
    localUserName: "Mauricio",
  });
  assert.equal(scores.captionAgreementPct, 100);
});

test("v2: short backchannel captions cannot hijack the anchor", () => {
  const segments: DiarizedSegment[] = [
    {
      source: "tab",
      speakerLabel: "spk_0",
      startTime: 8,
      endTime: 14,
      text: "creo que si avanzamos con el presupuesto la semana que viene",
    },
  ];
  const captionTimeline: CaptionEvent[] = [
    // Listener backchannel first so a tie would rank it on insertion order.
    { t: 9.5, speakerName: "María López", text: "Sí.", final: true },
    {
      t: 10,
      speakerName: "Juan Pérez",
      text: "Creo que si avanzamos con el presupuesto la semana que viene.",
      final: true,
    },
  ];
  const { segments: out } = correlateSpeakersV2({
    segments,
    speakerTimeline: [],
    captionTimeline,
    localUserName: "Mauricio",
  });
  assert.equal(out[0]?.speaker, "Juan Pérez");
  assert.equal(out[0]?.labelSource, "caption");
});

test("v2: unattributed sentinel captions never anchor", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 1, endTime: 8, text: "estado general del proyecto" },
  ];
  const captionTimeline: CaptionEvent[] = [
    { t: 2, speakerName: "Unknown", text: "estado general del proyecto", final: true },
  ];
  const { segments: out } = correlateSpeakersV2({
    segments,
    speakerTimeline: timeline,
    captionTimeline,
    localUserName: "Mauricio",
  });
  assert.notEqual(out[0]?.speaker, "Unknown");
  assert.equal(out[0]?.labelSource, "timeline");
});

test("v2: a caption-anchor tie surfaces in labelMarginMin for Gate A", () => {
  const segments: DiarizedSegment[] = [
    { source: "tab", speakerLabel: "spk_0", startTime: 0, endTime: 5, text: "revisemos el presupuesto" },
  ];
  const captionTimeline: CaptionEvent[] = [
    { t: 1, speakerName: "Juan Pérez", text: "revisemos el presupuesto", final: true },
    { t: 2, speakerName: "María López", text: "revisemos el presupuesto", final: true },
  ];
  const { segments: out, scores } = correlateSpeakersV2({
    segments,
    speakerTimeline: [],
    captionTimeline,
    localUserName: "Mauricio",
  });
  assert.equal(out[0]?.labelSource, "caption");
  assert.equal(out[0]?.labelMargin, 0);
  assert.equal(scores.labelMarginMin, 0);
});

// --- fuzzy quote matching ---------------------------------------------------

test("quoteExists ignores case, accents and punctuation", () => {
  assert.ok(
    quoteExists("revisemos el presupuesto", "Bien. ¡Revisémos el presupuesto ahora!"),
  );
});

test("quoteExists tolerates small ASR insertions inside the quote span", () => {
  assert.ok(
    quoteExists("el presupuesto sube veinte", "dijo que el presupuesto sube un veinte por ciento"),
  );
});

test("quoteExists rejects text not present in the transcript", () => {
  assert.ok(!quoteExists("aumentaremos el precio", "revisemos el presupuesto del proyecto"));
});

test("findQuote returns the turn holding the quote", () => {
  const turns = [
    { id: "T1", text: "Arrancamos con el estado general del equipo." },
    { id: "T2", text: "El presupuesto sube un veinte por ciento el próximo mes." },
  ];
  const match = findQuote("sube un veinte por ciento", turns);
  assert.equal(match?.turnId, "T2");
  assert.ok(match!.score >= 0.8);
  assert.equal(findQuote("bajamos el precio a la mitad", turns), undefined);
});

test("tokenContainment fast path is token-aligned, not raw substring", () => {
  assert.ok(!quoteExists("ok", "el broker confirmó la operación"));
  assert.ok(!quoteExists("si", "así avanzamos con el plan"));
});

test("textOverlapScore is symmetric on partial utterances", () => {
  const score = textOverlapScore(
    "revisemos el presupuesto",
    "revisemos el presupuesto del tercer trimestre por favor",
  );
  assert.equal(score, 1);
});
