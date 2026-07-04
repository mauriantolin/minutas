import type {
  MeetingFinalizeRequest,
  MeetingStartRequest,
  PipelineState,
} from "@teams-agent-core/shared";
import {
  createMeetingIfAbsent,
  getMeetingItem,
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
 * Returns the canonical meetingId (the upsert path may resolve a different one).
 */
export async function finalizeMeeting(
  tenantId: string,
  meetingId: string,
  payload: MeetingFinalizeRequest,
  userName: string,
): Promise<string> {
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

  const arn = await startPipeline(executionName(id), {
    tenantId,
    meetingId: id,
  });
  if (!arn) return id;

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
    status: "processing",
    pipeline,
  });
  return id;
}
