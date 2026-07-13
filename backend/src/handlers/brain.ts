import type {
  APIGatewayProxyEventV2WithJWTAuthorizer,
  APIGatewayProxyHandlerV2WithJWTAuthorizer,
} from "aws-lambda";
import type {
  BrainAskRequest,
  BrainAskResponse,
  BrainMessage,
  BrainThread,
} from "@teams-agent-core/shared";
import { tenantOf, json } from "../lib/http.js";
import { planBrainSearch, generateBrainAnswer } from "../lib/agent.js";
import { ulid, indexNameForTenant } from "../lib/brain/ids.js";
import { embedText } from "../lib/brain/embed.js";
import {
  brainQueryFilter,
  queryIndex,
  type QueryHit,
} from "../lib/brain/vectorstore.js";
import { resolveCitations } from "../lib/brain/citations.js";
import {
  getThread,
  putThread,
  listThreads,
  deleteThread,
} from "../lib/store.js";

const MAX_MESSAGE = 4000;
const MAX_THREAD_MESSAGES = 40;
const HISTORY_WINDOW = 8;

const parseBody = <T>(event: { body?: string }): T | null => {
  try {
    return JSON.parse(event.body ?? "{}") as T;
  } catch {
    return null;
  }
};

const renderHistory = (thread: BrainThread | undefined): string =>
  (thread?.messages ?? [])
    .slice(-HISTORY_WINDOW)
    .map(
      (m) => `${m.role === "user" ? "Usuario" : "Asistente"}: ${m.text}`,
    )
    .join("\n");

const refOf = (metadata: Record<string, unknown>): string => {
  if (metadata.type === "note") return `N:${String(metadata.noteId)}`;
  const meetingId = String(metadata.meetingId);
  // Summary/digest chunks have no turn anchor — cite the meeting without one
  // rather than fabricating T1, which would deep-link to an unrelated turn.
  return metadata.turnStart
    ? `M:${meetingId}:${String(metadata.turnStart)}`
    : `M:${meetingId}`;
};

const renderChunks = (hits: QueryHit[]): string =>
  hits
    .map((hit) => {
      const fecha = new Date(Number(hit.metadata.dateEpoch) * 1000)
        .toISOString()
        .slice(0, 10);
      return `--- Fragmento ${refOf(hit.metadata)} (${String(hit.metadata.type)}, ${fecha}) ---\n${String(hit.metadata.text ?? "")}`;
    })
    .join("\n\n");

async function ask(
  event: APIGatewayProxyEventV2WithJWTAuthorizer,
  tenantId: string,
  sub: string,
) {
  const body = parseBody<BrainAskRequest>(event);
  if (!body) return json(400, { error: "invalid json" });
  const message = body.message?.trim();
  if (!message) return json(400, { error: "message required" });
  if (message.length > MAX_MESSAGE) {
    return json(400, { error: "message too long (max 4000 chars)" });
  }

  const thread = body.threadId
    ? await getThread(tenantId, sub, body.threadId)
    : undefined;
  if (body.threadId && !thread) return json(404, { error: "not found" });
  if (thread && thread.messages.length > MAX_THREAD_MESSAGES) {
    return json(409, { error: "thread full" });
  }

  const historyBlock = renderHistory(thread);
  const todayIso = new Date().toISOString().slice(0, 10);
  const plan = await planBrainSearch({ historyBlock, message, todayIso });

  const embedding = await embedText(plan.searchQuery);
  // targetTypes intentionally not filtered in v1 (boosts-only rule, plan Task 11).
  const filter = brainQueryFilter(
    sub,
    plan.timeIsExplicit
      ? { dateFromEpoch: plan.fromEpoch, dateToEpoch: plan.toEpoch }
      : undefined,
  );
  const hits = await queryIndex(indexNameForTenant(tenantId), embedding, {
    topK: 15,
    filter,
  });

  const answer = await generateBrainAnswer({
    chunksBlock: renderChunks(hits),
    historyBlock,
    question: message,
    todayIso,
  });
  const { answerMd, citations } = resolveCitations(answer.answerMd, hits);

  const now = new Date().toISOString();
  const persisted: BrainThread = thread ?? {
    threadId: ulid(),
    title: message.slice(0, 60),
    messages: [],
    createdAt: now,
    updatedAt: now,
  };
  const userMessage: BrainMessage = { role: "user", text: message, at: now };
  const assistantMessage: BrainMessage = {
    role: "assistant",
    text: answerMd,
    citations,
    at: now,
  };
  persisted.messages.push(userMessage, assistantMessage);
  persisted.updatedAt = now;
  await putThread(tenantId, sub, persisted);

  const response: BrainAskResponse = {
    threadId: persisted.threadId,
    answer: answerMd,
    citations,
  };
  return json(200, response);
}

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event,
) => {
  const { tenantId } = tenantOf(event);
  const sub = String(event.requestContext.authorizer.jwt.claims.sub);
  const threadId = event.pathParameters?.id;

  switch (event.routeKey) {
    case "POST /brain/ask":
      return ask(event, tenantId, sub);

    case "GET /brain/threads":
      return json(200, { threads: await listThreads(tenantId, sub) });

    case "GET /brain/threads/{id}": {
      const thread = await getThread(tenantId, sub, threadId!);
      if (!thread) return json(404, { error: "not found" });
      return json(200, thread);
    }

    case "DELETE /brain/threads/{id}": {
      await deleteThread(tenantId, sub, threadId!);
      return json(200, { ok: true });
    }

    default:
      return json(404, { error: "not found" });
  }
};
