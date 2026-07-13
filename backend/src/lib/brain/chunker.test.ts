import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkMeeting, chunkNote, type BrainChunk } from "./chunker.js";
import type {
  CleanTranscript,
  ExtractionResult,
  Meeting,
  MeetingSummary,
  Note,
  SummaryArtifact,
} from "@teams-agent-core/shared";

const FRASE =
  "Necesitamos revisar el presupuesto del tercer trimestre porque los costos de infraestructura subieron más de lo previsto y todavía falta definir prioridades claras con el equipo.";
const largo = () => Array(4).fill(FRASE).join(" ");

const meeting: Meeting & { summary?: MeetingSummary } = {
  tenantId: "acme",
  meetingId: "m-123",
  title: "Kickoff Q3",
  startedAt: "2026-07-01T14:00:00Z",
  endedAt: "2026-07-01T15:00:00Z",
  participants: [{ name: "Ana García" }, { name: "Bruno Díaz" }],
  status: "ready",
  summary: {
    summary: "Se revisó el presupuesto del tercer trimestre.",
    keyPoints: ["Presupuesto sube 10%", "Plan definitivo el viernes"],
    actionItems: [{ text: "Enviar el plan", owner: "Ana García" }],
  },
};

const clean: CleanTranscript = {
  turns: [
    {
      id: "T1",
      sourceIds: ["s1"],
      speaker: "Ana García",
      startTime: 0,
      endTime: 20,
      text: "Buenas, arrancamos en un minuto cuando se conecten todos.",
      tags: [],
    },
    ...["T2", "T3", "T4", "T5", "T6"].map((id, i) => ({
      id,
      sourceIds: [`s${i + 2}`],
      speaker: i % 2 === 0 ? "Ana García" : "Bruno Díaz",
      startTime: 30 + i * 30,
      endTime: 60 + i * 30,
      text: largo(),
      tags: [],
    })),
    {
      id: "T7",
      sourceIds: ["s7"],
      speaker: "Bruno Díaz",
      startTime: 400,
      endTime: 420,
      text: "Perfecto, entonces cerramos con esos acuerdos y seguimos por mail.",
      tags: [],
    },
    {
      id: "T8",
      sourceIds: ["s8"],
      speaker: "Ana García",
      startTime: 420,
      endTime: 440,
      text: "Dale, mando la minuta hoy mismo. Gracias a todos.",
      tags: [],
    },
  ],
  chapters: [
    { startTime: 30, title: "Presupuesto y plazos" },
    { startTime: 400, title: "Próximos pasos" },
  ],
};

const extraction: ExtractionResult = {
  decisions: [
    {
      text: "Subir el presupuesto un 10%",
      verbatimQuote: "subimos el presupuesto un diez por ciento",
      turnId: "T3",
      inferred: false,
    },
    { text: "   ", verbatimQuote: "n/a", turnId: "T4", inferred: true },
  ],
  actionItems: [
    {
      text: "Enviar el plan definitivo el viernes",
      verbatimQuote: "yo mando el plan el viernes",
      turnId: "T4",
      inferred: false,
      owner: "Ana García",
      done: false,
    },
  ],
  openQuestions: [
    {
      text: "Falta confirmar el proveedor de infraestructura",
      verbatimQuote: "¿con qué proveedor cerramos al final?",
      turnId: "T5",
      inferred: false,
    },
  ],
  keyNumbers: [
    {
      text: "Costos de infraestructura subieron 18%",
      verbatimQuote: "los costos subieron dieciocho por ciento",
      turnId: "T3",
      inferred: false,
    },
  ],
  participants: ["Ana García", "Bruno Díaz"],
};

const summary: SummaryArtifact = {
  text: `Reunión de kickoff con foco en presupuesto y plazos [T2].

## Presupuesto
Se acordó subir el presupuesto un 10% para cubrir infraestructura [T3].

## Próximos pasos
Ana envía el plan definitivo el viernes [T4].`,
  anchoredTurnIds: ["T2", "T3", "T4"],
  tier: "haiku",
};

const allChunks = () => chunkMeeting(meeting, { extraction, clean, summary });
const byKey = (chunks: BrainChunk[]) => new Map(chunks.map((c) => [c.key, c]));
const bodyOf = (c: BrainChunk) => c.text.slice(c.text.indexOf("\n\n") + 2);
const tokens = (s: string) => Math.ceil(s.length / 4);

