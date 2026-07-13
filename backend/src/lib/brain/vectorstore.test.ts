import { test } from "node:test";
import assert from "node:assert/strict";
import { brainQueryFilter } from "./vectorstore.js";

const SUB = "user-sub-123";

const BASE = {
  $or: [
    { type: { $ne: "note" } },
    {
      $and: [{ type: { $eq: "note" } }, { ownerSub: { $eq: SUB } }],
    },
  ],
};

function noteBranchOwnerEq(filter: Record<string, unknown>): unknown {
  const base = Array.isArray(filter["$and"])
    ? (filter["$and"][0] as Record<string, unknown>)
    : filter;
  const or = base["$or"] as Record<string, unknown>[];
  const noteBranch = or[1] as Record<string, unknown>;
  const and = noteBranch["$and"] as Record<string, unknown>[];
  const owner = and[1] as Record<string, unknown>;
  return (owner["ownerSub"] as Record<string, unknown>)["$eq"];
}

test("no opts returns exactly the base privacy clause", () => {
  assert.deepEqual(brainQueryFilter(SUB), BASE);
});

test("empty opts returns the base privacy clause", () => {
  assert.deepEqual(brainQueryFilter(SUB, {}), BASE);
});

test("types compose as $and with $in", () => {
  assert.deepEqual(brainQueryFilter(SUB, { types: ["chapter", "note"] }), {
    $and: [BASE, { type: { $in: ["chapter", "note"] } }],
  });
});

test("empty types array adds no type clause", () => {
  assert.deepEqual(brainQueryFilter(SUB, { types: [] }), BASE);
});

test("date range merges $gte and $lte into one dateEpoch object", () => {
  assert.deepEqual(
    brainQueryFilter(SUB, { dateFromEpoch: 100, dateToEpoch: 200 }),
    { $and: [BASE, { dateEpoch: { $gte: 100, $lte: 200 } }] },
  );
});

test("dateFromEpoch alone yields only $gte", () => {
  assert.deepEqual(brainQueryFilter(SUB, { dateFromEpoch: 100 }), {
    $and: [BASE, { dateEpoch: { $gte: 100 } }],
  });
});

test("dateToEpoch alone yields only $lte", () => {
  assert.deepEqual(brainQueryFilter(SUB, { dateToEpoch: 200 }), {
    $and: [BASE, { dateEpoch: { $lte: 200 } }],
  });
});

test("dateFromEpoch of 0 is kept", () => {
  assert.deepEqual(brainQueryFilter(SUB, { dateFromEpoch: 0 }), {
    $and: [BASE, { dateEpoch: { $gte: 0 } }],
  });
});

test("types and date range compose together", () => {
  assert.deepEqual(
    brainQueryFilter(SUB, {
      types: ["summary"],
      dateFromEpoch: 1,
      dateToEpoch: 2,
    }),
    {
      $and: [
        BASE,
        { type: { $in: ["summary"] } },
        { dateEpoch: { $gte: 1, $lte: 2 } },
      ],
    },
  );
});

test("note branch always pins ownerSub to the caller", () => {
  const variants = [
    brainQueryFilter(SUB),
    brainQueryFilter(SUB, { types: ["note"] }),
    brainQueryFilter(SUB, { dateFromEpoch: 1 }),
    brainQueryFilter(SUB, {
      types: ["chapter", "note"],
      dateFromEpoch: 1,
      dateToEpoch: 2,
    }),
  ];
  for (const filter of variants) {
    assert.equal(noteBranchOwnerEq(filter), SUB);
  }
});

test("different callers get different ownerSub clauses", () => {
  assert.equal(noteBranchOwnerEq(brainQueryFilter("other-sub")), "other-sub");
});
