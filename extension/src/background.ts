import type { MeetingIngestPayload } from "@teams-agent-core/shared";
import { CONFIG } from "./config.js";

// Orchestrates a capture session across the Teams tab (content script → speaker timeline),
// the offscreen document (audio → Transcribe → segments), and the backend (POST /meetings).
//
// MV3 note: the service worker can be suspended at any time, so capture state lives in
// chrome.storage.session — NOT in module memory — and the popup reads it to reflect an
// in-progress capture instead of showing "Start" again.

type CaptureState = {
  activeTabId: number;
  meetingMeta: { title: string; localUserName: string; startedAt: string };
};

const readState = async (): Promise<CaptureState | undefined> =>
  (await chrome.storage.session.get("capture")).capture;

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

async function startCapture(): Promise<void> {
  if (await readState()) throw new Error("Capture already in progress");
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error("No active tab");
  const host = tab.url ? new URL(tab.url).hostname : "";
  if (!TEAMS_HOST.test(host)) {
    throw new Error("Open your Teams meeting in the active tab first");
  }

  const idToken = await getIdToken();
  const meetingMeta = await startInTab(tab.id);

  const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tab.id });
  await ensureOffscreen();
  await sendToOffscreen({ target: "offscreen", type: "START", streamId, idToken });

  await chrome.storage.session.set({ capture: { activeTabId: tab.id, meetingMeta } });
}

async function stopCapture(): Promise<{ meetingId?: string; error?: string }> {
  const state = await readState();
  if (!state) return { error: "No active capture" };
  await chrome.storage.session.remove("capture");

  const content = await chrome.tabs
    .sendMessage(state.activeTabId, { type: "CAPTURE_STOP" })
    .catch(() => ({ speakerTimeline: [], endedAt: new Date().toISOString() }));
  const offscreen = await chrome.runtime
    .sendMessage({ target: "offscreen", type: "STOP" })
    .catch(() => ({ segments: [] }));
  await chrome.offscreen.closeDocument().catch(() => {});

  const payload: MeetingIngestPayload = {
    title: state.meetingMeta.title,
    startedAt: state.meetingMeta.startedAt,
    endedAt: content.endedAt,
    localUserName: state.meetingMeta.localUserName,
    segments: offscreen.segments ?? [],
    speakerTimeline: content.speakerTimeline ?? [],
  };

  const idToken = await getIdToken();
  const res = await fetch(`${CONFIG.apiUrl}/meetings`, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${idToken}` },
    body: JSON.stringify(payload),
  });
  if (!res.ok) return { error: `Backend ${res.status}` };
  return res.json();
}

/** Discard an orphaned capture without sending anything (recovery). */
async function cancelCapture(): Promise<void> {
  await chrome.storage.session.remove("capture");
  await chrome.runtime.sendMessage({ target: "offscreen", type: "STOP" }).catch(() => {});
  await chrome.offscreen.closeDocument().catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, _s, sendResponse) => {
  if (msg.type === "LIVE_LINE") {
    readState().then((s) => {
      if (s) chrome.tabs.sendMessage(s.activeTabId, msg).catch(() => {});
    });
    return false;
  }
  if (msg.type === "GET_STATE") {
    readState().then((s) => sendResponse({ capturing: !!s }));
    return true;
  }
  if (msg.type === "POPUP_START") {
    startCapture().then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ error: String(e) }));
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
