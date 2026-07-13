import { test } from "node:test";
import assert from "node:assert/strict";
import { parseRefs, resolveCitations } from "./citations.js";
import type { QueryHit } from "./vectorstore.js";

function meetingHit(
  meetingId: string,
  extra: Record<string, unknown> = {},
): QueryHit {
  return {
    key: `${meetingId}#c1`,
    metadata: {
      type: "meeting",
      meetingId,
      title: "Reunión semanal",
      dateEpoch: 1735689600,
      ...extra,
    },
  };
}

function noteHit(noteId: string, extra: Record<string, unknown> = {}): QueryHit {
  return {
    key: `note#${noteId}`,
    metadata: {
      type: "note",
      noteId,
      title: "Nota de ideas",
      dateEpoch: 1735689600,
      ...extra,
    },
  };
}

test("parseRefs extracts meeting and note refs in appearance order", () => {
  const refs = parseRefs("Visto en [M:mtg-1:T3] y luego [N:note.a] y [M:mtg_2:T10].");
  assert.deepEqual(refs, [
    { ref: "M:mtg-1:T3", kind: "meeting", id: "mtg-1", turnId: "T3" },
    { ref: "N:note.a", kind: "note", id: "note.a" },
    { ref: "M:mtg_2:T10", kind: "meeting", id: "mtg_2", turnId: "T10" },
  ]);
});

test("parseRefs dedupes repeated refs keeping first appearance", () => {
  const refs = parseRefs("[N:a] x [M:m1:T1] y [N:a] z [M:m1:T1]");
  assert.deepEqual(refs.map((r) => r.ref), ["N:a", "M:m1:T1"]);
});

test("parseRefs ignores malformed markers", () => {
  const refs = parseRefs("[M:m1] [N:] [M:m1:3] [X:m1:T1] [M:a b:T1]");
  assert.deepEqual(refs, []);
});

test("parseRefs returns empty for empty answer", () => {
  assert.deepEqual(parseRefs(""), []);
});

test("resolveCitations resolves meeting ref against any hit with same meetingId regardless of turn", () => {
  const { answerMd, citations } = resolveCitations(
    "Se decidió el plan [M:m1:T7].",
    [meetingHit("m1", { turnStart: "T2", turnEnd: "T4" })],
  );
  assert.equal(answerMd, "Se decidió el plan [M:m1:T7].");
  assert.deepEqual(citations, [
    {
      ref: "M:m1:T7",
      kind: "meeting",
      id: "m1",
      turnId: "T7",
      title: "Reunión semanal",
      date: "2025-01-01",
      url: "/meeting?id=m1&turn=T7",
    },
  ]);
});

test("resolveCitations builds note url without turn param", () => {
  const { citations } = resolveCitations("Idea previa [N:n1].", [noteHit("n1")]);
  assert.equal(citations.length, 1);
  assert.equal(citations[0]?.url, "/notes?id=n1");
  assert.equal(citations[0]?.turnId, undefined);
});

test("resolveCitations strips unresolvable refs and collapses leftover spaces", () => {
  const { answerMd, citations } = resolveCitations(
    "Dato real [M:m1:T1] y dato inventado [M:ghost:T9] final.",
    [meetingHit("m1")],
  );
  assert.equal(answerMd, "Dato real [M:m1:T1] y dato inventado final.");
  assert.deepEqual(citations.map((c) => c.ref), ["M:m1:T1"]);
});

test("resolveCitations strips every occurrence of an unresolvable ref", () => {
  const { answerMd, citations } = resolveCitations(
    "[N:ghost] antes y [N:ghost] después.",
    [],
  );
  assert.equal(answerMd, "antes y después.");
  assert.deepEqual(citations, []);
});

test("resolveCitations dedupes citations by ref", () => {
  const { citations } = resolveCitations(
    "Primero [M:m1:T1], luego otra vez [M:m1:T1].",
    [meetingHit("m1")],
  );
  assert.equal(citations.length, 1);
});

test("same meeting cited at different turns yields distinct citations", () => {
  const { citations } = resolveCitations("[M:m1:T1] y [M:m1:T5]", [meetingHit("m1")]);
  assert.deepEqual(citations.map((c) => c.url), [
    "/meeting?id=m1&turn=T1",
    "/meeting?id=m1&turn=T5",
  ]);
});

test("note ref does not resolve against a meeting hit with same id", () => {
  const { answerMd, citations } = resolveCitations(
    "Según [N:m1] esto pasó.",
    [meetingHit("m1")],
  );
  assert.equal(answerMd, "Según esto pasó.");
  assert.deepEqual(citations, []);
});

test("note ref does not resolve when hit has noteId but type is not note", () => {
  const { citations } = resolveCitations("[N:n1]", [
    { key: "k", metadata: { type: "meeting", noteId: "n1", title: "x" } },
  ]);
  assert.deepEqual(citations, []);
});

test("resolveCitations omits date when dateEpoch is missing", () => {
  const hit = noteHit("n1");
  delete hit.metadata["dateEpoch"];
  const { citations } = resolveCitations("[N:n1]", [hit]);
  assert.equal(citations[0]?.date, undefined);
});

test("resolveCitations coerces missing title to empty string", () => {
  const hit = meetingHit("m1");
  delete hit.metadata["title"];
  const { citations } = resolveCitations("[M:m1:T1]", [hit]);
  assert.equal(citations[0]?.title, "");
});

test("resolveCitations handles empty answer", () => {
  assert.deepEqual(resolveCitations("", [meetingHit("m1")]), {
    answerMd: "",
    citations: [],
  });
});
