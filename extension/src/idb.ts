import type { DiarizedSegment, MeetingFinalizeRequest } from "@teams-agent-core/shared";

// Crash-recovery storage shared by the offscreen document and the service worker.
// IndexedDB is the only durable store both contexts can reach: chrome.storage.* is not
// available inside MV3 offscreen documents, and both run on the same extension origin.

const DB_NAME = "capture-recovery";
const DB_VERSION = 1;

const STORES = ["captures", "checkpoints", "pending-finalize"] as const;
type StoreName = (typeof STORES)[number];

export interface CaptureMeta {
  captureId: string;
  meetingId?: string;
  title: string;
  startedAt: string;
  localUserName: string;
}

export interface SegmentCheckpoint {
  captureId: string;
  segments: DiarizedSegment[];
  updatedAt: number;
}

export interface PendingFinalize {
  captureId: string;
  meetingId?: string;
  payload: MeetingFinalizeRequest;
  updatedAt: number;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      for (const name of STORES) {
        if (!req.result.objectStoreNames.contains(name)) {
          req.result.createObjectStore(name, { keyPath: "captureId" });
        }
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function run<T>(
  store: StoreName,
  mode: IDBTransactionMode,
  op: (s: IDBObjectStore) => IDBRequest,
): Promise<T> {
  const db = await openDb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(db.transaction(store, mode).objectStore(store));
      req.onsuccess = () => resolve(req.result as T);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const saveCaptureMeta = (meta: CaptureMeta) =>
  run<unknown>("captures", "readwrite", (s) => s.put(meta));

export const listCaptureMetas = () =>
  run<CaptureMeta[]>("captures", "readonly", (s) => s.getAll());

export const saveCheckpoint = (checkpoint: SegmentCheckpoint) =>
  run<unknown>("checkpoints", "readwrite", (s) => s.put(checkpoint));

export const getCheckpoint = (captureId: string) =>
  run<SegmentCheckpoint | undefined>("checkpoints", "readonly", (s) => s.get(captureId));

export const savePendingFinalize = (record: PendingFinalize) =>
  run<unknown>("pending-finalize", "readwrite", (s) => s.put(record));

export const listPendingFinalizes = () =>
  run<PendingFinalize[]>("pending-finalize", "readonly", (s) => s.getAll());

export async function clearCapture(captureId: string): Promise<void> {
  for (const store of STORES) {
    await run<unknown>(store, "readwrite", (s) => s.delete(captureId));
  }
}
