import {
  TranscribeStreamingClient,
  StartStreamTranscriptionCommand,
} from "@aws-sdk/client-transcribe-streaming";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import type { AudioSource, DiarizedSegment } from "@teams-agent-core/shared";
import { CONFIG } from "./config.js";

/**
 * Streams one PCM audio source to Amazon Transcribe with speaker diarization and yields
 * finalized (non-partial) segments. Runs directly from the browser using temp credentials
 * from the Cognito Identity Pool — audio never touches our backend.
 */
export interface LiveResult {
  source: AudioSource;
  speakerLabel: string;
  text: string;
  isPartial: boolean;
}

export async function* transcribeStream(
  source: AudioSource,
  pcmChunks: AsyncIterable<Uint8Array>,
  credentials: () => Promise<AwsCredentialIdentity>,
  onResult?: (r: LiveResult) => void,
): AsyncGenerator<DiarizedSegment> {
  const client = new TranscribeStreamingClient({ region: CONFIG.region, credentials });

  const audioStream = (async function* () {
    for await (const chunk of pcmChunks) {
      yield { AudioEvent: { AudioChunk: chunk } };
    }
  })();

  const res = await client.send(
    new StartStreamTranscriptionCommand({
      LanguageCode: CONFIG.transcribeLanguage,
      MediaEncoding: "pcm",
      MediaSampleRateHertz: CONFIG.sampleRate,
      ShowSpeakerLabel: source === "tab",
      // Stabilize partials so live names/text stop flickering as Transcribe revises them.
      EnablePartialResultsStabilization: true,
      PartialResultsStability: "high",
      AudioStream: audioStream,
    }),
  );

  for await (const event of res.TranscriptResultStream ?? []) {
    for (const result of event.TranscriptEvent?.Transcript?.Results ?? []) {
      const alt = result.Alternatives?.[0];
      if (!alt?.Transcript) continue;
      const speakerLabel = alt.Items?.[0]?.Speaker ?? (source === "mic" ? "me" : "spk_0");
      onResult?.({ source, speakerLabel, text: alt.Transcript, isPartial: !!result.IsPartial });
      if (result.IsPartial) continue;
      const seg: DiarizedSegment = {
        source,
        speakerLabel,
        startTime: result.StartTime ?? 0,
        endTime: result.EndTime ?? 0,
        text: alt.Transcript,
      };
      const confidences = (alt.Items ?? [])
        .map((i) => i.Confidence)
        .filter((c): c is number => c !== undefined);
      if (confidences.length) {
        seg.confidence = confidences.reduce((a, c) => a + c, 0) / confidences.length;
      }
      yield seg;
    }
  }
}
