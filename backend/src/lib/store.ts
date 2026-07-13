import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type {
  AudioSource,
  BatchJobTokenRecord,
  BatchMergeResult,
  BrainThread,
  CleanTranscript,
  CorrelatedSegment,
  DiarizedSegment,
  ExtractionResult,
  LabeledSegment,
  Meeting,
  MeetingIngestPayload,
  MeetingRecord,
  Note,
  SummaryArtifact,
  VerificationReport,
} from "@teams-agent-core/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.TRANSCRIPT_BUCKET!;

const pk = (tenantId: string) => `TENANT#${tenantId}`;
const sk = (meetingId: string) => `MEETING#${meetingId}`;
const captureSk = (captureId: string) => `CAPTURE#${captureId}`;
// Own prefix (not MEETING#…) so listMeetings' begins_with never sees chunk items.
const segSk = (meetingId: string, seq: number) =>
  `SEGS#${meetingId}#${String(seq).padStart(8, "0")}`;
// jobName-keyed (not tenant-keyed): the Transcribe job-state event carries only
// the job name, so the callback Lambda has no tenant context to build a PK from.
const batchJobPk = (jobName: string) => `BATCHJOB#${jobName}`;
// ownerSub baked into the SK: notes/threads are private to their owner, so a
// begins_with on `NOTE#{sub}#` can never leak another user's items.
const noteSk = (ownerSub: string, noteId: string) =>
  `NOTE#${ownerSub}#${noteId}`;
const threadSk = (ownerSub: string, threadId: string) =>
  `THREAD#${ownerSub}#${threadId}`;
const idxSk = (doc: string) => `IDX#${doc}`;

export async function putMeeting(meeting: Meeting): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: pk(meeting.tenantId), SK: sk(meeting.meetingId), ...meeting },
    }),
  );
}

/**
 * Idempotent create keyed by the client-minted captureId (a lock item holds the
 * minted meetingId); a replayed start call returns the meetingId minted first.
 */
export async function createMeetingIfAbsent(
  meeting: Meeting & { captureId: string },
): Promise<string> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: {
          PK: pk(meeting.tenantId),
          SK: captureSk(meeting.captureId),
          meetingId: meeting.meetingId,
        },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
    const { Item } = await ddb.send(
      new GetCommand({
        TableName: TABLE,
        Key: { PK: pk(meeting.tenantId), SK: captureSk(meeting.captureId) },
      }),
    );
    return (Item as { meetingId: string }).meetingId;
  }
  await putMeeting(meeting);
  return meeting.meetingId;
}

/**
 * Generalized partial update of the meeting item. Values set `undefined` are
 * REMOVEd, everything else is SET — pipeline state, status transitions and
 * arbitrary phase payloads all go through here.
 */
export async function updateMeeting(
  tenantId: string,
  meetingId: string,
  attrs: Record<string, unknown>,
): Promise<void> {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const sets: string[] = [];
  const removes: string[] = [];
  Object.entries(attrs).forEach(([key, value], i) => {
    names[`#a${i}`] = key;
    if (value === undefined) {
      removes.push(`#a${i}`);
    } else {
      values[`:v${i}`] = value;
      sets.push(`#a${i} = :v${i}`);
    }
  });
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: sk(meetingId) },
      UpdateExpression: [
        sets.length ? `SET ${sets.join(", ")}` : "",
        removes.length ? `REMOVE ${removes.join(", ")}` : "",
      ]
        .filter(Boolean)
        .join(" "),
      ExpressionAttributeNames: names,
      ...(sets.length ? { ExpressionAttributeValues: values } : {}),
    }),
  );
}

export async function getMeetingItem(
  tenantId: string,
  meetingId: string,
): Promise<Meeting | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: sk(meetingId) },
    }),
  );
  return Item as Meeting | undefined;
}

