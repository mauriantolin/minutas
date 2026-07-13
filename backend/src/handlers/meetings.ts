import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import {
  deleteMeeting,
  getCleanTranscript,
  getExtraction,
  getMeeting,
  getMeetingItem,
  getSummaryArtifact,
  getVerification,
  listMeetings,
} from "../lib/store.js";
import {
  answerFromSummary,
  answerFromTranscript,
  askMeeting,
  cleanTranscriptContext,
} from "../lib/agent.js";
import { removeMeetingVectors } from "../lib/brain/indexer.js";
import { tenantOf, json } from "../lib/http.js";

/** Pipeline artifacts are absent until their phase ran — that's a valid state. */
const ifExists = <T>(p: Promise<T>): Promise<T | undefined> =>
  p.catch((err) => {
    if ((err as Error).name !== "NoSuchKey") throw err;
    return undefined;
  });

/**
 * GET /meetings — list; GET /meetings/{id} — detail with raw transcript,
 * summary, and (when the pipeline ran) clean transcript + published summary
 * artifact + verification report, so the web can render [Tn] sources.
 */
export const get: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(200, { meetings: await listMeetings(tenantId) });

  const [meeting, cleanTranscript, extraction, summaryArtifact, verification] =
    await Promise.all([
      getMeeting(tenantId, id),
      ifExists(getCleanTranscript(tenantId, id)),
      ifExists(getExtraction(tenantId, id)),
      ifExists(getSummaryArtifact(tenantId, id)),
      ifExists(getVerification(tenantId, id)),
    ]);
  if (!meeting) return json(404, { error: "not found" });
  return json(200, {
    ...meeting,
    ...(cleanTranscript ? { cleanTranscript } : {}),
    ...(extraction ? { extraction } : {}),
    ...(summaryArtifact ? { summaryArtifact } : {}),
    ...(verification ? { verification } : {}),
  });
};

/** DELETE /meetings/{id} — remove a meeting and its transcript. */
export const del: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  if (!id) return json(400, { error: "id required" });
  await removeMeetingVectors(tenantId, id);
  await deleteMeeting(tenantId, id);
  return json(200, { deleted: id });
};

/**
 * POST /meetings/{id}/ask — Q&A over the meeting.
 * Summary-first routing: cheap Haiku call over summary + extraction (~2k
 * tokens); only questions that need the full transcript hit the cached-prefix
 * path (identical prefix to P5–P8, 1h cache TTL so follow-ups stay warm).
 * Answers cite [Tn] anchors; the web renders them as links.
 */
export const ask: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (event) => {
  const { tenantId } = tenantOf(event);
  const id = event.pathParameters?.id;
  const { question } = JSON.parse(event.body ?? "{}") as { question?: string };
  if (!id || !question) return json(400, { error: "id and question required" });

  const meeting = await getMeetingItem(tenantId, id);
  if (!meeting) return json(404, { error: "not found" });

  const [clean, summary, extraction] = await Promise.all([
    ifExists(getCleanTranscript(tenantId, id)),
    ifExists(getSummaryArtifact(tenantId, id)),
    ifExists(getExtraction(tenantId, id)),
  ]);

  // Pre-pipeline meetings (legacy single-shot ingest) only have raw segments.
  if (!clean || !summary) {
    const record = await getMeeting(tenantId, id);
    if (!record?.segments.length) {
      return json(409, { error: "meeting not processed yet" });
    }
    const answer = await askMeeting(record.segments, question);
    return json(200, { answer, source: "transcript" });
  }

  const routed = await answerFromSummary({
    summaryMarkdown: summary.text,
    extraction,
    question,
  });
  if (routed.sufficient) {
    return json(200, { answer: routed.answer, source: "summary" });
  }

  const answer = await answerFromTranscript(
    cleanTranscriptContext(clean),
    question,
  );
  return json(200, { answer, source: "transcript" });
};
