import type { CaptionEvent, SignalHealth, SpeakerTimelineEntry } from "@teams-agent-core/shared";
import {
  captionsPresent,
  observeCaptions,
  readActiveSpeaker,
  readMeetingTitle,
  readLocalUserName,
} from "./teams-dom-adapter.js";

// Runs inside the Teams PWA. Captures the two free DOM signals — live captions
// (MutationObserver, primary) and the active-speaker ring (400 ms poll, fallback) —
// plus signalHealth over both, and renders a live-transcript overlay driven by
// LIVE_LINE messages from the offscreen document.

let timeline: SpeakerTimelineEntry[] = [];
let captionTimeline: CaptionEvent[] = [];
let startEpoch = 0;
let lastName: string | null = null;
let localUserName = "Yo";
let poll: number | undefined;

let stopCaptions: (() => void) | undefined;
let captionFlushTimer: number | undefined;
let captionFlushMark = 0;
let domReadCount = 0;
let speakerRingSeen = false;
let captionHeartbeatLastT: number | undefined;
let healthDirty = false;

const POLL_MS = 400;
const CAPTION_FLUSH_MS = 5000;

const nowT = () => (Date.now() - startEpoch) / 1000;

function signalHealth(): SignalHealth {
  return {
    captionsSeen: captionTimeline.length > 0,
    speakerRingSeen,
    domReadCount,
    ...(captionHeartbeatLastT !== undefined && { captionHeartbeatLastT }),
  };
}

// Ships new final captions + current signalHealth to the service worker, which
// persists them to IndexedDB (crash recovery) and batches them to the backend.
// Best-effort: the full timeline stays here and travels on CAPTURE_STOP anyway.
function flushCaptions() {
  const events = captionTimeline.slice(captionFlushMark);
  if (events.length === 0 && !healthDirty) return;
  captionFlushMark = captionTimeline.length;
  healthDirty = false;
  chrome.runtime
    .sendMessage({ type: "CAPTION_CHECKPOINT", events, signalHealth: signalHealth() })
    .catch(() => {});
}

function tick() {
  const name = readActiveSpeaker();
  if (!name) return;
  domReadCount += 1;
  // Every successful ring read refreshes health, so captions-off meetings keep
  // checkpointing an accurate domReadCount instead of freezing at the first one.
  healthDirty = true;
  speakerRingSeen = true;
  if (name !== lastName) {
    timeline.push({ t: nowT(), participantName: name });
    lastName = name;
  }
}

// --- Live overlay ---------------------------------------------------------

let panel: HTMLElement | null = null;
let linesEl: HTMLElement | null = null;
let interimEl: HTMLElement | null = null;

function createOverlay() {
  removeOverlay();
  panel = document.createElement("div");
  panel.style.cssText =
    "position:fixed;bottom:16px;right:16px;width:340px;max-height:320px;z-index:2147483647;" +
    "background:rgba(20,20,28,.92);color:#fff;border-radius:10px;font:13px system-ui;" +
    "box-shadow:0 4px 20px #0006;display:flex;flex-direction:column;overflow:hidden";
  panel.innerHTML =
    '<div style="padding:8px 12px;background:#5b5fc7;font-weight:600;display:flex;gap:6px;align-items:center">' +
    '<span style="width:8px;height:8px;border-radius:50%;background:#ff5c5c;animation:tac-pulse 1s infinite"></span>' +
    "Transcripción en vivo</div>" +
    '<div id="tac-lines" style="padding:10px 12px;overflow:auto;flex:1"></div>' +
    '<div id="tac-interim" style="padding:0 12px 10px;color:#aab;font-style:italic"></div>' +
    "<style>@keyframes tac-pulse{50%{opacity:.3}}</style>";
  document.body.appendChild(panel);
  linesEl = panel.querySelector("#tac-lines");
  interimEl = panel.querySelector("#tac-interim");
}

function removeOverlay() {
  panel?.remove();
  panel = linesEl = interimEl = null;
}

function labelFor(source: string, speakerLabel: string): string {
  if (source === "mic") return localUserName;
  return lastName || speakerLabel;
}

function renderLine(source: string, speakerLabel: string, text: string, isPartial: boolean) {
  if (!linesEl || !interimEl) return;
  const label = labelFor(source, speakerLabel);
  if (isPartial) {
    interimEl.textContent = `${label}: ${text}`;
  } else {
    const p = document.createElement("div");
    p.style.margin = "4px 0";
    p.innerHTML = `<strong style="color:#a9adf5">${label}:</strong> `;
    p.appendChild(document.createTextNode(text));
    linesEl.appendChild(p);
    linesEl.scrollTop = linesEl.scrollHeight;
    interimEl.textContent = "";
  }
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CAPTURE_START") {
    // Tear down any leftover previous session BEFORE resetting state: its stop
    // callback finalizes pending utterances into the OLD timeline (discarded
    // below), and its timers must not keep running alongside the new ones.
    if (poll) window.clearInterval(poll);
    if (captionFlushTimer) window.clearInterval(captionFlushTimer);
    stopCaptions?.();
    stopCaptions = undefined;
    timeline = [];
    captionTimeline = [];
    captionFlushMark = 0;
    domReadCount = 0;
    speakerRingSeen = false;
    captionHeartbeatLastT = undefined;
    healthDirty = false;
    lastName = null;
    startEpoch = Date.now();
    localUserName = readLocalUserName() || "Yo";
    poll = window.setInterval(tick, POLL_MS);
    stopCaptions = observeCaptions(
      nowT,
      (e) => captionTimeline.push(e),
      () => {
        captionHeartbeatLastT = nowT();
        domReadCount += 1;
        healthDirty = true;
      },
    );
    captionFlushTimer = window.setInterval(flushCaptions, CAPTION_FLUSH_MS);
    createOverlay();
    sendResponse({
      title: readMeetingTitle(),
      localUserName: readLocalUserName(),
      startedAt: new Date(startEpoch).toISOString(),
      captionsDetected: captionsPresent(),
    });
  } else if (msg.type === "CAPTURE_STOP") {
    if (poll) window.clearInterval(poll);
    if (captionFlushTimer) window.clearInterval(captionFlushTimer);
    stopCaptions?.();
    stopCaptions = undefined;
    // Close the timeline: interval building assumes each reading holds until
    // the next one, so without a closing reading the final speaker's span
    // (the whole meeting, for a single presenter) yields no interval.
    if (lastName) timeline.push({ t: nowT(), participantName: lastName });
    removeOverlay();
    sendResponse({
      speakerTimeline: timeline,
      captionTimeline,
      signalHealth: signalHealth(),
      endedAt: new Date().toISOString(),
    });
  } else if (msg.type === "LIVE_LINE") {
    renderLine(msg.source, msg.speakerLabel, msg.text, msg.isPartial);
  }
  return true;
});
