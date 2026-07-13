import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import type { Meeting } from "@teams-agent-core/shared";
import { isAdmin, tenantOf, json } from "../lib/http.js";
import { INDEX_VERSION } from "../lib/brain/ids.js";
import { indexMeeting } from "../lib/brain/indexer.js";
import { listMeetingsPage, updateMeeting } from "../lib/store.js";

const PAGE_SIZE = 25;
const CONCURRENCY = 3;
const DEADLINE_MS = 20000;

const parseBody = <T>(event: { body?: string }): T | null => {
  try {
    return JSON.parse(event.body ?? "{}") as T;
  } catch {
    return null;
  }
};

// Mid-page resume point: a synthetic LastEvaluatedKey pointing at the last
// processed meeting, so the next call's ExclusiveStartKey skips everything
// already handled instead of replaying the whole page.
const cursorAfter = (tenantId: string, meetingId: string): string =>
  Buffer.from(
    JSON.stringify({ PK: `TENANT#${tenantId}`, SK: `MEETING#${meetingId}` }),
  ).toString("base64");

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event,
) => {
  if (!isAdmin(event)) return json(403, { error: "forbidden" });

  const { tenantId } = tenantOf(event);
  const body = parseBody<{ cursor?: string; force?: boolean }>(event);
  if (!body) return json(400, { error: "invalid json" });

  const start = Date.now();
  let processed = 0;
  let indexed = 0;
  let failed = 0;
  let skipped = 0;
  let pageCursor = body.cursor;

  while (true) {
    const page = await listMeetingsPage(tenantId, PAGE_SIZE, pageCursor);
    const meetings = page.meetings;

    let next = 0;
    let deadlineHit = false;
    const worker = async () => {
      while (true) {
        if (Date.now() - start > DEADLINE_MS) {
          deadlineHit = true;
          return;
        }
        const i = next++;
        if (i >= meetings.length) return;
        const meeting = meetings[i] as Meeting;
        if (
          meeting.status === "capturing" ||
          meeting.status === "processing"
        ) {
          skipped++;
          continue;
        }
        if (!body.force && meeting.indexVersion === INDEX_VERSION) {
          skipped++;
          continue;
        }
        processed++;
        try {
          await indexMeeting(tenantId, meeting.meetingId);
          indexed++;
        } catch (err) {
          console.error(`reindex failed for ${meeting.meetingId}`, err);
          await updateMeeting(tenantId, meeting.meetingId, {
            indexStatus: "failed",
          });
          failed++;
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));

    const consumed = Math.min(next, meetings.length);
    if (deadlineHit && consumed < meetings.length) {
      const last = meetings[consumed - 1];
      const cursor = last
        ? cursorAfter(tenantId, last.meetingId)
        : pageCursor;
      return json(200, {
        processed,
        indexed,
        failed,
        skipped,
        done: false,
        ...(cursor ? { cursor } : {}),
      });
    }

    pageCursor = page.cursor;
    if (!pageCursor) {
      return json(200, { processed, indexed, failed, skipped, done: true });
    }
    if (Date.now() - start > DEADLINE_MS) {
      return json(200, {
        processed,
        indexed,
        failed,
        skipped,
        done: false,
        cursor: pageCursor,
      });
    }
  }
};
