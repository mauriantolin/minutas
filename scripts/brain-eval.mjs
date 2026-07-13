#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { BedrockRuntimeClient, InvokeModelCommand } from "@aws-sdk/client-bedrock-runtime";
import { S3VectorsClient, QueryVectorsCommand } from "@aws-sdk/client-s3vectors";

// Retrieval eval harness: hit@5 / hit@15 / MRR of a golden Q&A set against a
// tenant's S3 Vectors index. Runnable once a golden corpus exists (post-backfill).
//
// Usage:
//   VECTOR_BUCKET=<bucket> TENANT_ID=<raw tenant id> GOLDEN=<path.json> node scripts/brain-eval.mjs [--gate]
//
// GOLDEN = JSON array of { question, expectMeetingId }; entries without both
// fields (e.g. a "comment" entry) are ignored. With --gate the script exits 1
// when hit@5 < GATE_THRESHOLD.

const INDEX_VERSION = 1;
const GATE_THRESHOLD = 0.7;
const TOP_K = 15;

// Mirrors backend/src/lib/brain/ids.ts indexNameForTenant — keep in sync.
function indexNameForTenant(tenantId, version = INDEX_VERSION) {
  let norm = tenantId.toLowerCase().replace(/[^a-z0-9.-]/g, "-");
  if (norm !== tenantId || norm.length > 43) {
    norm = norm.slice(0, 32) + "-" + createHash("sha256").update(tenantId).digest("hex").slice(0, 10);
  }
  return `tenant-${norm}-v${version}`;
}

const { VECTOR_BUCKET, TENANT_ID, GOLDEN } = process.env;
if (!VECTOR_BUCKET || !TENANT_ID || !GOLDEN) {
  console.error(
    "Faltan variables de entorno. Uso:\n" +
      "  VECTOR_BUCKET=<bucket> TENANT_ID=<tenant id crudo> GOLDEN=<ruta.json> node scripts/brain-eval.mjs [--gate]\n" +
      "Pasá --gate para salir con código 1 cuando hit@5 < " + GATE_THRESHOLD + ".",
  );
  process.exit(2);
}
const gate = process.argv.includes("--gate");

const raw = JSON.parse(readFileSync(GOLDEN, "utf8"));
const pairs = (Array.isArray(raw) ? raw : []).filter(
  (e) => typeof e?.question === "string" && e.question.trim() && typeof e?.expectMeetingId === "string",
);
if (pairs.length === 0) {
  console.error(`El golden set ${GOLDEN} no tiene pares {question, expectMeetingId}.`);
  process.exit(2);
}

const modelId = process.env.EMBED_MODEL_ID ?? "amazon.titan-embed-text-v2:0";
const bedrock = new BedrockRuntimeClient({});
const s3vectors = new S3VectorsClient({});
const indexName = indexNameForTenant(TENANT_ID);

async function embed(text) {
  const res = await bedrock.send(
    new InvokeModelCommand({
      modelId,
      contentType: "application/json",
      accept: "application/json",
      body: JSON.stringify({ inputText: text.slice(0, 40000), dimensions: 1024, normalize: true }),
    }),
  );
  return JSON.parse(new TextDecoder().decode(res.body)).embedding;
}

async function queryRank(embedding, expectMeetingId) {
  const res = await s3vectors.send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      queryVector: { float32: embedding },
      topK: TOP_K,
      returnMetadata: true,
      returnDistance: true,
    }),
  );
  const vectors = res.vectors ?? [];
  return vectors.findIndex((v) => v.metadata?.meetingId === expectMeetingId) + 1;
}

console.log(`Índice: ${indexName} · Bucket: ${VECTOR_BUCKET} · Modelo: ${modelId} · Pares: ${pairs.length}\n`);

const rows = [];
for (const { question, expectMeetingId } of pairs) {
  const rank = await queryRank(await embed(question), expectMeetingId);
  rows.push({ question, expectMeetingId, rank });
}

const trunc = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);
console.log("  #  rank  meetingId esperado        pregunta");
rows.forEach((r, i) => {
  const rank = r.rank > 0 ? String(r.rank).padStart(4) : "miss";
  console.log(`${String(i + 1).padStart(3)}  ${rank.padEnd(4)}  ${trunc(r.expectMeetingId, 24).padEnd(24)}  ${trunc(r.question, 70)}`);
});

const hitAt = (k) => rows.filter((r) => r.rank > 0 && r.rank <= k).length / rows.length;
const mrr = rows.reduce((acc, r) => acc + (r.rank > 0 ? 1 / r.rank : 0), 0) / rows.length;
const hit5 = hitAt(5);
const hit15 = hitAt(TOP_K);

console.log(
  `\nhit@5 = ${hit5.toFixed(2)} (${Math.round(hit5 * rows.length)}/${rows.length})` +
    ` · hit@15 = ${hit15.toFixed(2)} (${Math.round(hit15 * rows.length)}/${rows.length})` +
    ` · MRR = ${mrr.toFixed(3)}`,
);

if (gate && hit5 < GATE_THRESHOLD) {
  console.error(`\nGATE FALLIDO: hit@5 ${hit5.toFixed(2)} < ${GATE_THRESHOLD}`);
  process.exit(1);
}
