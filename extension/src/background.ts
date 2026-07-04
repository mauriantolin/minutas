import type {
  CaptionEvent,
  DiarizedSegment,
  MeetingFinalizeRequest,
  MeetingStartRequest,
  MeetingStartResponse,
  SegmentsAppendRequest,
  SignalHealth,
} from "@teams-agent-core/shared";
import { CONFIG } from "./config.js";
import {
  clearCapture,
  getCaptionCheckpoint,
  getCheckpoint,
  listCaptureMetas,
  listPendingFinalizes,
  saveCaptionCheckpoint,
  saveCaptureMeta,
  savePendingFinalize,
  type PendingFinalize,
} from "./idb.js";

// Orchestrates a capture session across the Teams tab (content script → speaker timeline),
// the offscreen document (audio → Transcribe → segments), and the backend lifecycle API
// (start → segments* → finalize).
//
// MV3 note: the service worker can be suspended at any time, so capture state lives in
// chrome.storage.session — NOT in module memory — and the popup reads it to reflect an
// in-progress capture instead of showing "Start" again. Crash-recovery state (segment
// checkpoints, unsent finalize payloads) lives in IndexedDB, shared with the offscreen
// document, and is swept on service-worker startup.

type CaptureState = {
  activeTabId: number;
  captureId: string;
  meetingId?: string;
  seq: number;
  pending: DiarizedSegment[];
  // Batch already POSTed at least once under `seq`. Frozen: the server dedupes
  // by seq, so a retry must replay identical content or appended segments get
  // silently discarded when the first send actually landed.
  inflight?: DiarizedSegment[];
  // Final captions not yet shipped in a segments batch; same freeze semantics.
  captionPending: CaptionEvent[];
  captionInflight?: CaptionEvent[];
  signalHealth?: SignalHealth;
  lastFlushAt: number;
  meetingMeta: { title: string; localUserName: string; startedAt: string };
};

const FLUSH_MAX_SEGMENTS = 20;
const FLUSH_MAX_MS = 15_000;
const FINALIZE_BACKOFF_MS = [0, 2000, 8000];

const readState = async (): Promise<CaptureState | undefined> =>
  (await chrome.storage.session.get("capture")).capture;

const writeState = (state: CaptureState) => chrome.storage.session.set({ capture: state });

async function ensureOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    await chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["USER_MEDIA"],
      justification: "Capture meeting audio for transcription.",
    });
  }
}

async function getIdToken(): Promise<string> {
  const { idToken } = await chrome.storage.session.get("idToken");
  if (!idToken) throw new Error("Not signed in");
  return idToken as string;
}

const TEAMS_HOST = /(^|\.)(teams\.microsoft\.com|teams\.cloud\.microsoft|cloud\.microsoft|teams\.live\.com)$/;

/**
 * Sends CAPTURE_START to the tab's content script. If the script isn't there — the usual
 * cause is that the extension was reloaded while the Teams tab stayed open, so Chrome never
 * re-injected it — inject it programmatically and retry once.
 */
async function startInTab(tabId: number) {
  try {
    return await chrome.tabs.sendMessage(tabId, { type: "CAPTURE_START" });
  } catch {
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
    return chrome.tabs.sendMessage(tabId, { type: "CAPTURE_START" });
  }
}

async function sendToOffscreen(msg: object, tries = 5): Promise<any> {
  for (let i = 0; i < tries; i++) {
    try {
      return await chrome.runtime.sendMessage(msg);
    } catch {
      await new Promise((r) => setTimeout(r, 150));
    }
  }
  throw new Error("Offscreen document not responding");
}

