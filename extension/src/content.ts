import type {
  CaptionEvent,
  DiarizedSegment,
  SignalHealth,
  SpeakerTimelineEntry,
} from "@teams-agent-core/shared";
import {
  captionsPresent,
  meetingPresent,
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
// plus signalHealth over both, and renders a live-transcript overlay. The caption
// observer feeds the overlay directly and each final caption is synthesized into a
// DiarizedSegment shipped over the SEGMENT_FINAL path. Captions are the only source.

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
let captionWatchdog: number | undefined;
let captionFlushMark = 0;
let domReadCount = 0;
let speakerRingSeen = false;
let participants = new Set<string>();
let tickCount = 0;
let captionHeartbeatLastT: number | undefined;
let healthDirty = false;

const POLL_MS = 400;
const CAPTION_FLUSH_MS = 5000;
const CAPTION_WATCHDOG_MS = 15_000;

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
  send({ type: "CAPTION_CHECKPOINT", events, signalHealth: signalHealth() });
}

// Captions are the only transcript source, so an empty timeline means nothing is
// being captured. Minutix does not click Teams menus; show a persistent backstop
// notice until captions flow.
function watchCaptions() {
  if (captionTimeline.length > 0) {
    widget?.setNotice(null);
    if (captionWatchdog) window.clearInterval(captionWatchdog);
    captionWatchdog = undefined;
    return;
  }
  if (!meetingPresent()) return;
  widget?.setNotice(
    "Activá los subtítulos de Teams: Configuración > Accesibilidad > Subtítulos",
  );
}

let dead = false;
let presenceStop: (() => void) | undefined;

// The content script outlives extension reloads: the old instance keeps running in
// the Teams tab, but its chrome.runtime is invalidated, so sendMessage throws
// synchronously ("Extension context invalidated") — a trailing .catch can't help.
// Detect the dead context, send nothing, and tear this instance's timers/observers
// down so it goes quiet instead of spamming the console.
function send(msg: unknown) {
  if (dead) return;
  if (!chrome.runtime?.id) return teardown();
  try {
    void chrome.runtime.sendMessage(msg).catch(() => {});
  } catch {
    teardown();
  }
}

function teardown() {
  if (dead) return;
  dead = true;
  if (poll) window.clearInterval(poll);
  if (captionFlushTimer) window.clearInterval(captionFlushTimer);
  if (captionWatchdog) window.clearInterval(captionWatchdog);
  stopCaptions?.();
  presenceStop?.();
  widget?.destroy();
  widget = null;
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
  send({ type: "SEGMENT_FINAL", segment });
}

function onCaptionFinal(e: CaptionEvent) {
  captionTimeline.push(e);
  // The widget already mirrors this line via upsertCaption (keyed, in place); a
  // renderLine here would push a divergent duplicate. Only ship the backend segment.
  if (pendingCaption) shipCaptionSegment(pendingCaption, e.t);
  pendingCaption = e;
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
    if (captionWatchdog) window.clearInterval(captionWatchdog);
    stopCaptions?.();
    stopCaptions = undefined;
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
      (e, lineId) => widget?.upsertCaption(lineId, e.speakerName, e.text),
    );
    captionFlushTimer = window.setInterval(flushCaptions, CAPTION_FLUSH_MS);
    captionWatchdog = window.setInterval(watchCaptions, CAPTION_WATCHDOG_MS);
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
    if (captionWatchdog) window.clearInterval(captionWatchdog);
    captionWatchdog = undefined;
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
      segments: captionSegments,
    });
  }
  return true;
});

// Meeting auto-detection runs for the tab's whole lifetime: the service worker
// decides whether a detected meeting becomes an auto capture.
presenceStop = observeMeetingPresence(
  () => {
    send({
      type: "MEETING_DETECTED",
      title: readMeetingTitle(),
      startedAt: new Date().toISOString(),
    });
  },
  () => {
    send({ type: "MEETING_ENDED" });
  },
);
