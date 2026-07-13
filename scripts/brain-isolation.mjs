#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  S3VectorsClient,
  CreateIndexCommand,
  DeleteIndexCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
} from "@aws-sdk/client-s3vectors";

// Tenant-isolation gate for the S3 Vectors second brain. Creates two throwaway
// tenant indexes, seeds them with deterministic pseudo-embeddings and asserts
// that queries against tenant A never surface tenant B vectors, and that the
// notes-privacy filter hides u1's notes from caller u2. Exits 1 on any leak.
//
// Usage:
//   VECTOR_BUCKET=<bucket> node scripts/brain-isolation.mjs

const { VECTOR_BUCKET } = process.env;
if (!VECTOR_BUCKET) {
  console.error(
    "Falta VECTOR_BUCKET. Uso:\n  VECTOR_BUCKET=<bucket> node scripts/brain-isolation.mjs",
  );
  process.exit(2);
}

const DIMENSIONS = 1024;
const INDEX_A = "tenant-smoketest-a-v1";
const INDEX_B = "tenant-smoketest-b-v1";
// Mirrors backend/src/lib/brain/vectorstore.ts NON_FILTERABLE_KEYS — keep in sync.
const NON_FILTERABLE_KEYS = ["text", "title", "chapterTitle", "turnStart", "turnEnd"];

const client = new S3VectorsClient({});

function pseudoEmbedding(seed) {
  const values = new Array(DIMENSIONS);
  for (let block = 0; block * 32 < DIMENSIONS; block++) {
    const bytes = createHash("sha256").update(`${seed}:${block}`).digest();
    for (let i = 0; i < 32 && block * 32 + i < DIMENSIONS; i++) {
      values[block * 32 + i] = (bytes[i] - 127.5) / 127.5;
    }
  }
  const norm = Math.sqrt(values.reduce((acc, v) => acc + v * v, 0));
  return values.map((v) => v / norm);
}

async function deleteIndexIgnoreMissing(indexName) {
  try {
    await client.send(new DeleteIndexCommand({ vectorBucketName: VECTOR_BUCKET, indexName }));
  } catch (err) {
    if (err.name !== "NotFoundException") throw err;
  }
}

async function createIndex(indexName) {
  await client.send(
    new CreateIndexCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      dataType: "float32",
      dimension: DIMENSIONS,
      distanceMetric: "cosine",
      metadataConfiguration: { nonFilterableMetadataKeys: NON_FILTERABLE_KEYS },
    }),
  );
}

async function putVectors(indexName, vectors) {
  for (let attempt = 1; ; attempt++) {
    try {
      await client.send(
        new PutVectorsCommand({ vectorBucketName: VECTOR_BUCKET, indexName, vectors }),
      );
      return;
    } catch (err) {
      if (err.name !== "NotFoundException" || attempt >= 5) throw err;
      await new Promise((r) => setTimeout(r, 2000));
    }
  }
}

async function query(indexName, embedding, filter) {
  const res = await client.send(
    new QueryVectorsCommand({
      vectorBucketName: VECTOR_BUCKET,
      indexName,
      queryVector: { float32: embedding },
      topK: 10,
      ...(filter ? { filter } : {}),
      returnMetadata: true,
      returnDistance: true,
    }),
  );
  return (res.vectors ?? []).map((v) => ({ key: v.key, metadata: v.metadata ?? {} }));
}

function chapterVectors(prefix, marker) {
  return [1, 2, 3, 4, 5].map((n) => ({
    key: `${prefix}-${n}`,
    data: { float32: pseudoEmbedding(`${prefix}-${n}`) },
    metadata: {
      type: "chapter",
      meetingId: marker,
      dateEpoch: 1750000000 + n,
      text: `Fragmento ${n} del documento ${marker}`,
      title: `Reunión ${marker} ${n}`,
      chapterTitle: `Capítulo ${n}`,
    },
  }));
}

function noteVector(ownerSub) {
  const key = `note-${ownerSub}`;
  return {
    key,
    data: { float32: pseudoEmbedding(key) },
    metadata: {
      type: "note",
      ownerSub,
      noteId: key,
      dateEpoch: 1750000100,
      text: `Nota privada de ${ownerSub}`,
      title: `Nota de ${ownerSub}`,
    },
  };
}

const failures = [];

function assertNoLeak(label, hits, predicate) {
  const leaked = hits.filter(predicate);
  if (leaked.length === 0) {
    console.log(`OK   ${label} — sin fugas (${hits.length} resultados)`);
    return;
  }
  failures.push(label);
  console.error(`FUGA ${label} — ${leaked.length} vector(es) que no deberían aparecer:`);
  for (const hit of leaked) {
    console.error(`  key=${hit.key} metadata=${JSON.stringify(hit.metadata)}`);
  }
}

console.log(`Bucket: ${VECTOR_BUCKET} · Índices: ${INDEX_A}, ${INDEX_B}\n`);

console.log("Limpieza previa de índices de prueba…");
await deleteIndexIgnoreMissing(INDEX_A);
await deleteIndexIgnoreMissing(INDEX_B);

try {
  console.log("Creando índices…");
  await createIndex(INDEX_A);
  await createIndex(INDEX_B);

  console.log("Cargando vectores (5 capítulos por tenant + 2 notas en A)…");
  await putVectors(INDEX_A, [...chapterVectors("a", "TENANT_A_DOC"), noteVector("u1"), noteVector("u2")]);
  await putVectors(INDEX_B, chapterVectors("b", "TENANT_B_DOC"));

  const queryEmbedding = pseudoEmbedding("isolation-query");

  console.log("\nConsulta 1: índice A, topK 10, sin filtro — no debe aparecer nada del tenant B.");
  const crossTenantHits = await query(INDEX_A, queryEmbedding);
  assertNoLeak(
    "aislamiento entre tenants",
    crossTenantHits,
    (h) => h.key.includes("b-") || h.metadata.meetingId === "TENANT_B_DOC",
  );

  console.log("\nConsulta 2: índice A con filtro de privacidad de notas (caller u2) — no debe aparecer la nota de u1.");
  const privacyFilter = {
    $or: [
      { type: { $ne: "note" } },
      { $and: [{ type: { $eq: "note" } }, { ownerSub: { $eq: "u2" } }] },
    ],
  };
  const privacyHits = await query(INDEX_A, queryEmbedding, privacyFilter);
  assertNoLeak(
    "privacidad de notas",
    privacyHits,
    (h) => h.metadata.type === "note" && h.metadata.ownerSub !== "u2",
  );
} finally {
  console.log("\nLimpieza final de índices de prueba…");
  await deleteIndexIgnoreMissing(INDEX_A);
  await deleteIndexIgnoreMissing(INDEX_B);
}

if (failures.length > 0) {
  console.error(`\nRESULTADO: FALLÓ — fugas detectadas en: ${failures.join(", ")}`);
  process.exit(1);
}
console.log("\nRESULTADO: OK — aislamiento entre tenants y privacidad de notas verificados.");