export async function getMeeting(
  tenantId: string,
  meetingId: string,
): Promise<MeetingRecord | undefined> {
  const item = await getMeetingItem(tenantId, meetingId);
  if (!item) return undefined;
  // Before the pipeline's correlate phase runs there is no transcript.json yet;
  // the live view is served from the incrementally checkpointed segment chunks.
  const segments = await getTranscript(tenantId, meetingId).catch(
    async (err) => {
      if ((err as Error).name !== "NoSuchKey") throw err;
      const live = await getLiveSegments(tenantId, meetingId);
      return live.map<LabeledSegment>((s) => ({
        speaker: s.speakerLabel,
        resolved: false,
        startTime: s.startTime,
        endTime: s.endTime,
        text: s.text,
      }));
    },
  );
  return { ...item, segments };
}

export async function listMeetings(tenantId: string): Promise<Meeting[]> {
  const { Items } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": pk(tenantId), ":sk": "MEETING#" },
      ScanIndexForward: false,
    }),
  );
  return (Items ?? []) as Meeting[];
}

export async function listMeetingsPage(
  tenantId: string,
  limit: number,
  cursor?: string,
): Promise<{ meetings: Meeting[]; cursor?: string }> {
  const { Items, LastEvaluatedKey } = await ddb.send(
    new QueryCommand({
      TableName: TABLE,
      KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
      ExpressionAttributeValues: { ":pk": pk(tenantId), ":sk": "MEETING#" },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor
        ? {
            ExclusiveStartKey: JSON.parse(
              Buffer.from(cursor, "base64").toString("utf8"),
            ) as Record<string, unknown>,
          }
        : {}),
    }),
  );
  return {
    meetings: (Items ?? []) as Meeting[],
    ...(LastEvaluatedKey
      ? {
          cursor: Buffer.from(JSON.stringify(LastEvaluatedKey)).toString(
            "base64",
          ),
        }
      : {}),
  };
}

/**
 * Idempotent batched append keyed by the client-minted `seq`: a replayed batch
 * fails the conditional put and just reports the already-stored total.
 */
export async function appendSegmentBatch(
  tenantId: string,
  meetingId: string,
  seq: number,
  segments: DiarizedSegment[],
): Promise<number> {
  try {
    await ddb.send(
      new PutCommand({
        TableName: TABLE,
        Item: { PK: pk(tenantId), SK: segSk(meetingId, seq), segments },
        ConditionExpression: "attribute_not_exists(PK)",
      }),
    );
  } catch (err) {
    if ((err as Error).name !== "ConditionalCheckFailedException") throw err;
    const item = await getMeetingItem(tenantId, meetingId);
    return ((item as { segmentCount?: number }).segmentCount ?? 0);
  }
  const { Attributes } = await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: sk(meetingId) },
      UpdateExpression: "ADD segmentCount :n",
      ExpressionAttributeValues: { ":n": segments.length },
      ReturnValues: "UPDATED_NEW",
    }),
  );
  return (Attributes as { segmentCount: number }).segmentCount;
}

export async function getLiveSegments(
  tenantId: string,
  meetingId: string,
): Promise<DiarizedSegment[]> {
  const segments: DiarizedSegment[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk(tenantId),
          ":sk": `SEGS#${meetingId}#`,
        },
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of page.Items ?? []) {
      segments.push(...(item.segments as DiarizedSegment[]));
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return segments;
}

export async function deleteMeeting(
  tenantId: string,
  meetingId: string,
): Promise<void> {
  const item = await getMeetingItem(tenantId, meetingId);
  const keys: { PK: string; SK: string }[] = [
    { PK: pk(tenantId), SK: sk(meetingId) },
  ];
  if (item?.captureId) {
    keys.push({ PK: pk(tenantId), SK: captureSk(item.captureId) });
  }
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk(tenantId),
          ":sk": `SEGS#${meetingId}#`,
        },
        ProjectionExpression: "PK, SK",
        ExclusiveStartKey: cursor,
      }),
    );
    keys.push(...((page.Items ?? []) as { PK: string; SK: string }[]));
    cursor = page.LastEvaluatedKey;
  } while (cursor);

  for (let i = 0; i < keys.length; i += 25) {
    await ddb.send(
      new BatchWriteCommand({
        RequestItems: {
          [TABLE]: keys
            .slice(i, i + 25)
            .map((Key) => ({ DeleteRequest: { Key } })),
        },
      }),
    );
  }
  await deletePrefix(`${tenantId}/${meetingId}/`);
}

