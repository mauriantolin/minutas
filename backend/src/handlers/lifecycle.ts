import type { APIGatewayProxyEventV2WithJWTAuthorizer } from "aws-lambda";
import type {
  MeetingFinalizeRequest,
  MeetingReprocessRequest,
  MeetingStartRequest,
  PipelineState,
  SegmentsAppendRequest,
} from "@teams-agent-core/shared";
import {
  appendSegmentBatch,
  getMeetingItem,
  updateMeeting,
} from "../lib/store.js";
import { finalizeMeeting, startMeeting } from "../lib/lifecycle.js";
import {
  executionName,
  isExecutionRunning,
  startPipeline,
} from "../lib/sfn.js";
import { tenantOf, json } from "../lib/http.js";

// Handlers take only the event (and always return a response) so the router in
// ingest.ts can delegate without inheriting the void-returning callback form.
type LifecycleEvent = APIGatewayProxyEventV2WithJWTAuthorizer;

/** POST /meetings — register the meeting at capture start (idempotent by captureId). */
export const start = async (event: LifecycleEvent) => {
  const { tenantId } = tenantOf(event);
  const req = JSON.parse(event.body ?? "{}") as MeetingStartRequest;
  if (!req.captureId || !req.startedAt) {
    return json(400, { error: "captureId and startedAt required" });
  }
  const meetingId = await startMeeting(tenantId, req);
  return json(200, { meetingId });
};

/** POST /meetings/{id}/segments — batched checkpoint append (idempotent by seq). */
export const appendSegments = async (event: LifecycleEvent) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  const req = JSON.parse(event.body ?? "{}") as SegmentsAppendRequest;
  if (!id || typeof req.seq !== "number" || !Array.isArray(req.segments)) {
    return json(400, { error: "id, seq and segments required" });
  }
  const meeting = await getMeetingItem(tenantId, id);
  if (!meeting) return json(404, { error: "not found" });
  const segmentCount = await appendSegmentBatch(
    tenantId,
    id,
    req.seq,
    req.segments,
  );
  return json(200, { segmentCount });
};

/** POST /meetings/{id}/finalize — persist raw payload, start the pipeline, 202. */
export const finalize = async (event: LifecycleEvent) => {
  const { tenantId, userName } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: "id required" });
  const payload = JSON.parse(event.body ?? "{}") as MeetingFinalizeRequest;
  if (!Array.isArray(payload.segments) || !payload.startedAt) {
    return json(400, { error: "segments and startedAt required" });
  }
  const response = await finalizeMeeting(tenantId, id, payload, userName);
  return json(202, response);
};

/** POST /meetings/{id}/reprocess — restart the pipeline on a fresh execution. */
export const reprocess = async (event: LifecycleEvent) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: "id required" });
  const req = JSON.parse(event.body || "{}") as MeetingReprocessRequest;
  const meeting = await getMeetingItem(tenantId, id);
  if (!meeting) return json(404, { error: "not found" });
  if (
    meeting.pipeline?.executionArn &&
    (await isExecutionRunning(meeting.pipeline.executionArn))
  ) {
    return json(409, { error: "execution already running" });
  }

  // Suffixed execution name escapes the 90-day name dedupe — each reprocess is
  // intentionally a new run. Start first, mutate after: on a failed/duplicated
  // start the stored status stays actionable (needs_review/failed), and the
  // name dedupe makes the loser of a double-submit 409 without writing.
  const attempts = (meeting.pipeline?.attempts ?? 0) + 1;
  const executionArn = await startPipeline(executionName(id, attempts), {
    tenantId,
    meetingId: id,
    fromPhase: req.fromPhase,
  });
  if (!executionArn) return json(409, { error: "execution already running" });

  const pipeline: PipelineState = {
    phase: req.fromPhase ?? "INGESTED",
    tier: "haiku",
    attempts,
    scores: {},
    asrSource: meeting.pipeline?.asrSource ?? "streaming",
    signalHealth: meeting.pipeline?.signalHealth,
    executionArn,
  };
  await updateMeeting(tenantId, id, { pipeline, status: "processing" });
  return json(202, { meetingId: id, executionArn });
};