test("extraction micro-chunks: one per item, all four kinds, exact template", () => {
  const map = byKey(allChunks());
  const dec = map.get("m-123#ex#dec#0");
  assert.ok(dec);
  assert.equal(
    dec.text,
    'Decisión (2026-07-01, reunión "Kickoff Q3"): Subir el presupuesto un 10% — cita: "subimos el presupuesto un diez por ciento" [T3]',
  );
  assert.equal(dec.metadata.type, "extraction");
  assert.equal(dec.metadata.turnStart, "T3");

  const act = map.get("m-123#ex#act#0");
  assert.ok(act);
  assert.ok(act.text.startsWith('Tarea (2026-07-01, reunión "Kickoff Q3"): '));
  assert.ok(act.text.endsWith("[T4]"));

  const opq = map.get("m-123#ex#opq#0");
  assert.ok(opq);
  assert.ok(opq.text.startsWith("Pregunta abierta ("));

  const num = map.get("m-123#ex#num#0");
  assert.ok(num);
  assert.ok(num.text.startsWith("Cifra clave ("));
});

test("extraction items with empty text are skipped", () => {
  const chunks = allChunks();
  assert.equal(chunks.filter((c) => c.key.includes("#ex#dec#")).length, 1);
  assert.ok(!byKey(chunks).has("m-123#ex#dec#1"));
});

test("chapter windows: global counter keys, synthetic Inicio, header and [Tn] lines", () => {
  const chunks = allChunks().filter((c) => c.metadata.type === "chapter");
  assert.deepEqual(
    chunks.map((c) => c.key),
    ["m-123#ch#0", "m-123#ch#1", "m-123#ch#2", "m-123#ch#3"],
  );

  const inicio = chunks[0];
  assert.ok(inicio);
  assert.equal(inicio.metadata.chapterTitle, "Inicio");
  assert.ok(
    inicio.text.startsWith('Reunión: "Kickoff Q3" — 2026-07-01 — Capítulo: "Inicio"\n\n'),
  );
  assert.ok(inicio.text.includes("[T1] Ana García: "));

  for (const c of chunks) {
    assert.ok(
      c.text.startsWith('Reunión: "Kickoff Q3" — 2026-07-01 — Capítulo: "'),
      `header missing in ${c.key}`,
    );
  }

  const last = chunks[3];
  assert.ok(last);
  assert.equal(last.metadata.chapterTitle, "Próximos pasos");
  assert.ok(last.text.includes("[T7] Bruno Díaz: "));
  assert.ok(last.text.includes("[T8] Ana García: "));
  assert.equal(last.metadata.turnStart, "T7");
  assert.equal(last.metadata.turnEnd, "T8");
});

test("long chapter splits into windows with 1-turn overlap and token bounds", () => {
  const windows = allChunks().filter(
    (c) => c.metadata.chapterTitle === "Presupuesto y plazos",
  );
  assert.equal(windows.length, 2);
  const [w1, w2] = windows;
  assert.ok(w1 && w2);

  assert.equal(w1.metadata.turnStart, "T2");
  assert.equal(w1.metadata.turnEnd, w2.metadata.turnStart);
  const overlapId = w1.metadata.turnEnd;
  assert.ok(overlapId);
  assert.ok(w1.text.includes(`[${overlapId}]`));
  assert.ok(w2.text.includes(`[${overlapId}]`));
  assert.equal(w2.metadata.turnEnd, "T6");

  for (const w of windows) {
    const t = tokens(bodyOf(w));
    assert.ok(t <= 700, `${w.key} body ${t} tokens > 700`);
    assert.ok(t >= 300, `${w.key} body ${t} tokens < 300`);
  }
});

test("summary splits on H2 keeping heading with section; preamble is chunk 0", () => {
  const chunks = allChunks().filter((c) => c.metadata.type === "summary");
  assert.deepEqual(
    chunks.map((c) => c.key),
    ["m-123#sum#0", "m-123#sum#1", "m-123#sum#2"],
  );
  const header = 'Resumen de reunión "Kickoff Q3" — 2026-07-01\n\n';
  for (const c of chunks) assert.ok(c.text.startsWith(header));

  const [pre, s1, s2] = chunks;
  assert.ok(pre && s1 && s2);
  assert.ok(bodyOf(pre).startsWith("Reunión de kickoff"));
  assert.ok(bodyOf(pre).includes("[T2]"));
  assert.ok(bodyOf(s1).startsWith("## Presupuesto"));
  assert.ok(bodyOf(s1).includes("[T3]"));
  assert.ok(bodyOf(s2).startsWith("## Próximos pasos"));
});

test("digest: single chunk with title, date, participants and keyPoints", () => {
  const dig = byKey(allChunks()).get("m-123#dig");
  assert.ok(dig);
  assert.equal(dig.metadata.type, "digest");
  assert.ok(dig.text.includes('"Kickoff Q3"'));
  assert.ok(dig.text.includes("2026-07-01"));
  assert.ok(dig.text.includes("Ana García"));
  assert.ok(dig.text.includes("Bruno Díaz"));
  assert.ok(dig.text.includes("- Presupuesto sube 10%"));
  assert.ok(dig.text.includes("- Plan definitivo el viernes"));
});