async function deletePrefix(prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const page = await s3.send(
      new ListObjectsV2Command({
        Bucket: BUCKET,
        Prefix: prefix,
        ContinuationToken: token,
      }),
    );
    const objects = (page.Contents ?? []).map((o) => ({ Key: o.Key! }));
    if (objects.length) {
      await s3.send(
        new DeleteObjectsCommand({
          Bucket: BUCKET,
          Delete: { Objects: objects },
        }),
      );
    }
    token = page.NextContinuationToken;
  } while (token);
}

export async function putRawPayload(
  tenantId: string,
  meetingId: string,
  payload: MeetingIngestPayload,
): Promise<void> {
  await putJson(`${tenantId}/${meetingId}/raw-payload.json`, payload);
}

export async function getRawPayload(
  tenantId: string,
  meetingId: string,
): Promise<MeetingIngestPayload> {
  return getJson<MeetingIngestPayload>(
    `${tenantId}/${meetingId}/raw-payload.json`,
  );
}

export async function putTranscript(
  tenantId: string,
  meetingId: string,
  segments: LabeledSegment[],
): Promise<void> {
  await putJson(`${tenantId}/${meetingId}/transcript.json`, segments);
}

export async function getTranscript(
  tenantId: string,
  meetingId: string,
): Promise<LabeledSegment[]> {
  return getJson<LabeledSegment[]>(`${tenantId}/${meetingId}/transcript.json`);
}

// --- P2–P8 pipeline artifacts (doc §4) under `{tenantId}/{meetingId}/` ---

const artifactKey = (t: string, m: string, name: string) => `${t}/${m}/${name}`;

export async function putLabeledTranscript(
  tenantId: string,
  meetingId: string,
  segments: CorrelatedSegment[],
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "transcript.labeled.json"), segments);
}

export async function getLabeledTranscript(
  tenantId: string,
  meetingId: string,
): Promise<CorrelatedSegment[]> {
  return getJson(artifactKey(tenantId, meetingId, "transcript.labeled.json"));
}

export async function putCleanTranscript(
  tenantId: string,
  meetingId: string,
  transcript: CleanTranscript,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "transcript.clean.json"), transcript);
}

export async function getCleanTranscript(
  tenantId: string,
  meetingId: string,
): Promise<CleanTranscript> {
  return getJson(artifactKey(tenantId, meetingId, "transcript.clean.json"));
}

export async function putExtraction(
  tenantId: string,
  meetingId: string,
  extraction: ExtractionResult,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "extraction.json"), extraction);
}

export async function getExtraction(
  tenantId: string,
  meetingId: string,
): Promise<ExtractionResult> {
  return getJson(artifactKey(tenantId, meetingId, "extraction.json"));
}

/** P6/P7 working draft; P8 promotes it to `summary.json`. */
export async function putSummaryDraft(
  tenantId: string,
  meetingId: string,
  summary: SummaryArtifact,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "summary-draft.json"), summary);
}

export async function getSummaryDraft(
  tenantId: string,
  meetingId: string,
): Promise<SummaryArtifact> {
  return getJson(artifactKey(tenantId, meetingId, "summary-draft.json"));
}

export async function putSummaryArtifact(
  tenantId: string,
  meetingId: string,
  summary: SummaryArtifact,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "summary.json"), summary);
}

