import type { APIGatewayProxyHandlerV2WithJWTAuthorizer } from "aws-lambda";
import type {
  Note,
  NoteCreateRequest,
  NoteUpdateRequest,
} from "@teams-agent-core/shared";
import { tenantOf, json } from "../lib/http.js";
import { cleanNoteText } from "../lib/agent.js";
import { ulid } from "../lib/brain/ids.js";
import { indexNote, removeNoteVectors } from "../lib/brain/indexer.js";
import { putNote, getNote, listNotes, deleteNote } from "../lib/store.js";

const MAX_RAW_TEXT = 20000;

const parseBody = <T>(event: { body?: string }): T | null => {
  try {
    return JSON.parse(event.body ?? "{}") as T;
  } catch {
    return null;
  }
};

const tryIndex = async (note: Note): Promise<void> => {
  try {
    await indexNote(note);
  } catch (err) {
    console.error(`indexNote failed for ${note.noteId}`, err);
  }
};

export const handler: APIGatewayProxyHandlerV2WithJWTAuthorizer = async (
  event,
) => {
  const { tenantId } = tenantOf(event);
  const sub = String(event.requestContext.authorizer.jwt.claims.sub);
  const noteId = event.pathParameters?.id;

  switch (event.routeKey) {
    case "POST /notes": {
      const body = parseBody<NoteCreateRequest>(event);
      if (!body) return json(400, { error: "invalid json" });
      if (!body.rawText?.trim() || body.rawText.length > MAX_RAW_TEXT) {
        return json(400, { error: "rawText required (max 20000 chars)" });
      }
      if (body.source !== "typed" && body.source !== "voice") {
        return json(400, { error: "source must be typed or voice" });
      }
      const { title, cleanText } = await cleanNoteText(body.rawText);
      const now = new Date().toISOString();
      const note: Note = {
        tenantId,
        noteId: ulid(),
        ownerSub: sub,
        title,
        rawText: body.rawText,
        cleanText,
        source: body.source,
        createdAt: now,
        updatedAt: now,
      };
      await putNote(note);
      await tryIndex(note);
      return json(201, note);
    }

    case "GET /notes":
      return json(200, { notes: await listNotes(tenantId, sub) });

    case "GET /notes/{id}": {
      const note = await getNote(tenantId, sub, noteId!);
      if (!note) return json(404, { error: "not found" });
      return json(200, note);
    }

    case "PUT /notes/{id}": {
      const body = parseBody<NoteUpdateRequest>(event);
      if (!body) return json(400, { error: "invalid json" });
      const note = await getNote(tenantId, sub, noteId!);
      if (!note) return json(404, { error: "not found" });
      if (body.rawText !== undefined) {
        if (!body.rawText.trim() || body.rawText.length > MAX_RAW_TEXT) {
          return json(400, { error: "rawText required (max 20000 chars)" });
        }
        note.rawText = body.rawText;
      }
      if (body.title !== undefined) note.title = body.title;
      if (body.cleanText !== undefined) note.cleanText = body.cleanText;
      if (body.reclean) {
        const { title, cleanText } = await cleanNoteText(note.rawText);
        note.title = title;
        note.cleanText = cleanText;
      }
      note.updatedAt = new Date().toISOString();
      await putNote(note);
      await tryIndex(note);
      return json(200, note);
    }

    case "DELETE /notes/{id}": {
      await removeNoteVectors(tenantId, sub, noteId!);
      await deleteNote(tenantId, sub, noteId!);
      return json(200, { ok: true });
    }

    default:
      return json(404, { error: "not found" });
  }
};
