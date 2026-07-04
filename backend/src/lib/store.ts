import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  BatchWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectsCommand,
  GetObjectCommand,
  ListObjectsV2Command,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  DiarizedSegment,
  LabeledSegment,
  Meeting,
  MeetingIngestPayload,
  MeetingRecord,
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
