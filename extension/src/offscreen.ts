import type { AudioSource, DiarizedSegment } from "@teams-agent-core/shared";
import { transcribeCredentialsFromToken } from "./offscreen-creds.js";
import { transcribeStream } from "./transcribe.js";
import { CONFIG } from "./config.js";

// The offscreen document does the audio work a service worker can't: getUserMedia, an
// AudioContext, and long-lived Transcribe streams. It captures the tab audio (everyone
// else) and the mic (the local user), streams both to Transcribe, emits live results for
// the in-page overlay, and accumulates finalized segments for storage.

const segments: DiarizedSegment[] = [];
type Source = { endInput: () => void; teardown: () => void; loop: Promise<void> };
let sources: Source[] = [];

function emitLive(r: { source: AudioSource; speakerLabel: string; text: string; isPartial: boolean }) {
  chrome.runtime.sendMessage({ type: "LIVE_LINE", ...r }).catch(() => {});
}

async function startSource(source: AudioSource, media: MediaStream, idToken: string): Promise<void> {
  const ctx = new AudioContext({ sampleRate: CONFIG.sampleRate });
  await ctx.audioWorklet.addModule(chrome.runtime.getURL("pcm-worklet.js"));
  const node = ctx.createMediaStreamSource(media);
  const worklet = new AudioWorkletNode(ctx, "pcm-processor");
  const sink = ctx.createGain();
  sink.gain.value = 0;

  const queue: Uint8Array[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;

  worklet.port.onmessage = (e: MessageEvent<ArrayBuffer>) => {
    queue.push(new Uint8Array(e.data));
    resolveNext?.();
    resolveNext = null;
  };
  node.connect(worklet);
  worklet.connect(sink);
  sink.connect(ctx.destination);

  const endInput = () => {
    done = true;
    resolveNext?.();
  };
  const teardown = () => {
    worklet.port.onmessage = null;
    node.disconnect();
    worklet.disconnect();
    sink.disconnect();
    media.getTracks().forEach((t) => t.stop());
    void ctx.close();
  };

  const chunks = (async function* () {
    while (!done) {
      if (queue.length === 0) await new Promise<void>((r) => (resolveNext = r));
      while (queue.length) yield queue.shift()!;
    }
  })();

  const creds = transcribeCredentialsFromToken(idToken);
  // Ending the input lets Transcribe flush the final result for the in-flight partial —
  // this is what keeps the last utterance from being lost on stop.
  const loop = (async () => {
    for await (const seg of transcribeStream(source, chunks, creds, emitLive)) {
      segments.push(seg);
    }
  })();

  sources.push({ endInput, teardown, loop });
}

async function start(streamId: string, idToken: string) {
  segments.length = 0;
  sources = [];

  const tabMedia = await navigator.mediaDevices.getUserMedia({
    audio: {
      // @ts-expect-error chrome tab capture constraints
      mandatory: { chromeMediaSource: "tab", chromeMediaSourceId: streamId },
    },
  });
  void startSource("tab", tabMedia, idToken);

  try {
    // Echo/noise cancellation is critical: without it the mic picks up the OTHER person's
    // voice leaking from the laptop speakers, and that audio gets labeled as the local user.
    const mic = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    void startSource("mic", mic, idToken);
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
const GRACE_MS = 2000;

async function stopAndDrain(): Promise<DiarizedSegment[]> {
  await new Promise((r) => setTimeout(r, GRACE_MS));
  sources.forEach((s) => s.endInput());
  // Wait for Transcribe to emit the final results after input ends (bounded).
  await Promise.race([
    Promise.allSettled(sources.map((s) => s.loop)),
    new Promise((r) => setTimeout(r, 8000)),
  ]);
  sources.forEach((s) => s.teardown());
  return segments;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.target !== "offscreen") return;
  if (msg.type === "START") {
    void start(msg.streamId, msg.idToken);
    sendResponse({ ok: true });
  } else if (msg.type === "STOP") {
    stopAndDrain().then((segs) => sendResponse({ segments: segs }));
    return true;
  }
  return true;
});
