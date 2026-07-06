import type {
  CaptionEvent,
  DiarizedSegment,
  SignalHealth,
  SpeakerTimelineEntry,
} from "@teams-agent-core/shared";
import {
  captionsPresent,
  enableCaptions,
  observeCaptions,
  observeMeetingPresence,
  readActiveSpeaker,
  readMeetingTitle,
  readLocalUserName,
  readParticipants,
} from "./teams-dom-adapter.js";
import { mountWidget, type LiveWidget, type TagId } from "./widget.js";

// Runs inside the Teams PWA. Captures the two free DOM signals — live captions
// (MutationObserver, primary) and the active-speaker ring (400 ms poll, fallback) —
// plus signalHealth over both, and renders a live-transcript overlay. In audio mode
// the overlay is driven by LIVE_LINE messages from the offscreen document; in
// captions mode the caption observer feeds it directly and each final caption is
// synthesized into a DiarizedSegment shipped over the same SEGMENT_FINAL path the
// offscreen document uses.

type CaptureMode = "audio" | "captions";

let captureMode: CaptureMode = "audio";
let timeline: SpeakerTimelineEntry[] = [];
let captionTimeline: CaptionEvent[] = [];
let captionSegments: DiarizedSegment[] = [];
let pendingCaption: CaptionEvent | null = null;
let startEpoch = 0;
let lastName: string | null = null;
let localUserName = "Yo";
let poll: number | undefined;

let stopCaptions: (() => void) | undefined;
let captionFlushTimer: number | undefined;
let captionFlushMark = 0;
let domReadCount = 0;
let speakerRingSeen = false;
let participants = new Set<string>();
let tickCount = 0;
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
  widget?.updateHealth(signalHealth());
  const events = captionTimeline.slice(captionFlushMark);
  if (events.length === 0 && !healthDirty) return;
  captionFlushMark = captionTimeline.length;
  healthDirty = false;
  chrome.runtime
    .sendMessage({ type: "CAPTION_CHECKPOINT", events, signalHealth: signalHealth() })
    .catch(() => {});
}

function tick() {
  // Roster/nametag sampling is heavier than the ring read — every ~4 s is plenty.
  if (tickCount++ % 10 === 0) {
    for (const n of readParticipants()) participants.add(n);
  }
  const name = readActiveSpeaker();
  if (!name) return;
  participants.add(name);
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

// --- Live widget (§4.2) -----------------------------------------------------

let widget: LiveWidget | null = null;
let highlights: { t: number; tag: TagId }[] = [];

// Widget tag taps ride the CAPTURE_STOP response into the finalize payload
// (MeetingFinalizeRequest.highlights), so they persist with the raw artifact.
function recordHighlight(tag: TagId) {
  highlights.push({ t: nowT(), tag });
}

function labelFor(source: string, speakerLabel: string): string {
  if (source === "mic") return localUserName;
  return lastName || speakerLabel;
}

// --- Captions-primary segments (captions ARE the transcript) -----------------

// A caption's true end isn't observable, so segment N ships when final N+1
// arrives (endTime = its t); the last one is flushed on stop with an estimate.
const estimatedEndTime = (e: CaptionEvent): number =>
  e.t + Math.max(1.5, 0.35 * e.text.split(/\s+/).filter(Boolean).length);

function shipCaptionSegment(e: CaptionEvent, endTime: number) {
  const segment: DiarizedSegment = {
    source: "caption",
    speakerLabel: e.speakerName,
    startTime: e.t,
    endTime,
    text: e.text,
  };
  captionSegments.push(segment);
  chrome.runtime.sendMessage({ type: "SEGMENT_FINAL", segment }).catch(() => {});
}

function onCaptionFinal(e: CaptionEvent) {
  captionTimeline.push(e);
  if (captureMode !== "captions") return;
  if (pendingCaption) shipCaptionSegment(pendingCaption, e.t);
  pendingCaption = e;
  widget?.renderLine(e.speakerName, e.text, false);
}

function flushPendingCaptionSegment() {
  if (!pendingCaption) return;
  shipCaptionSegment(pendingCaption, estimatedEndTime(pendingCaption));
  pendingCaption = null;
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
    captureMode = msg.mode === "captions" ? "captions" : "audio";
    timeline = [];
    captionTimeline = [];
    captionSegments = [];
    pendingCaption = null;
    captionFlushMark = 0;
    domReadCount = 0;
    speakerRingSeen = false;
    participants = new Set();
    tickCount = 0;
    captionHeartbeatLastT = undefined;
    healthDirty = false;
    lastName = null;
    startEpoch = Date.now();
    localUserName = readLocalUserName() || "Yo";
    poll = window.setInterval(tick, POLL_MS);
    stopCaptions = observeCaptions(
      nowT,
      onCaptionFinal,
      () => {
        captionHeartbeatLastT = nowT();
        domReadCount += 1;
        healthDirty = true;
      },
      (e) => {
        if (captureMode === "captions") widget?.renderLine(e.speakerName, e.text, true);
      },
    );
    captionFlushTimer = window.setInterval(flushCaptions, CAPTION_FLUSH_MS);
    highlights = [];
    widget?.destroy();
    widget = mountWidget({ startEpoch, onTag: recordHighlight });
    sendResponse({
      title: readMeetingTitle(),
      localUserName: readLocalUserName(),
      startedAt: new Date(startEpoch).toISOString(),
      captionsDetected: captionsPresent(),
    });
  } else if (msg.type === "CAPTURE_STOP") {
    if (poll) window.clearInterval(poll);
    if (captionFlushTimer) window.clearInterval(captionFlushTimer);
    // stopCaptions finalizes still-tracked utterances → onCaptionFinal may ship
    // one more segment and leave a new pendingCaption, so flush after it.
    stopCaptions?.();
    stopCaptions = undefined;
    flushPendingCaptionSegment();
    // Close the timeline: interval building assumes each reading holds until
    // the next one, so without a closing reading the final speaker's span
    // (the whole meeting, for a single presenter) yields no interval.
    if (lastName) timeline.push({ t: nowT(), participantName: lastName });
    widget?.destroy();
    widget = null;
    if (localUserName && localUserName !== "Yo") participants.add(localUserName);
    sendResponse({
      speakerTimeline: timeline,
      captionTimeline,
      highlights,
      participantNames: [...participants],
      signalHealth: signalHealth(),
      endedAt: new Date().toISOString(),
      ...(captureMode === "captions" && { segments: captionSegments }),
    });
  } else if (msg.type === "LIVE_LINE") {
    widget?.renderLine(labelFor(msg.source, msg.speakerLabel), msg.text, msg.isPartial);
  } else if (msg.type === "ENABLE_CAPTIONS") {
    if (captionsPresent()) {
      sendResponse({ enabled: true });
    } else {
      void enableCaptions().then((enabled) => sendResponse({ enabled }));
    }
  }
  return true;
});

// Meeting auto-detection runs for the tab's whole lifetime: the service worker
// decides whether a detected meeting becomes an auto capture.
observeMeetingPresence(
  () => {
    chrome.runtime
      .sendMessage({
        type: "MEETING_DETECTED",
        title: readMeetingTitle(),
        startedAt: new Date().toISOString(),
      })
      .catch(() => {});
  },
  () => {
    chrome.runtime.sendMessage({ type: "MEETING_ENDED" }).catch(() => {});
  },
);
