"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  StartStreamTranscriptionCommand,
  TranscribeStreamingClient,
  type AudioStream,
  type TranscriptResultStream,
} from "@aws-sdk/client-transcribe-streaming";
import { fromCognitoIdentityPool } from "@aws-sdk/credential-provider-cognito-identity";
import { CONFIG } from "./config";

const TARGET_SAMPLE_RATE = 16000;

/** Runs inside the AudioWorklet scope; buffers ~43 ms of mono audio per message. */
const WORKLET_SOURCE = `
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buffer = new Float32Array(2048);
    this.offset = 0;
  }
  process(inputs) {
    const channel = inputs[0] && inputs[0][0];
    if (!channel) return true;
    let i = 0;
    while (i < channel.length) {
      const n = Math.min(channel.length - i, this.buffer.length - this.offset);
      this.buffer.set(channel.subarray(i, i + n), this.offset);
      this.offset += n;
      i += n;
      if (this.offset === this.buffer.length) {
        this.port.postMessage(this.buffer.slice());
        this.offset = 0;
      }
    }
    return true;
  }
}
registerProcessor("pcm-capture", PcmCaptureProcessor);
`;

/** Linear-interpolation decimator: native-rate Float32 → 16 kHz Int16 PCM LE. */
function toPcm16k(input: Float32Array, sourceRate: number): Uint8Array {
  const ratio = sourceRate / TARGET_SAMPLE_RATE;
  const length = Math.floor(input.length / ratio);
  const out = new Int16Array(length);
  for (let i = 0; i < length; i++) {
    const pos = i * ratio;
    const lo = Math.floor(pos);
    const hi = Math.min(lo + 1, input.length - 1);
    const frac = pos - lo;
    const sample = input[lo] * (1 - frac) + input[hi] * frac;
    const clamped = Math.max(-1, Math.min(1, sample));
    out[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff;
  }
  return new Uint8Array(out.buffer, out.byteOffset, out.byteLength);
}

class AsyncQueue<T> {
  private items: T[] = [];
  private waiters: ((value: T | null) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter(item);
    else this.items.push(item);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter(null);
  }

  next(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (this.closed) return Promise.resolve(null);
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}

async function* audioEvents(queue: AsyncQueue<Uint8Array>): AsyncGenerator<AudioStream> {
  for (;;) {
    const chunk = await queue.next();
    if (!chunk) return;
    yield { AudioEvent: { AudioChunk: chunk } };
  }
}

function startErrorMessage(err: unknown): string {
  if (err instanceof DOMException && (err.name === "NotAllowedError" || err.name === "SecurityError"))
    return "Permití el acceso al micrófono para dictar.";
  if (err instanceof DOMException && err.name === "NotFoundError")
    return "No se encontró ningún micrófono.";
  return "No se pudo iniciar el dictado.";
}

interface Session {
  queue: AsyncQueue<Uint8Array>;
  media: MediaStream;
  ctx: AudioContext;
  client: TranscribeStreamingClient;
}

export type TranscribeStatus = "idle" | "recording" | "error";

export interface TranscribeStream {
  status: TranscribeStatus;
  /** In-flight hypothesis for the current segment (replaced continuously). */
  partial: string;
  /** Accumulated finalized transcript segments, space-joined. */
  finalText: string;
  error?: string;
  start: () => Promise<void>;
  stop: () => void;
  reset: () => void;
}

/**
 * Browser dictation via Amazon Transcribe Streaming (es-US, PCM 16 kHz),
 * authenticated with the Cognito Identity Pool using the caller's id token.
 * `stop()` closes the audio stream; `status` returns to "idle" only after the
 * last transcript events drained, so `finalText` is complete at that point.
 */
export function useTranscribeStream(token: string | null): TranscribeStream {
  const [status, setStatus] = useState<TranscribeStatus>("idle");
  const [partial, setPartial] = useState("");
  const [finalText, setFinalText] = useState("");
  const [error, setError] = useState<string | undefined>(undefined);
  const sessionRef = useRef<Session | null>(null);
  const activeRef = useRef(false);

  const finish = useCallback((session: Session) => {
    if (sessionRef.current === session) sessionRef.current = null;
    activeRef.current = false;
    session.queue.close();
    for (const track of session.media.getTracks()) track.stop();
    void session.ctx.close().catch(() => {});
    session.client.destroy();
  }, []);

  const consume = useCallback(
    async (stream: AsyncIterable<TranscriptResultStream> | undefined, session: Session) => {
      try {
        for await (const event of stream ?? []) {
          for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
            const text = result.Alternatives?.[0]?.Transcript ?? "";
            if (!text) continue;
            if (result.IsPartial) {
              setPartial(text);
            } else {
              setFinalText((prev) => (prev ? `${prev} ${text}` : text));
              setPartial("");
            }
          }
        }
        setStatus((s) => (s === "recording" ? "idle" : s));
      } catch {
        setError("Se cortó la transcripción. Probá de nuevo.");
        setStatus("error");
      } finally {
        setPartial("");
        finish(session);
      }
    },
    [finish],
  );

  const start = useCallback(async () => {
    if (activeRef.current) return;
    if (!token) {
      setError("Iniciá sesión de nuevo para poder dictar.");
      setStatus("error");
      return;
    }
    activeRef.current = true;
    setPartial("");
    setError(undefined);
    setStatus("recording");
    const queue = new AsyncQueue<Uint8Array>();
    let media: MediaStream | undefined;
    let ctx: AudioContext | undefined;
    try {
      media = await navigator.mediaDevices.getUserMedia({
        audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
      });
      ctx = new AudioContext();
      const workletUrl = URL.createObjectURL(
        new Blob([WORKLET_SOURCE], { type: "application/javascript" }),
      );
      try {
        await ctx.audioWorklet.addModule(workletUrl);
      } finally {
        URL.revokeObjectURL(workletUrl);
      }
      const sourceRate = ctx.sampleRate;
      const node = new AudioWorkletNode(ctx, "pcm-capture");
      node.port.onmessage = (e: MessageEvent<Float32Array>) =>
        queue.push(toPcm16k(e.data, sourceRate));
      ctx.createMediaStreamSource(media).connect(node);

      const client = new TranscribeStreamingClient({
        region: CONFIG.region,
        credentials: fromCognitoIdentityPool({
          clientConfig: { region: CONFIG.region },
          identityPoolId: CONFIG.identityPoolId,
          logins: {
            [`cognito-idp.${CONFIG.region}.amazonaws.com/${CONFIG.userPoolId}`]: token,
          },
        }),
      });
      const session: Session = { queue, media, ctx, client };
      sessionRef.current = session;

      const res = await client.send(
        new StartStreamTranscriptionCommand({
          LanguageCode: "es-US",
          MediaEncoding: "pcm",
          MediaSampleRateHertz: TARGET_SAMPLE_RATE,
          AudioStream: audioEvents(queue),
        }),
      );
      void consume(res.TranscriptResultStream, session);
    } catch (err) {
      sessionRef.current = null;
      activeRef.current = false;
      queue.close();
      media?.getTracks().forEach((track) => track.stop());
      void ctx?.close().catch(() => {});
      setError(startErrorMessage(err));
      setStatus("error");
    }
  }, [token, consume]);

  const stop = useCallback(() => {
    const session = sessionRef.current;
    if (!session) return;
    session.queue.close();
    for (const track of session.media.getTracks()) track.stop();
  }, []);

  const reset = useCallback(() => {
    if (activeRef.current) return;
    setStatus("idle");
    setPartial("");
    setFinalText("");
    setError(undefined);
  }, []);

  useEffect(() => {
    return () => {
      const session = sessionRef.current;
      if (session) {
        sessionRef.current = null;
        activeRef.current = false;
        session.queue.close();
        for (const track of session.media.getTracks()) track.stop();
        void session.ctx.close().catch(() => {});
        session.client.destroy();
      }
    };
  }, []);

  return { status, partial, finalText, error, start, stop, reset };
}
