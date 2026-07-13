import {
  S3VectorsClient,
  GetIndexCommand,
  CreateIndexCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  DeleteVectorsCommand,
  type QueryVectorsCommandInput,
} from "@aws-sdk/client-s3vectors";
import type { BrainChunk } from "./chunker.js";
import { EMBED_DIMENSIONS } from "./embed.js";

const client = new S3VectorsClient({});
const bucket = () => process.env.VECTOR_BUCKET!;

const BATCH = 500;

export const NON_FILTERABLE_KEYS = [
  "text",
  "title",
  "chapterTitle",
  "turnStart",
  "turnEnd",
];

export interface QueryHit {
  key: string;
  distance?: number;
  metadata: Record<string, unknown>;
}

export function brainQueryFilter(
  callerSub: string,
  opts?: { types?: string[]; dateFromEpoch?: number; dateToEpoch?: number },
): Record<string, unknown> {
  const base = {
    $or: [
      { type: { $ne: "note" } },
      {
        $and: [{ type: { $eq: "note" } }, { ownerSub: { $eq: callerSub } }],
      },
    ],
  };
  const clauses: Record<string, unknown>[] = [];
  if (opts?.types?.length) clauses.push({ type: { $in: opts.types } });
  const range: Record<string, number> = {};
  if (opts?.dateFromEpoch !== undefined) range["$gte"] = opts.dateFromEpoch;
  if (opts?.dateToEpoch !== undefined) range["$lte"] = opts.dateToEpoch;
  if (Object.keys(range).length > 0) clauses.push({ dateEpoch: range });
  return clauses.length > 0 ? { $and: [base, ...clauses] } : base;
}

export async function ensureIndex(indexName: string): Promise<void> {
  try {
    await client.send(
      new GetIndexCommand({ vectorBucketName: bucket(), indexName }),
    );
    return;
  } catch (err) {
    if ((err as Error).name !== "NotFoundException") throw err;
  }
  try {
    await client.send(
      new CreateIndexCommand({
        vectorBucketName: bucket(),
        indexName,
        dataType: "float32",
        dimension: EMBED_DIMENSIONS,
        distanceMetric: "cosine",
        metadataConfiguration: {
          nonFilterableMetadataKeys: NON_FILTERABLE_KEYS,
        },
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "ConflictException") throw err;
  }
}

export async function putChunkVectors(
  indexName: string,
  chunks: BrainChunk[],
  embeddings: number[][],
): Promise<string[]> {
  const vectors = chunks.map((chunk, i) => {
    const metadata: Record<string, string | number> = { text: chunk.text };
    for (const [k, v] of Object.entries(chunk.metadata)) {
      if (v !== undefined) metadata[k] = v as string | number;
    }
    return {
      key: chunk.key,
      data: { float32: embeddings[i] as number[] },
      metadata,
    };
  });
  for (let i = 0; i < vectors.length; i += BATCH) {
    await client.send(
      new PutVectorsCommand({
        vectorBucketName: bucket(),
        indexName,
        vectors: vectors.slice(i, i + BATCH),
      }),
    );
  }
  return vectors.map((v) => v.key);
}

export async function queryIndex(
  indexName: string,
  embedding: number[],
  opts: { topK?: number; filter: Record<string, unknown> },
): Promise<QueryHit[]> {
  try {
    const res = await client.send(
      new QueryVectorsCommand({
        vectorBucketName: bucket(),
        indexName,
        queryVector: { float32: embedding },
        topK: opts.topK ?? 15,
        filter: opts.filter as QueryVectorsCommandInput["filter"],
        returnMetadata: true,
        returnDistance: true,
      }),
    );
    return (res.vectors ?? []).map((v) => ({
      key: v.key as string,
      distance: v.distance,
      metadata: (v.metadata ?? {}) as Record<string, unknown>,
    }));
  } catch (err) {
    if ((err as Error).name === "NotFoundException") return [];
    throw err;
  }
}

export async function deleteVectorKeys(
  indexName: string,
  keys: string[],
): Promise<void> {
  for (let i = 0; i < keys.length; i += BATCH) {
    try {
      await client.send(
        new DeleteVectorsCommand({
          vectorBucketName: bucket(),
          indexName,
          keys: keys.slice(i, i + BATCH),
        }),
      );
    } catch (err) {
      if ((err as Error).name !== "NotFoundException") throw err;
    }
  }
}
