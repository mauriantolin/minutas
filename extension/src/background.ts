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
  saveCheckpoint,
  savePendingFinalize,
  type PendingFinalize,
} from "./idb.js";

// Orchestrates a capture session across the Teams tab (content script → live captions
// → speaker timeline) and the backend lifecycle API (start → segments* → finalize).
// The Teams caption scrape IS the transcript — no offscreen document, no tabCapture,
// no mic, $0. It's the only way the extension interprets meeting audio.
//
// MV3 note: the service worker can be suspended at any time, so capture state lives in
// chrome.storage.session — NOT in module memory — and the popup reads it to reflect an
// in-progress capture instead of showing "Start" again. Crash-recovery state (segment
// checkpoints, unsent finalize payloads) lives in IndexedDB and is swept on
// service-worker startup.

const ASR_MODE = "captions-primary" as const;

type CaptureState = {
  activeTabId: number;
  captureId: string;
  // Auto-started captures auto-stop on meeting-presence loss; manual ones never do.
  autoStarted?: boolean;
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

// idTokens are refreshed a minute before expiry so an in-flight request never
// races the 60-min boundary.
const TOKEN_SKEW_MS = 60_000;

function jwtExpMs(jwt: string): number {
  try {
    return (JSON.parse(atob(jwt.split(".")[1]!)) as { exp: number }).exp * 1000;
  } catch {
    return 0;
  }
}

const tokenUsable = (jwt: unknown): jwt is string =>
  typeof jwt === "string" && jwtExpMs(jwt) - TOKEN_SKEW_MS > Date.now();

// Cognito InitiateAuth over REST — the service worker has no `window`, so the
// amazon-cognito-identity-js SDK (localStorage-backed) can't run here. The app
// client is a public SPA client (no secret), so REFRESH_TOKEN_AUTH is a plain fetch.
async function refreshIdTokenViaRest(refreshToken: string): Promise<string | null> {
  const res = await fetch(`https://cognito-idp.${CONFIG.region}.amazonaws.com/`, {
    method: "POST",
    headers: {
      "content-type": "application/x-amz-json-1.1",
      "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth",
    },
    body: JSON.stringify({
      AuthFlow: "REFRESH_TOKEN_AUTH",
      ClientId: CONFIG.userPoolClientId,
      AuthParameters: { REFRESH_TOKEN: refreshToken },
    }),
  }).catch(() => null);
  if (!res?.ok) return null;
  const data = (await res.json().catch(() => null)) as
    | { AuthenticationResult?: { IdToken?: string } }
    | null;
  return data?.AuthenticationResult?.IdToken ?? null;
}

/**
 * A usable idToken for API calls. The popup seeds session storage; auto-capture
 * also runs after a service-worker/browser restart, so this falls back to the
 * persisted token in local storage and refreshes it (via the persisted refresh
 * token) when expired — no popup interaction required.
 */
async function getIdToken(): Promise<string> {
  const { idToken } = await chrome.storage.session.get("idToken");
  if (tokenUsable(idToken)) return idToken;

  const { authIdToken, authRefreshToken } = await chrome.storage.local.get([
    "authIdToken",
    "authRefreshToken",
  ]);
  if (tokenUsable(authIdToken)) {
    await chrome.storage.session.set({ idToken: authIdToken });
    return authIdToken;
  }
  if (typeof authRefreshToken === "string") {
    const fresh = await refreshIdTokenViaRest(authRefreshToken);
    if (fresh) {
      await chrome.storage.session.set({ idToken: fresh });
      await chrome.storage.local.set({ authIdToken: fresh });
      return fresh;
    }
  }
  throw new Error("Not signed in");
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

type StartCaptureOpts = { tabId?: number; autoStarted?: boolean };

async function startCapture(opts: StartCaptureOpts = {}): Promise<{
  captionsDetected: boolean;
  meetingId?: string;
  startedAt: string;
}> {
  if (await readState()) throw new Error("Capture already in progress");
  let tabId = opts.tabId;
  if (tabId === undefined) {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (!tab?.id) throw new Error("No active tab");
    const host = tab.url ? new URL(tab.url).hostname : "";
    if (!TEAMS_HOST.test(host)) {
      throw new Error("Open your Teams meeting in the active tab first");
    }
    tabId = tab.id;
  }

  const idToken = await getIdToken();
  const { captionsDetected, ...meetingMeta } = await startInTab(tabId);
  const captureId = crypto.randomUUID();

  // Start failure is tolerated (offline start): finalize upserts by captureId later.
  const meetingId = await registerMeeting(captureId, meetingMeta, idToken);
  await saveCaptureMeta({ captureId, meetingId, ...meetingMeta });
  await writeState({
    activeTabId: tabId,
    captureId,
    meetingId,
    ...(opts.autoStarted && { autoStarted: true }),
    seq: 1,
    pending: [],
    captionPending: [],
    lastFlushAt: Date.now(),
    meetingMeta,
  });
  return {
    captionsDetected: !!captionsDetected,
    meetingId,
    startedAt: meetingMeta.startedAt,
  };
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

const onSegmentFinal = (segment: DiarizedSegment, senderTabId: number | undefined): Promise<void> =>
  withStateLock(async () => {
    const state = await readState();
    if (!state) return;
    if (senderTabId !== state.activeTabId) return;
    // No offscreen document, so the segment checkpoint (the only source crash
    // recovery reads) is maintained here.
    const prior = await getCheckpoint(state.captureId).catch(() => undefined);
    await saveCheckpoint({
      captureId: state.captureId,
      segments: [...(prior?.segments ?? []), segment],
      updatedAt: Date.now(),
    }).catch(() => {});
    if (!state.meetingId) return;
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
      const ok = await api(`/meetings/${encodeURIComponent(state.meetingId)}/segments`, body, await getIdToken())
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

// Captions flow content script → here. IndexedDB keeps the full accumulated timeline
// so a dead tab still finalizes with it.
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

async function finalizeMeeting(
  record: PendingFinalize,
): Promise<{ meetingId?: string; error?: string }> {
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
    const res = await api(`/meetings/${encodeURIComponent(meetingId)}/finalize`, record.payload, idToken).catch(
      () => null,
    );
    if (res?.ok) {
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

  // The content script accumulated the caption-synthesized segments. Tab gone
  // (closed mid-meeting) → fall back to the checkpoint it wrote to IndexedDB.
  const segments: DiarizedSegment[] =
    content?.segments ??
    (await getCheckpoint(state.captureId).catch(() => undefined))?.segments ??
    [];
  const captionCkpt = content
    ? undefined
    : await getCaptionCheckpoint(state.captureId).catch(() => undefined);

  const endedAt = content?.endedAt ?? new Date().toISOString();
  const baseHealth = content?.signalHealth ?? captionCkpt?.signalHealth ?? state.signalHealth;
  const signalHealth: SignalHealth = {
    ...(baseHealth ?? { captionsSeen: false, speakerRingSeen: false, domReadCount: 0 }),
    asrMode: ASR_MODE,
  };

  const payload: MeetingFinalizeRequest = {
    captureId: state.captureId,
    title: state.meetingMeta.title,
    startedAt: state.meetingMeta.startedAt,
    endedAt,
    localUserName: state.meetingMeta.localUserName,
    segments,
    speakerTimeline: content?.speakerTimeline ?? [],
    captionTimeline: content?.captionTimeline ?? captionCkpt?.captionTimeline ?? [],
    ...(content?.highlights?.length && { highlights: content.highlights }),
    ...(content?.participantNames?.length && {
      participantNames: content.participantNames,
    }),
    signalHealth,
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
  if (state) {
    await clearCapture(state.captureId).catch(() => {});
  }
}

// Sweep IndexedDB for captures that never finalized (SW crash, browser exit, failed
// finalize) and finalize them from the checkpointed data — safe by idempotency.
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
      const captions = await getCaptionCheckpoint(meta.captureId).catch(() => undefined);
      // A capture with no segments may still carry the meeting via its caption
      // timeline — discard only when both are empty.
      if (!checkpoint?.segments.length && !captions?.captionTimeline.length) {
        await clearCapture(meta.captureId);
        continue;
      }
      const endedAt = new Date(
        checkpoint?.updatedAt ?? captions?.updatedAt ?? Date.now(),
      ).toISOString();
      await finalizeMeeting({
        captureId: meta.captureId,
        meetingId: meta.meetingId,
        payload: {
          captureId: meta.captureId,
          title: meta.title,
          startedAt: meta.startedAt,
          endedAt,
          localUserName: meta.localUserName,
          segments: checkpoint?.segments ?? [],
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

// --- Auto capture (meeting presence detected by the content script) ----------
//
// Auto-start uses the same captions path as the manual Start: zero cost, zero
// interaction, no offscreen document.

// Serializes concurrent MEETING_DETECTED events (readState alone is check-then-act).
let autoStarting = false;

async function onMeetingDetected(tabId: number | undefined): Promise<void> {
  if (tabId === undefined || autoStarting) return;
  // Claim the flag before the first await, or two near-simultaneous detections
  // both pass the checks and register two meetings.
  autoStarting = true;
  try {
    const { autoCapture } = await chrome.storage.local.get("autoCapture");
    if (autoCapture === false) return;
    // A single capture runs at a time; this also debounces re-detection of the
    // same meeting — the presence observer only re-fires after a debounced leave.
    if (await readState()) return;
    const idToken = await getIdToken().catch(() => null);
    if (!idToken) {
      chrome.notifications.create(`signin-${tabId}`, {
        type: "basic",
        iconUrl: chrome.runtime.getURL("icon-128.png"),
        title: chrome.runtime.getManifest().name,
        message: "Reunión detectada — iniciá sesión en la extensión para capturarla",
      });
      return;
    }
    // Detection is best-effort; a failed start leaves manual capture available.
    await startCapture({ tabId, autoStarted: true }).catch(() => {});
    // Surface the panel. The in-meeting widget (content overlay) always appears;
    // openPopup additionally pops the toolbar panel when Chrome allows it (it
    // refuses without a user gesture on some builds — hence best-effort).
    void chrome.action.openPopup?.()?.catch(() => {});
  } finally {
    autoStarting = false;
  }
}

async function onMeetingEnded(tabId: number | undefined): Promise<void> {
  const state = await readState();
  // Presence loss only ends captures this worker auto-started, and only for the
  // meeting's own tab — a manually started capture keeps its manual stop.
  if (!state?.autoStarted || state.activeTabId !== tabId) return;
  await stopCapture().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "SEGMENT_FINAL") {
    void onSegmentFinal(msg.segment, _s.tab?.id);
    return false;
  }
  if (msg.type === "MEETING_DETECTED") {
    void onMeetingDetected(_s.tab?.id);
    return false;
  }
  if (msg.type === "MEETING_ENDED") {
    void onMeetingEnded(_s.tab?.id);
    return false;
  }
  if (msg.type === "CAPTION_CHECKPOINT") {
    void onCaptionCheckpoint(msg.events, msg.signalHealth, _s.tab?.id);
    return false;
  }
  if (msg.type === "ID_TOKEN_REFRESHED") {
    void chrome.storage.session.set({ idToken: msg.idToken });
    void chrome.storage.local.set({ authIdToken: msg.idToken });
    return false;
  }
  if (msg.type === "GET_STATE") {
    // The popup just refreshed the session token — a good moment to retry orphans.
    void recoverOrphans();
    readState().then((s) =>
      sendResponse({
        capturing: !!s,
        ...(s && {
          meetingId: s.meetingId,
          startedAt: s.meetingMeta.startedAt,
        }),
      }),
    );
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
