import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  GetCommand,
  QueryCommand,
  UpdateCommand,
  DeleteCommand,
} from "@aws-sdk/lib-dynamodb";
import {
  DeleteObjectCommand,
  GetObjectCommand,
  PutObjectCommand,
  S3Client,
} from "@aws-sdk/client-s3";
import type {
  LabeledSegment,
  Meeting,
  MeetingRecord,
  MeetingStatus,
  MeetingSummary,
} from "@teams-agent-core/shared";

const ddb = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const s3 = new S3Client({});

const TABLE = process.env.TABLE_NAME!;
const BUCKET = process.env.TRANSCRIPT_BUCKET!;

const pk = (tenantId: string) => `TENANT#${tenantId}`;
const sk = (meetingId: string) => `MEETING#${meetingId}`;

export async function putMeeting(meeting: Meeting): Promise<void> {
  await ddb.send(
    new PutCommand({
      TableName: TABLE,
      Item: { PK: pk(meeting.tenantId), SK: sk(meeting.meetingId), ...meeting },
    }),
  );
}

export async function setMeetingStatus(
  tenantId: string,
  meetingId: string,
  status: MeetingStatus,
  summary?: MeetingSummary,
): Promise<void> {
  await ddb.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: sk(meetingId) },
      UpdateExpression: summary
        ? "SET #s = :s, summary = :sum"
        : "SET #s = :s",
      ExpressionAttributeNames: { "#s": "status" },
      ExpressionAttributeValues: summary
        ? { ":s": status, ":sum": summary }
        : { ":s": status },
    }),
  );
}

export async function getMeeting(
  tenantId: string,
  meetingId: string,
): Promise<MeetingRecord | undefined> {
  const { Item } = await ddb.send(
    new GetCommand({
      TableName: TABLE,
      Key: { PK: pk(tenantId), SK: sk(meetingId) },
    }),
  );
  if (!Item) return undefined;
  const segments = await getTranscript(tenantId, meetingId);
  return { ...(Item as Meeting), segments } as MeetingRecord;
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

export async function deleteMeeting(
  tenantId: string,
  meetingId: string,
): Promise<void> {
  await Promise.all([
    ddb.send(
      new DeleteCommand({
        TableName: TABLE,
        Key: { PK: pk(tenantId), SK: sk(meetingId) },
      }),
    ),
    s3
      .send(
        new DeleteObjectCommand({
          Bucket: BUCKET,
          Key: `${tenantId}/${meetingId}/transcript.json`,
        }),
      )
      .catch(() => {}),
  ]);
}

export async function putTranscript(
  tenantId: string,
  meetingId: string,
  segments: LabeledSegment[],
): Promise<void> {
  await s3.send(
    new PutObjectCommand({
      Bucket: BUCKET,
      Key: `${tenantId}/${meetingId}/transcript.json`,
      Body: JSON.stringify(segments),
      ContentType: "application/json",
    }),
  );
}

export async function getTranscript(
  tenantId: string,
  meetingId: string,
): Promise<LabeledSegment[]> {
  const { Body } = await s3.send(
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: `${tenantId}/${meetingId}/transcript.json`,
    }),
  );
  return JSON.parse(await Body!.transformToString()) as LabeledSegment[];
}
