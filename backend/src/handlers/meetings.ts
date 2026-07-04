import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import { getMeeting, listMeetings, deleteMeeting } from "../lib/store.js";
import { askMeeting } from "../lib/agent.js";
import { tenantOf, json } from "../lib/http.js";

/** GET /meetings — list; GET /meetings/{id} — detail with transcript + summary. */
export const get: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(200, { meetings: await listMeetings(tenantId) });

  const meeting = await getMeeting(tenantId, id);
  return meeting ? json(200, meeting) : json(404, { error: "not found" });
};

/** DELETE /meetings/{id} — remove a meeting and its transcript. */
export const del: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: "id required" });
  await deleteMeeting(tenantId, id);
  return json(200, { deleted: id });
};

/** POST /meetings/{id}/ask — Q&A over the meeting transcript. */
export const ask: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  const { question } = JSON.parse(event.body ?? "{}") as { question?: string };
  if (!id || !question) return json(400, { error: "id and question required" });

  const meeting = await getMeeting(tenantId, id);
  if (!meeting) return json(404, { error: "not found" });

  const answer = await askMeeting(meeting.segments, question);
  return json(200, { answer });
};
