import type { AwsCredentialIdentity } from "@aws-sdk/types";
import type { AudioSource, DiarizedSegment } from "@teams-agent-core/shared";
import { transcribeCredentialsFromToken, refreshedTranscribeCredentials } from "./offscreen-creds.js";
import { transcribeStream } from "./transcribe.js";
import { saveCheckpoint } from "./idb.js";
import { CONFIG } from "./config.js";

// The offscreen document does the audio work a service worker can't: getUserMedia, an
// AudioContext, and long-lived Transcribe streams. It captures the tab audio (everyone
// else) and the mic (the local user), streams both to Transcribe, emits live results for
// the in-page overlay, and accumulates finalized segments for storage.
//
// Each source runs a rotation-capable pipe: the worklet queue is the buffer of record and
// Transcribe streams are disposable consumers. Ending a stream makes Transcribe flush the
// in-flight utterance as final — a hard segment boundary — so credential rotation and VAD
// gating both work by ending the current stream and starting a new one, while audio keeps
// buffering in the queue (nothing is lost across the swap).

// Checkpoint on every final: the crash-recovery finalize path reads only this
// checkpoint, so any staleness is speech permanently lost on browser exit.
const CHECKPOINT_EVERY_FINALS = 1;
const CREDS_REFRESH_MS = 50 * 60 * 1000;
const CREDS_REFRESH_MARGIN_MS = 5 * 60 * 1000;
const CREDS_RETRY_MS = 30 * 1000;
const GRACE_MS = 2000;
const DRAIN_TIMEOUT_MS = 8000;
const STREAM_ERROR_BACKOFF_MS = 1000;
// Bound the worklet queue so a sustained Transcribe outage degrades (oldest
// audio dropped, timestamps re-anchored) instead of growing until the
// offscreen document is OOM-killed with the whole capture buffer.
const MAX_QUEUE_CHUNKS = 22_500; // ~3 min at the worklet's 8 ms chunk cadence

// Transcribe bills on audio sent, and the mic is mostly silence in a typical meeting.
// The gate stops feeding frames after 2 s of sustained silence (hysteresis wide enough to
// not chop normal speech pauses) and resumes on energy, replaying a short pre-roll so
// word onsets aren't clipped.
const VAD_RMS_THRESHOLD = 0.015;
const VAD_SILENCE_MS = 2000;
const VAD_PREROLL_S = 0.3;

const segments: DiarizedSegment[] = [];
let finalsSinceCheckpoint = 0;
let captureId = "";
let captureEpoch = 0;
let credentials: () => Promise<AwsCredentialIdentity>;
let refreshTimer: ReturnType<typeof setTimeout> | undefined;
let refreshing: Promise<void> | undefined;

type Pipe = { rotate: () => void; endInput: () => void; teardown: () => void; done: Promise<void> };
let pipes: Pipe[] = [];

function emitLive(r: { source: AudioSource; speakerLabel: string; text: string; isPartial: boolean }) {
  chrome.runtime.sendMessage({ type: "LIVE_LINE", ...r }).catch(() => {});
}

function pushFinal(seg: DiarizedSegment) {
  segments.push(seg);
  chrome.runtime.sendMessage({ type: "SEGMENT_FINAL", segment: seg }).catch(() => {});
  if (++finalsSinceCheckpoint >= CHECKPOINT_EVERY_FINALS) {
    finalsSinceCheckpoint = 0;
    saveCheckpoint({ captureId, segments: [...segments], updatedAt: Date.now() }).catch(() => {});
  }
}

function rms(bytes: Uint8Array): number {
  const samples = new Int16Array(bytes.buffer, bytes.byteOffset, bytes.byteLength >> 1);
  let sum = 0;
  for (let i = 0; i < samples.length; i++) {
    const v = samples[i]! / 32768;
    sum += v * v;
  }
  return Math.sqrt(sum / (samples.length || 1));
}

