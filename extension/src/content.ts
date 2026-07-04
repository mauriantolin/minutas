import type { SpeakerTimelineEntry } from "@teams-agent-core/shared";
import {
  readActiveSpeaker,
  readMeetingTitle,
  readLocalUserName,
} from "./teams-dom-adapter.js";

// Runs inside the Teams PWA. Polls the active-speaker indicator to build the timeline the
// backend uses to recover real names, and renders a live-transcript overlay driven by
// LIVE_LINE messages from the offscreen document.

let timeline: SpeakerTimelineEntry[] = [];
let startEpoch = 0;
let lastName: string | null = null;
let localUserName = "Yo";
let poll: number | undefined;

const POLL_MS = 400;

function tick() {
  const name = readActiveSpeaker();
  if (name && name !== lastName) {
    timeline.push({ t: (Date.now() - startEpoch) / 1000, participantName: name });
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
    timeline = [];
    lastName = null;
    startEpoch = Date.now();
    localUserName = readLocalUserName() || "Yo";
    poll = window.setInterval(tick, POLL_MS);
    createOverlay();
    sendResponse({
      title: readMeetingTitle(),
      localUserName: readLocalUserName(),
      startedAt: new Date(startEpoch).toISOString(),
    });
  } else if (msg.type === "CAPTURE_STOP") {
    if (poll) window.clearInterval(poll);
    removeOverlay();
    sendResponse({ speakerTimeline: timeline, endedAt: new Date().toISOString() });
  } else if (msg.type === "LIVE_LINE") {
    renderLine(msg.source, msg.speakerLabel, msg.text, msg.isPartial);
  }
  return true;
});
