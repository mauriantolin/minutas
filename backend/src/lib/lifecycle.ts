import type {
  AudioPendingDeclaration,
  AudioSource,
  MeetingFinalizeRequest,
  MeetingFinalizeResponse,
  MeetingStartRequest,
  PipelineState,
} from "@teams-agent-core/shared";
import {
  createMeetingIfAbsent,
  getMeetingItem,
  presignAudioUpload,
  putRawPayload,
  updateMeeting,
} from "./store.js";
import { executionName, startPipeline } from "./sfn.js";

export function mintMeetingId(startedAt: string): string {
  return `${startedAt}-${crypto.randomUUID().slice(0, 8)}`;
}

/** Registers the meeting at capture start; idempotent by `captureId`. */
export async function startMeeting(
  tenantId: string,
  req: MeetingStartRequest,
): Promise<string> {
  return createMeetingIfAbsent({
    tenantId,
    meetingId: mintMeetingId(req.startedAt),
    captureId: req.captureId,
    title: req.title ?? "Untitled meeting",
    startedAt: req.startedAt,
    participants: [],
    status: "capturing",
  });
}

/**
 * Idempotent by meetingId: raw-payload S3 puts overwrite, and the SFN execution
 * name (= meetingId) is deduped by AWS for 90 days — a blind finalize retry
 * after a 5xx can never double-run a pipeline. The meeting item is only mutated
 * when the execution actually starts, so a late replay (e.g. the extension's
 * recovery sweep hours after the pipeline published) can't drag a ready meeting
 * back to "processing".
 * Returns the canonical meetingId (the upsert path may resolve a different one)
 * plus, under consent Tier 2, presigned PUT URLs for the declared audio sources.
 */
export async function finalizeMeeting(
  tenantId: string,
  meetingId: string,
  payload: MeetingFinalizeRequest,
  userName: string,
): Promise<MeetingFinalizeResponse> {
  const existing = await getMeetingItem(tenantId, meetingId);
  // Offline start: the start call never landed, so finalize upserts the meeting
  // itself, still deduped by captureId.
  const id = existing
    ? meetingId
    : await createMeetingIfAbsent({
        tenantId,
        meetingId,
        captureId: payload.captureId ?? meetingId,
        title: payload.title,
        startedAt: payload.startedAt,
        participants: [],
        status: "capturing",
      });

  await putRawPayload(tenantId, id, {
    ...payload,
    localUserName: payload.localUserName || userName,
  });

  // The declaration is only actionable under explicit upload consent (§7 Tier
  // 2) — without it no poll target may exist and no URL may be signed.
  const audioPending =
    payload.audioConsent?.tier === 2
      ? sanitizeAudioDeclaration(payload.audioPending)
      : undefined;
  // Signed before the dedupe check: a retried finalize (first POST landed but
  // the 202 was lost) still needs upload URLs, and signing is a pure local op.
  const audioUploadUrls = audioPending
    ? await signAudioUploads(tenantId, id, audioPending)
    : undefined;
  const response: MeetingFinalizeResponse = {
    meetingId: id,
    ...(audioUploadUrls ? { audioUploadUrls } : {}),
  };

  const arn = await startPipeline(executionName(id), {
    tenantId,
    meetingId: id,
  });
  if (!arn) return response;

  const pipeline: PipelineState = {
    phase: "INGESTED",
    tier: "haiku",
    attempts: existing?.pipeline?.attempts ?? 0,
    scores: {},
    asrSource: "streaming",
    signalHealth: payload.signalHealth,
    executionArn: arn,
  };
  await updateMeeting(tenantId, id, {
    title: payload.title,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    captureId: payload.captureId,
    audioConsent: payload.audioConsent,
    audioPending,
    status: "processing",
    pipeline,
  });
  return response;
}

const AUDIO_SOURCES: readonly AudioSource[] = ["tab", "mic"];
const MAX_AUDIO_DURATION_SEC = 24 * 60 * 60;

// Client JSON is a trust boundary: declaration.sources becomes S3 key material
// for presigned PUT URLs and downstream code treats it as an enum.
function sanitizeAudioDeclaration(
  declaration: AudioPendingDeclaration | undefined,
): AudioPendingDeclaration | undefined {
  if (!declaration || !Array.isArray(declaration.sources)) return undefined;
  const sources = AUDIO_SOURCES.filter((s) => declaration.sources.includes(s));
  if (!sources.length) return undefined;
  const durationSec = Number(declaration.durationSec);
  return {
    sources,
    format: "webm-opus",
    durationSec: Number.isFinite(durationSec)
      ? Math.min(Math.max(0, Math.round(durationSec)), MAX_AUDIO_DURATION_SEC)
      : 0,
  };
}

async function signAudioUploads(
  tenantId: string,
  meetingId: string,
  declaration: AudioPendingDeclaration,
): Promise<Partial<Record<AudioSource, string>>> {
  const urls: Partial<Record<AudioSource, string>> = {};
  for (const source of declaration.sources) {
    urls[source] = await presignAudioUpload(tenantId, meetingId, source);
  }
  return urls;
}
