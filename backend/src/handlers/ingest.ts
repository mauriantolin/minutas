import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { correlateSpeakers, type MeetingIngestPayload } from "@teams-agent-core/shared";
import { putMeeting, putTranscript, setMeetingStatus } from "../lib/store.js";
import { summarizeMeeting } from "../lib/agent.js";
import { tenantOf, json } from "../lib/http.js";

/**
 * Receives the transcript + active-speaker timeline the extension collected during a
 * meeting, resolves real speaker names, persists the labeled transcript, and runs the
 * agent to produce a summary. Tenant isolation comes from the Cognito JWT, never the body.
 */
export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId, userName } = tenantOf(event);
  const payload = JSON.parse(event.body ?? "{}") as MeetingIngestPayload;
  const meetingId = `${payload.startedAt}-${crypto.randomUUID().slice(0, 8)}`;

  const segments = correlateSpeakers(
    payload.segments,
    payload.speakerTimeline,
    payload.localUserName || userName,
  );
  const participants = [
    ...new Set(segments.filter((s) => s.resolved).map((s) => s.speaker)),
  ].map((name) => ({ name }));

  await putMeeting({
    tenantId,
    meetingId,
    title: payload.title,
    startedAt: payload.startedAt,
    endedAt: payload.endedAt,
    participants,
    status: "processing",
  });
  await putTranscript(tenantId, meetingId, segments);

  try {
    const summary = await summarizeMeeting(segments);
    await setMeetingStatus(tenantId, meetingId, "ready", summary);
  } catch (err) {
    await setMeetingStatus(tenantId, meetingId, "failed");
    return json(202, { meetingId, warning: `summary failed: ${String(err)}` });
  }

  return json(202, { meetingId, segmentCount: segments.length });
};