test("meeting chunk metadata: dateEpoch, embedVersion, meetingId, no ownerSub", () => {
  const expectedEpoch = Math.floor(Date.parse(meeting.startedAt) / 1000);
  for (const c of allChunks()) {
    assert.equal(c.metadata.meetingId, "m-123");
    assert.equal(c.metadata.dateEpoch, expectedEpoch);
    assert.equal(c.metadata.embedVersion, "titan-v2-1024");
    assert.equal(c.metadata.title, "Kickoff Q3");
    assert.equal(c.metadata.ownerSub, undefined);
    assert.equal(c.metadata.noteId, undefined);
  }
});

test("missing artifacts still produce the digest chunk only", () => {
  const chunks = chunkMeeting(meeting, {});
  assert.equal(chunks.length, 1);
  assert.equal(chunks[0]?.key, "m-123#dig");
});

const note: Note = {
  tenantId: "acme",
  noteId: "01J0NOTEULIDXXXXXXXXXXXXXX",
  ownerSub: "user-sub-1",
  title: "Ideas de arquitectura",
  rawText: "eh bueno anoto rapido lo del cache",
  cleanText:
    "Evaluar una capa de caché delante del índice vectorial para bajar latencia y costo por consulta.",
  source: "voice",
  createdAt: "2026-07-05T10:30:00Z",
  updatedAt: "2026-07-05T10:30:00Z",
};

test("note: single chunk with header, key and owner metadata", () => {
  const chunks = chunkNote(note);
  assert.equal(chunks.length, 1);
  const c = chunks[0];
  assert.ok(c);
  assert.equal(c.key, `note#${note.noteId}#0`);
  assert.ok(
    c.text.startsWith("Nota personal — 2026-07-05 — Ideas de arquitectura\n\n"),
  );
  assert.ok(c.text.includes("capa de caché"));
  assert.equal(c.metadata.type, "note");
  assert.equal(c.metadata.noteId, note.noteId);
  assert.equal(c.metadata.ownerSub, "user-sub-1");
  assert.equal(c.metadata.title, "Ideas de arquitectura");
  assert.equal(c.metadata.dateEpoch, Math.floor(Date.parse(note.createdAt) / 1000));
  assert.equal(c.metadata.embedVersion, "titan-v2-1024");
  assert.equal(c.metadata.meetingId, undefined);
});

test("long note splits into ~650-token windows without duplicating content", () => {
  const parrafo = Array(5)
    .fill(
      "La arquitectura propuesta separa la ingesta de la consulta para que cada camino escale de forma independiente y los costos queden acotados por uso real.",
    )
    .join(" ");
  const marcado = `${parrafo} marcador-unico-parrafo-final.`;
  const longNote: Note = {
    ...note,
    cleanText: [parrafo, parrafo, parrafo, parrafo, marcado].join("\n\n"),
  };
  const chunks = chunkNote(longNote);
  assert.ok(chunks.length >= 2);
  chunks.forEach((c, n) => {
    assert.equal(c.key, `note#${note.noteId}#${n}`);
    assert.ok(c.text.startsWith("Nota personal — 2026-07-05 — "));
    assert.ok(tokens(bodyOf(c)) <= 650, `${c.key} exceeds 650 tokens`);
  });
  const joined = chunks.map(bodyOf).join("\n\n");
  assert.equal(joined.split("marcador-unico-parrafo-final").length - 1, 1);
});

test("chapter of oversized turns terminates (each turn its own window)", () => {
  // Each turn alone exceeds CHAPTER_MAX_TOKENS, so every window is a single
  // turn. The 1-turn overlap must still advance or chunking loops forever.
  const huge = Array(30).fill(FRASE).join(" ");
  const bigChapterMeeting: Meeting & { summary?: MeetingSummary } = meeting;
  const bigClean: CleanTranscript = {
    chapters: [{ startTime: 0, title: "Bloque denso" }],
    turns: ["T1", "T2", "T3", "T4"].map((id, i) => ({
      id,
      sourceIds: [`s${i + 1}`],
      speaker: "Ana García",
      startTime: i * 60,
      endTime: i * 60 + 59,
      text: huge,
      tags: [],
    })),
  };
  const chunks = chunkMeeting(bigChapterMeeting, { clean: bigClean });
  const windows = chunks.filter((c) => c.metadata.type === "chapter");
  assert.equal(windows.length, 4);
  assert.deepEqual(
    windows.map((w) => w.metadata.turnStart),
    ["T1", "T2", "T3", "T4"],
  );
});
