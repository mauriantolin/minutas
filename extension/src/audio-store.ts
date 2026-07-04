import type { AudioSource } from "@teams-agent-core/shared";

// Opt-in audio buffer (§7): MediaRecorder Opus chunks in OPFS, written by the offscreen
// document, read/purged by the service worker (OPFS is per-origin and both contexts reach
// it; chrome.storage can't hold blobs this size).
//
// One file per timeslice chunk instead of one appended file: a closed file survives an
// offscreen crash, while a long-lived FileSystemWritableFileStream buffers into a swap
// file that a crash discards wholesale. Byte-concatenating the chunks in order yields the
// same valid WebM stream MediaRecorder would have written to a single sink.

const AUDIO_DIR = "audio";

// Async directory iteration isn't in lib.dom yet.
type DirEntries = AsyncIterable<[string, FileSystemHandle]>;
const entriesOf = (dir: FileSystemDirectoryHandle): DirEntries =>
  (dir as unknown as { entries(): DirEntries }).entries();

async function audioRoot(create: boolean): Promise<FileSystemDirectoryHandle | undefined> {
  const root = await navigator.storage.getDirectory();
  return root.getDirectoryHandle(AUDIO_DIR, { create }).catch(() => undefined);
}

async function captureDir(
  captureId: string,
  create: boolean,
): Promise<FileSystemDirectoryHandle | undefined> {
  const audio = await audioRoot(create);
  return audio?.getDirectoryHandle(captureId, { create }).catch(() => undefined);
}

export async function appendAudioChunk(
  captureId: string,
  source: AudioSource,
  seq: number,
  chunk: Blob,
): Promise<void> {
  const dir = await captureDir(captureId, true);
  if (!dir) return;
  const name = `${source}-${String(seq).padStart(6, "0")}.webm`;
  const file = await dir.getFileHandle(name, { create: true });
  const writable = await file.createWritable();
  await writable.write(chunk);
  await writable.close();
}

async function chunkFiles(captureId: string, source: AudioSource): Promise<File[]> {
  const dir = await captureDir(captureId, false);
  if (!dir) return [];
  const names: string[] = [];
  for await (const [name] of entriesOf(dir)) {
    if (name.startsWith(`${source}-`)) names.push(name);
  }
  names.sort();
  const files: File[] = [];
  for (const name of names) {
    files.push(await dir.getFileHandle(name).then((h) => h.getFile()));
  }
  return files;
}

export async function hasAudio(captureId: string, source: AudioSource): Promise<boolean> {
  return (await chunkFiles(captureId, source)).length > 0;
}

export async function readAudio(
  captureId: string,
  source: AudioSource,
): Promise<Blob | undefined> {
  const files = await chunkFiles(captureId, source);
  if (files.length === 0) return undefined;
  return new Blob(files, { type: "audio/webm" });
}

export async function purgeAudio(captureId: string): Promise<void> {
  const audio = await audioRoot(false);
  await audio?.removeEntry(captureId, { recursive: true }).catch(() => {});
}

/** Deletes capture audio whose newest chunk is older than the retention window. */
export async function purgeExpiredAudio(maxAgeDays: number): Promise<void> {
  const audio = await audioRoot(false);
  if (!audio) return;
  const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000;
  const expired: string[] = [];
  for await (const [captureId, handle] of entriesOf(audio)) {
    if (handle.kind !== "directory") continue;
    let newest = 0;
    for await (const [, fh] of entriesOf(handle as FileSystemDirectoryHandle)) {
      if (fh.kind !== "file") continue;
      const file = await (fh as FileSystemFileHandle).getFile();
      newest = Math.max(newest, file.lastModified);
    }
    if (newest < cutoff) expired.push(captureId);
  }
  for (const captureId of expired) {
    await audio.removeEntry(captureId, { recursive: true }).catch(() => {});
  }
}
