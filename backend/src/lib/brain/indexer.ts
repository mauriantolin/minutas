import type { Note } from "@teams-agent-core/shared";
import {
  deleteIndexedKeys,
  getCleanTranscript,
  getExtraction,
  getIndexedKeys,
  getMeetingItem,
  getSummaryArtifact,
  putIndexedKeys,
  putNote,
  updateMeeting,
} from "../store.js";
import { chunkMeeting, chunkNote, type BrainChunk } from "./chunker.js";
import { embedAll } from "./embed.js";
import {
  deleteVectorKeys,
  ensureIndex,
  putChunkVectors,
} from "./vectorstore.js";
import { INDEX_VERSION, indexNameForTenant } from "./ids.js";

type IndexedDoc = `MEETING#${string}` | `NOTE#${string}`;

async function ifExists<T>(load: Promise<T>): Promise<T | undefined> {
  try {
    return await load;
  } catch (err) {
    if ((err as Error).name !== "NoSuchKey") throw err;
    return undefined;
  }
}

/**
 * Deterministic chunk keys make this an overwrite: re-embedding replaces the
 * same vectors, and only keys the new chunking no longer emits get deleted.
 */
async function writeChunks(
  tenantId: string,
  doc: IndexedDoc,
  chunks: BrainChunk[],
): Promise<string[]> {
  const indexName = indexNameForTenant(tenantId);
  await ensureIndex(indexName);
  const embeddings = await embedAll(
    chunks.map((c) => c.text),
    4,
  );
  const previous = await getIndexedKeys(tenantId, doc);
  if (previous) {
    const emitted = new Set(chunks.map((c) => c.key));
    const previousIndexName = indexNameForTenant(
      tenantId,
      previous.indexVersion,
    );
    const stale =
      previousIndexName === indexName
        ? previous.keys.filter((k) => !emitted.has(k))
        : previous.keys;
    if (stale.length > 0) await deleteVectorKeys(previousIndexName, stale);
  }
  const keys = await putChunkVectors(indexName, chunks, embeddings);
  await putIndexedKeys(tenantId, doc, keys, INDEX_VERSION);
  return keys;
}

export async function indexMeeting(
  tenantId: string,
  meetingId: string,
): Promise<{ chunks: number }> {
  const meeting = await getMeetingItem(tenantId, meetingId);
  if (!meeting) throw new Error(`meeting not found: ${meetingId}`);
  const [extraction, clean, summary] = await Promise.all([
    ifExists(getExtraction(tenantId, meetingId)),
    ifExists(getCleanTranscript(tenantId, meetingId)),
    ifExists(getSummaryArtifact(tenantId, meetingId)),
  ]);
  const chunks = chunkMeeting(meeting, { extraction, clean, summary });
  const keys = await writeChunks(tenantId, `MEETING#${meetingId}`, chunks);
  await updateMeeting(tenantId, meetingId, {
    indexStatus: "indexed",
    indexVersion: INDEX_VERSION,
    indexedAt: new Date().toISOString(),
  });
  return { chunks: keys.length };
}

export async function indexNote(note: Note): Promise<{ chunks: number }> {
  const chunks = chunkNote(note);
  const keys = await writeChunks(
    note.tenantId,
    `NOTE#${note.noteId}`,
    chunks,
  );
  note.indexVersion = INDEX_VERSION;
  await putNote(note);
  return { chunks: keys.length };
}

async function removeDocVectors(tenantId: string, doc: string): Promise<void> {
  const record = await getIndexedKeys(tenantId, doc);
  if (!record) return;
  await deleteVectorKeys(
    indexNameForTenant(tenantId, record.indexVersion),
    record.keys,
  );
  await deleteIndexedKeys(tenantId, doc);
}

export async function removeMeetingVectors(
  tenantId: string,
  meetingId: string,
): Promise<void> {
  await removeDocVectors(tenantId, `MEETING#${meetingId}`);
}

export async function removeNoteVectors(
  tenantId: string,
  _ownerSub: string,
  noteId: string,
): Promise<void> {
  await removeDocVectors(tenantId, `NOTE#${noteId}`);
}