async function startSource(source: AudioSource, media: MediaStream, gated: boolean): Promise<void> {
  const ctx = new AudioContext({ sampleRate: CONFIG.sampleRate });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const node = ctx.createMediaStreamSource(media);
  const worklet = new AudioWorkletNode(ctx, "pcm-processor");
  const sink = ctx.createGain();
  sink.gain.value = 0;

  type Chunk = { data: Uint8Array; t: number };
  const queue: Chunk[] = [];
  const preroll: Chunk[] = [];
  let paused = false;
  let silentSince = 0;
  let ended = false;
  let rotateRequested = false;
  let wake: (() => void) | null = null;
  const waitWake = () => new Promise<void>((r) => (wake = r));
  const notify = () => {
    wake?.();
    wake = null;
  };

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    if (ended) return;
    const chunk = { data: new Uint8Array(e.data), t: (Date.now() - captureEpoch) / 1000 };
    if (gated) {
      if (rms(chunk.data) >= VAD_RMS_THRESHOLD) {
        silentSince = 0;
        if (paused) {
          paused = false;
          // If the previous stream is still draining a backlog, splicing the
          // preroll into it would hide the silent gap from Transcribe's clock
          // and skew every later timestamp on that stream; force a fresh
          // stream so the offset re-anchors at the resumed audio.
          rotateRequested = true;
          queue.push(...preroll.splice(0));
        }
      } else if (!paused) {
        if (!silentSince) silentSince = Date.now();
        else if (Date.now() - silentSince >= VAD_SILENCE_MS) paused = true;
      }
      if (paused) {
        preroll.push(chunk);
        while (preroll.length && chunk.t - preroll[0]!.t > VAD_PREROLL_S) preroll.shift();
        notify();
        return;
      }
    }
    queue.push(chunk);
    if (queue.length > MAX_QUEUE_CHUNKS) {
      queue.shift();
      rotateRequested = true;
    }
    notify();
  };
  node.connect(worklet);
  worklet.connect(sink);
  sink.connect(ctx.destination);

  const endInput = () => {
    ended = true;
    notify();
  };
  const rotate = () => {
    rotateRequested = true;
    notify();
  };
  const teardown = () => {
    worklet.port.onmessage = null;
    node.disconnect();
    worklet.disconnect();
    sink.disconnect();
    media.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const done = (async () => {
    while (!ended || queue.length > 0) {
      if (queue.length === 0) {
        await waitWake();
        continue;
      }
      // Transcribe's clock is relative to the audio sent on this stream; anchor it to the
      // capture-relative time of the first chunk it will receive.
      const offset = queue[0]!.t;
      rotateRequested = false;
      const feed = (async function* () {
        while (!rotateRequested) {
          if (queue.length > 0) {
            yield queue.shift()!.data;
            continue;
          }
          if (ended || (gated && paused)) return;
          await waitWake();
        }
      })();
      await (async () => {
        for await (const seg of transcribeStream(source, feed, () => credentials(), emitLive)) {
          pushFinal({ ...seg, startTime: seg.startTime + offset, endTime: seg.endTime + offset });
        }
      })().catch(async (err) => {
        // An auth failure means the cached idToken/creds are dead — retrying
        // with the same ones would loop forever.
        if (isAuthError(err)) await refreshCredentials();
        await new Promise((r) => setTimeout(r, STREAM_ERROR_BACKOFF_MS));
      });
    }
  })();

  pipes.push({ rotate, endInput, teardown, done });
}

function tokenExpiryMs(idToken: string): number {
  const payload = atob(idToken.split(".")[1]!.replace(/-/g, "+").replace(/_/g, "/"));
  return (JSON.parse(payload) as { exp: number }).exp * 1000;
}

// The popup may hand over a token minted long before Start was pressed, so the
// first refresh must lead the token's own expiry, not the capture start.
function refreshDelayMs(idToken: string): number {
  const untilExpiry = tokenExpiryMs(idToken) - CREDS_REFRESH_MARGIN_MS - Date.now();
  return Math.max(Math.min(untilExpiry, CREDS_REFRESH_MS), 0);
}

function scheduleRefresh(delayMs: number) {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => void refreshCredentials(), delayMs);
}

const isAuthError = (err: unknown) =>
  /NotAuthorized|ExpiredToken|Unrecognized|AccessDenied|Forbidden/.test(
    (err as Error)?.name ?? "",
  ) || (err as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode === 403;

function refreshCredentials(): Promise<void> {
  refreshing ??= (async () => {
    const fresh = await refreshedTranscribeCredentials().catch(() => null);
    // A transient refresh failure must retry soon — giving up here leaves both
    // streams to die silently at the 60-min token/cred expiry.
    if (!fresh) {
      scheduleRefresh(CREDS_RETRY_MS);
      return;
    }
    credentials = fresh.credentials;
    chrome.runtime.sendMessage({ type: "ID_TOKEN_REFRESHED", idToken: fresh.idToken }).catch(() => {});
    // Streams opened with the old creds would die at the 60-min mark; rotate them now.
    pipes.forEach((p) => p.rotate());
    scheduleRefresh(refreshDelayMs(fresh.idToken));
  })().finally(() => (refreshing = undefined));
  return refreshing;
}

async function start(streamId: string, idToken: string, id: string) {
  segments.length = 0;
  finalsSinceCheckpoint = 0;
  pipes = [];
  captureId = id;
  captureEpoch = Date.now();
  credentials = transcribeCredentialsFromToken(idToken);
  scheduleRefresh(refreshDelayMs(idToken));

  const tabMedia = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error chrome tab capture constraints
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });
  void startSource("tab", tabMedia, false);

  try {
    // Echo/noise cancellation is critical: without it the mic picks up the OTHER person's
    // voice leaking from the laptop speakers, and that audio gets labeled as the local user.
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    void startSource("mic", mic, true);
  } catch {
    // Surface it — usually a missing mic permission (grant it from the popup).
    emitLive({
      source: "mic",
      speakerLabel: "⚠",
      text: "Micrófono no disponible — habilitalo desde el popup de la extensión",
      isPartial: false,
    });
  }
}

// Keep capturing briefly after Stop so Transcribe can finalize the last utterance (its
// results lag the audio); only then end the input and drain the final events.
async function stopAndDrain(): Promise<DiarizedSegment[]> {
  clearTimeout(refreshTimer);
  await new Promise((r) => setTimeout(r, GRACE_MS));
  pipes.forEach((p) => p.endInput());
  await Promise.race([
    Promise.allSettled(pipes.map((p) => p.done)),
    new Promise((r) => setTimeout(r, DRAIN_TIMEOUT_MS)),
  ]);
  pipes.forEach((p) => p.teardown());
  await saveCheckpoint({ captureId, segments: [...segments], updatedAt: Date.now() }).catch(() => {});
  return segments;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "START") {
    // Ack only once the audio stream is actually open — a synchronous ok would
    // let the service worker record an active capture that records nothing.
    start(msg.streamId, msg.idToken, msg.captureId)
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ error: String(e) }));
  } else if (msg.type === "STOP") {
    stopAndDrain().then((segs) => sendResponse({ segments: segs }));
  }
  return true;
});