export async function getSummaryArtifact(
  tenantId: string,
  meetingId: string,
): Promise<SummaryArtifact> {
  return getJson(artifactKey(tenantId, meetingId, "summary.json"));
}

export async function putVerification(
  tenantId: string,
  meetingId: string,
  report: VerificationReport,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "verification.json"), report);
}

export async function getVerification(
  tenantId: string,
  meetingId: string,
): Promise<VerificationReport> {
  return getJson(artifactKey(tenantId, meetingId, "verification.json"));
}

// --- Opt-in audio + batch re-ASR (M5, doc §2-P3/§7) ---

export const audioKey = (t: string, m: string, source: AudioSource) =>
  `${t}/${m}/audio/${source}.webm`;

/**
 * Backend-signed PUT URL: the identity-pool role cannot be IAM-scoped to the
 * `{tenantId}/{meetingId}/audio/*` prefix, so the extension never gets a direct
 * s3:PutObject grant.
 *
 * Both headers below must stay in SignedHeaders (not hoisted into the query
 * string): S3 only applies object tags from the x-amz-tagging REQUEST header —
 * a hoisted query param is silently ignored and the 7-day ExpireAudio lifecycle
 * rule (which filters on audio=true) would never match. The presigner also
 * unsigns content-type by default, so it is forced signable to pin the declared
 * container. The extension's PUT must therefore send exactly
 * `x-amz-tagging: audio=true` and `content-type: audio/webm`.
 */
export async function presignAudioUpload(
  tenantId: string,
  meetingId: string,
  source: AudioSource,
): Promise<string> {
  return getSignedUrl(
    s3,
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: audioKey(tenantId, meetingId, source),
      ContentType: "audio/webm",
      Tagging: "audio=true",
    }),
    {
      expiresIn: 900,
      unhoistableHeaders: new Set(["x-amz-tagging"]),
      signableHeaders: new Set(["content-type", "x-amz-tagging"]),
    },
  );
}

/** Gate B's poll target check — HeadObject on a declared-at-finalize source. */
export async function audioObjectExists(
  tenantId: string,
  meetingId: string,
  source: AudioSource,
): Promise<boolean> {
  try {
    await s3.send(
      new HeadObjectCommand({
        Bucket: BUCKET,
        Key: audioKey(tenantId, meetingId, source),
      }),
    );
    return true;
  } catch (err) {
    if ((err as { name?: string }).name === "NotFound") return false;
    throw err;
  }
}

/**
 * §7 Tier 2 commitment: uploaded audio is deleted as soon as a verified
 * transcript exists (the S3 lifecycle rule is only the 7-day hard cap).
 */
export async function deleteAudioObjects(
  tenantId: string,
  meetingId: string,
): Promise<void> {
  await deletePrefix(`${tenantId}/${meetingId}/audio/`);
}

/** Transcribe Batch output lands here (OutputKey on StartTranscriptionJob). */
export const batchTranscriptKey = (t: string, m: string) =>
  `${t}/${m}/batch-transcript.json`;

export async function getBatchTranscriptJson(
  tenantId: string,
  meetingId: string,
): Promise<unknown> {
  return getJson(batchTranscriptKey(tenantId, meetingId));
}

export async function putMergedTranscript(
  tenantId: string,
  meetingId: string,
  merged: BatchMergeResult,
): Promise<void> {
  await putJson(artifactKey(tenantId, meetingId, "transcript.merged.json"), merged);
}

/**
 * Plain put (no condition): an SFN retry of the batchAsr state re-invokes with
 * a fresh task token, and the latest token must win the jobName lookup.
 */
export async function putBatchJobToken(
  record: BatchJobTokenRecord,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: batchJobPk(record.jobName), SK: "TOKEN", ...record },
    }),
  );
}

export async function getBatchJobToken(
  jobName: string,
): Promise<BatchJobTokenRecord | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: batchJobPk(jobName), SK: "TOKEN" },
    }),
  );
  return Item as BatchJobTokenRecord | undefined;
}

