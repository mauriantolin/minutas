import { test } from "node:test";
import assert from "node:assert/strict";
import { INDEX_VERSION, ulid, indexNameForTenant } from "./ids.js";

const CROCKFORD = /^[0-9A-HJKMNP-TV-Z]{26}$/;

test("INDEX_VERSION defaults to 1", () => {
  if (!process.env.INDEX_VERSION) assert.equal(INDEX_VERSION, 1);
});

test("ulid is 26 Crockford base32 chars", () => {
  const id = ulid();
  assert.equal(id.length, 26);
  assert.match(id, CROCKFORD);
});

test("ulid is distinct across calls", () => {
  const ids = new Set<string>();
  for (let i = 0; i < 1000; i++) ids.add(ulid());
  assert.equal(ids.size, 1000);
});

test("ulid sorts lexicographically by time", () => {
  const earlier = ulid(1_000_000_000_000);
  const later = ulid(1_700_000_000_000);
  assert.ok(earlier < later);
});

test("ulid time prefix is deterministic for a fixed timestamp", () => {
  const t = 1_720_000_000_000;
  assert.equal(ulid(t).slice(0, 10), ulid(t).slice(0, 10));
});

test("indexNameForTenant passes through a UUID sub", () => {
  const sub = "d290f1ee-6c54-4b01-90e6-d701748f0851";
  assert.equal(indexNameForTenant(sub), `tenant-${sub}-v1`);
});

test("indexNameForTenant hashes when input has uppercase", () => {
  assert.match(indexNameForTenant("Acme"), /^tenant-acme-[0-9a-f]{10}-v1$/);
});

test("indexNameForTenant hashes when input has _ or @", () => {
  assert.match(indexNameForTenant("a_b"), /^tenant-a-b-[0-9a-f]{10}-v1$/);
  assert.match(indexNameForTenant("a@b"), /^tenant-a-b-[0-9a-f]{10}-v1$/);
});

test("distinct raw ids that sanitize equal get different names", () => {
  assert.notEqual(indexNameForTenant("a_b"), indexNameForTenant("a@b"));
});

test("indexNameForTenant is deterministic", () => {
  assert.equal(indexNameForTenant("Team@Corp"), indexNameForTenant("Team@Corp"));
});

test("indexNameForTenant caps length for long inputs", () => {
  const long = "a".repeat(100);
  const name = indexNameForTenant(long);
  assert.ok(name.length <= 63);
  assert.match(name, /^tenant-a{32}-[0-9a-f]{10}-v1$/);
});

test("indexNameForTenant honors an explicit version", () => {
  assert.equal(indexNameForTenant("abc", 2), "tenant-abc-v2");
});

test("indexNameForTenant output always matches index-name charset and bounds", () => {
  const inputs = ["abc", "A".repeat(80), "user@example.com", "x.y-z", "ñandú tenant"];
  for (const raw of inputs) {
    const name = indexNameForTenant(raw);
    assert.match(name, /^[a-z0-9.-]+$/);
    assert.ok(name.length >= 3 && name.length <= 63);
  }
});