const api = (path: string, body: unknown, idToken: string): Promise<Response> =>
  fetch(`${CONFIG.apiUrl}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify(body),
  });

/** Idempotent by captureId — a retry after a lost response returns the same meetingId. */
async function registerMeeting(
  captureId: string,
  meta: { title: string; startedAt: string },
  idToken: string,
): Promise<string | undefined> {
  const body: MeetingStartRequest = { captureId, title: meta.title, startedAt: meta.startedAt };
  try {
    const res = await api("/meetings", body, idToken);
    if (!res.ok) return undefined;
    return ((await res.json()) as MeetingStartResponse).meetingId;
  } catch {
    return undefined;
  }
}

async function startCapture(): Promise<{ captionsDetected: boolean }> {
  if (await readState()) throw new Error("Capture already in progress");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const host = tab.url ? new URL(tab.url).hostname : "";
  if (!TEAMS_HOST.test(host)) {
    throw new Error("Open your Teams meeting in the active tab first");
  }

  const idToken = await getIdToken();
  const { captionsDetected, ...meetingMeta } = await startInTab(tab.id);
  const captureId = crypto.randomUUID();

  // Start failure is tolerated (offline start): finalize upserts by captureId later.
  const meetingId = await registerMeeting(captureId, meetingMeta, idToken);
  await saveCaptureMeta({ captureId, meetingId, ...meetingMeta });

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  const started = await sendToOffscreen({
    target: "offscreen",
    type: "START",
    streamId,
    idToken,
    captureId,
  });
  // A capture that never opened its audio stream must not be recorded as active,
  // or the popup shows "capturing" while nothing is captured.
  if (!started?.ok) {
    await chrome.offscreen.closeDocument().catch(() => {});
    await clearCapture(captureId).catch(() => {});
    throw new Error(started?.error ?? "Audio capture failed to start");
  }

  await writeState({
    activeTabId: tab.id,
    captureId,
    meetingId,
    seq: 1,
    pending: [],
    captionPending: [],
    lastFlushAt: Date.now(),
    meetingMeta,
  });
  return { captionsDetected: !!captionsDetected };
}

// Segment batching: state mutations are serialized because SEGMENT_FINAL messages arrive
// concurrently and chrome.storage read-modify-write would otherwise drop segments.
let stateLock: Promise<unknown> = Promise.resolve();
function withStateLock<T>(fn: () => Promise<T>): Promise<T> {
  const p = stateLock.then(fn);
  stateLock = p.catch(() => {});
  return p;
}

// Additive fields on the segments batch (live correlation can use them later);
// the server dedupes the whole batch by seq, captions included.
type SegmentsAppendBody = SegmentsAppendRequest & {
  captionTimeline?: CaptionEvent[];
  signalHealth?: SignalHealth;
};

const onSegmentFinal = (segment: DiarizedSegment): Promise<void> =>
  withStateLock(async () => {
    const state = await readState();
    if (!state?.meetingId) return;
    state.pending.push(segment);
    const due =
      state.pending.length >= FLUSH_MAX_SEGMENTS || Date.now() - state.lastFlushAt >= FLUSH_MAX_MS;
    if (due) {
      state.inflight ??= state.pending.splice(0);
      state.captionInflight ??= state.captionPending.splice(0);
      const body: SegmentsAppendBody = {
        seq: state.seq,
        segments: state.inflight,
        ...(state.captionInflight.length > 0 && { captionTimeline: state.captionInflight }),
        ...(state.signalHealth && { signalHealth: state.signalHealth }),
      };
      const ok = await api(`/meetings/${state.meetingId}/segments`, body, await getIdToken())
        .then((r) => r.ok)
        .catch(() => false);
      // On failure keep the frozen batch under the same seq for the next due
      // flush; segments arriving meanwhile stay in `pending` for the next seq.
      if (ok) {
        state.seq += 1;
        state.inflight = undefined;
        state.captionInflight = undefined;
      }
      state.lastFlushAt = Date.now();
    }
    if (await readState()) await writeState(state);
  });

// Captions flow content script → here (the offscreen document never sees the DOM).
// IndexedDB keeps the full accumulated timeline so a dead tab still finalizes with it.
const onCaptionCheckpoint = (
  events: CaptionEvent[],
  signalHealth: SignalHealth,
  senderTabId: number | undefined,
): Promise<void> =>
  withStateLock(async () => {
    const state = await readState();
    if (!state || senderTabId !== state.activeTabId) return;
    state.captionPending.push(...events);
    state.signalHealth = signalHealth;
    const prior = await getCaptionCheckpoint(state.captureId).catch(() => undefined);
    await saveCaptionCheckpoint({
      captureId: state.captureId,
      captionTimeline: [...(prior?.captionTimeline ?? []), ...events],
      signalHealth,
      updatedAt: Date.now(),
    }).catch(() => {});
    if (await readState()) await writeState(state);
  });

async function finalizeMeeting(record: PendingFinalize): Promise<{ meetingId?: string; error?: string }> {
  await savePendingFinalize(record);
  const idToken = await getIdToken();

  let meetingId = record.meetingId;
  if (!meetingId) {
    meetingId = await registerMeeting(record.captureId, record.payload, idToken);
    if (!meetingId) return { error: "Backend unreachable — capture kept locally for retry" };
    await savePendingFinalize({ ...record, meetingId });
  }

  for (const delay of FINALIZE_BACKOFF_MS) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    const ok = await api(`/meetings/${meetingId}/finalize`, record.payload, idToken)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) {
      await clearCapture(record.captureId);
      return { meetingId };
    }
  }
  return { error: "Finalize failed — capture kept locally for retry" };
}

async function stopCapture(): Promise<{ meetingId?: string; error?: string }> {
  // Removal must serialize with in-flight segment flushes, or a concurrent
  // onSegmentFinal can write the stale state back after it was removed.
  const state = await withStateLock(async () => {
    const s = await readState();
    if (s) await chrome.storage.session.remove("capture");
    return s;
  });
  if (!state) return { error: "No active capture" };

  const content = await chrome.tabs
    .sendMessage(state.activeTabId, { type: "CAPTURE_STOP" })
    .catch(() => null);
  const offscreen = await chrome.runtime
    .sendMessage({ target: "offscreen", type: "STOP" })
    .catch(() => null);
  await chrome.offscreen.closeDocument().catch(() => {});

  // Offscreen crash → fall back to the checkpoint it wrote to IndexedDB during capture.
  const segments: DiarizedSegment[] =
    offscreen?.segments ??
    (await getCheckpoint(state.captureId).catch(() => undefined))?.segments ??
    [];
  // Tab gone (closed mid-meeting) → fall back to the caption checkpoint; it lags the
  // live timeline by at most one flush interval.
  const captionCkpt = content
    ? undefined
    : await getCaptionCheckpoint(state.captureId).catch(() => undefined);

  const payload: MeetingFinalizeRequest = {
    captureId: state.captureId,
    title: state.meetingMeta.title,
    startedAt: state.meetingMeta.startedAt,
    endedAt: content?.endedAt ?? new Date().toISOString(),
    localUserName: state.meetingMeta.localUserName,
    segments,
    speakerTimeline: content?.speakerTimeline ?? [],
    captionTimeline: content?.captionTimeline ?? captionCkpt?.captionTimeline ?? [],
    signalHealth: content?.signalHealth ?? captionCkpt?.signalHealth ?? state.signalHealth,
  };
  return finalizeMeeting({
    captureId: state.captureId,
    meetingId: state.meetingId,
    payload,
    updatedAt: Date.now(),
  });
}

/** Discard an orphaned capture without sending anything (recovery). */
async function cancelCapture(): Promise<void> {
  const state = await withStateLock(async () => {
    const s = await readState();
    await chrome.storage.session.remove("capture");
    return s;
  });
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
  if (state) await clearCapture(state.captureId).catch(() => {});
}

// Sweep IndexedDB for captures that never finalized (offscreen/SW crash, browser exit,
// failed finalize) and finalize them from the checkpointed data — safe by idempotency.
let recovering = false;
async function recoverOrphans(): Promise<void> {
  if (recovering) return;
  recovering = true;
  try {
    const idToken = await getIdToken().catch(() => null);
    if (!idToken) return;
    const active = await readState();

    const pending = await listPendingFinalizes();
    for (const record of pending) {
      if (record.captureId === active?.captureId) continue;
      await finalizeMeeting(record).catch(() => {});
    }

    for (const meta of await listCaptureMetas()) {
      if (meta.captureId === active?.captureId) continue;
      if (pending.some((r) => r.captureId === meta.captureId)) continue;
      const checkpoint = await getCheckpoint(meta.captureId);
      if (!checkpoint?.segments.length) {
        await clearCapture(meta.captureId);
        continue;
      }
      const captions = await getCaptionCheckpoint(meta.captureId).catch(() => undefined);
      await finalizeMeeting({
        captureId: meta.captureId,
        meetingId: meta.meetingId,
        payload: {
          captureId: meta.captureId,
          title: meta.title,
          startedAt: meta.startedAt,
          endedAt: new Date(checkpoint.updatedAt).toISOString(),
          localUserName: meta.localUserName,
          segments: checkpoint.segments,
          speakerTimeline: [],
          captionTimeline: captions?.captionTimeline ?? [],
          signalHealth: captions?.signalHealth,
        },
        updatedAt: Date.now(),
      }).catch(() => {});
    }
  } finally {
    recovering = false;
  }
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "LIVE_LINE") {
    readState().then((s) => {
      if (s) chrome.tabs.sendMessage(s.activeTabId, msg).catch(() => {});
    });
    return false;
  }
  if (msg.type === "SEGMENT_FINAL") {
    void onSegmentFinal(msg.segment);
    return false;
  }
  if (msg.type === "CAPTION_CHECKPOINT") {
    void onCaptionCheckpoint(msg.events, msg.signalHealth, _s.tab?.id);
    return false;
  }
  if (msg.type === "ID_TOKEN_REFRESHED") {
    void chrome.storage.session.set({ idToken: msg.idToken });
    return false;
  }
  if (msg.type === "GET_STATE") {
    // The popup just refreshed the session token — a good moment to retry orphans.
    void recoverOrphans();
    readState().then((s) => sendResponse({ capturing: !!s }));
    return true;
  }
  if (msg.type === "POPUP_START") {
    startCapture()
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "POPUP_STOP") {
    stopCapture().then(sendResponse).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
  if (msg.type === "POPUP_CANCEL") {
    cancelCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
    return true;
  }
});

void recoverOrphans();