export async function deleteBatchJobToken(jobName: string): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: batchJobPk(jobName), SK: "TOKEN" },
    }),
  );
}

// --- Second Brain: notes, chat threads, index bookkeeping ---

function stripItemKeys<T>(item: Record<string, unknown>): T {
  const { PK: _pk, SK: _sk, ...rest } = item;
  return rest as T;
}

export async function putNote(note: Note): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(note.tenantId),
        SK: noteSk(note.ownerSub, note.noteId),
        ...note,
      },
    }),
  );
}

export async function getNote(
  tenantId: string,
  ownerSub: string,
  noteId: string,
): Promise<Note | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: noteSk(ownerSub, noteId) },
    }),
  );
  return Item ? stripItemKeys<Note>(Item) : undefined;
}

export async function listNotes(
  tenantId: string,
  ownerSub: string,
): Promise<Note[]> {
  const notes: Note[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk(tenantId),
          ":sk": `NOTE#${ownerSub}#`,
        },
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      }),
    );
    notes.push(...(page.Items ?? []).map((i) => stripItemKeys<Note>(i)));
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return notes;
}

export async function deleteNote(
  tenantId: string,
  ownerSub: string,
  noteId: string,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: noteSk(ownerSub, noteId) },
    }),
  );
}

export async function putThread(
  tenantId: string,
  ownerSub: string,
  thread: BrainThread,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        PK: pk(tenantId),
        SK: threadSk(ownerSub, thread.threadId),
        ...thread,
      },
    }),
  );
}

export async function getThread(
  tenantId: string,
  ownerSub: string,
  threadId: string,
): Promise<BrainThread | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: threadSk(ownerSub, threadId) },
    }),
  );
  return Item ? stripItemKeys<BrainThread>(Item) : undefined;
}

export async function listThreads(
  tenantId: string,
  ownerSub: string,
): Promise<Pick<BrainThread, "threadId" | "title" | "updatedAt">[]> {
  const threads: Pick<BrainThread, "threadId" | "title" | "updatedAt">[] = [];
  let cursor: Record<string, unknown> | undefined;
  do {
    const page = await ddb.send(
      new QueryCommand({
        TableName: TABLE,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :sk)",
        ExpressionAttributeValues: {
          ":pk": pk(tenantId),
          ":sk": `THREAD#${ownerSub}#`,
        },
        ScanIndexForward: false,
        ExclusiveStartKey: cursor,
      }),
    );
    for (const item of (page.Items ?? []) as BrainThread[]) {
      threads.push({
        threadId: item.threadId,
        title: item.title,
        updatedAt: item.updatedAt,
      });
    }
    cursor = page.LastEvaluatedKey;
  } while (cursor);
  return threads;
}

export async function deleteThread(
  tenantId: string,
  ownerSub: string,
  threadId: string,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: threadSk(ownerSub, threadId) },
    }),
  );
}

export async function putIndexedKeys(
  tenantId: string,
  doc: `MEETING#${string}` | `NOTE#${string}`,
  keys: string[],
  indexVersion: number,
): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: pk(tenantId), SK: idxSk(doc), keys, indexVersion },
    }),
  );
}

export async function getIndexedKeys(
  tenantId: string,
  doc: string,
): Promise<{ keys: string[]; indexVersion: number } | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: idxSk(doc) },
    }),
  );
  return Item as { keys: string[]; indexVersion: number } | undefined;
}

export async function deleteIndexedKeys(
  tenantId: string,
  doc: string,
): Promise<void> {
  await ddb.send(
    new DeleteCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: idxSk(doc) },
    }),
  );
}

async function putJson(key: string, body: unknown): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: key,
      Body: JSON.stringify(body),
      ContentType: "application/json",
    }),
  );
}

async function getJson<T>(key: string): Promise<T> {
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: BUCKET, Key: key }),
  );
  return JSON.parse(await Body!.transformToString()) as T;
}
