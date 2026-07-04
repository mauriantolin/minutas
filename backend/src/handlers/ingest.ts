import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import type {
  MeetingFinalizeRequest,
  MeetingStartRequest,
} from "@teams-agent-core/shared";
import { finalizeMeeting, mintMeetingId, startMeeting } from "../lib/lifecycle.js";
import { tenantOf, json } from "../lib/http.js";
import { appendSegments, finalize, reprocess } from "./lifecycle.js";

/**
 * Entry point for all lifecycle POST routes (infra wires them to one Lambda);
 * dispatches on the route key. `POST /meetings` itself serves two body shapes
 * for extension back-compat:
 *  - New protocol: `MeetingStartRequest` (no segments) → register the meeting
 *    (`status: "capturing"`), idempotent by captureId.
 *  - Legacy single-shot ingest (`MeetingIngestPayload`, has segments) →
 *    create + finalize in one call; summarization now happens asynchronously
 *    in the pipeline, never inline.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event,
) => {
  switch (event.routeKey) {
    case "POST /meetings/{id}/segments":
      return appendSegments(event);
    case "POST /meetings/{id}/finalize":
      return finalize(event);
    case "POST /meetings/{id}/reprocess":
      return reprocess(event);
  }

  const { tenantId, userName } = tenantOf(event);
  const body = JSON.parse(event.body ?? "{}") as Partial<MeetingFinalizeRequest>;

  if (!Array.isArray(body.segments)) {
    const req = body as MeetingStartRequest;
    if (!req.captureId || !req.startedAt) {
      return json(400, { error: "captureId and startedAt required" });
    }
    const meetingId = await startMeeting(tenantId, req);
    return json(200, { meetingId });
  }

  const payload = body as MeetingFinalizeRequest;
  const { meetingId } = await finalizeMeeting(
    tenantId,
    mintMeetingId(payload.startedAt),
    // Legacy builds mint no captureId; a fresh one keeps the upsert path keyed.
    { ...payload, captureId: payload.captureId ?? crypto.randomUUID() },
    userName,
  );
  return json(202, { meetingId, segmentCount: payload.segments.length });
};
