import type { EventBridgeEvent } from "aws-lambda";
import {
  GetTranscriptionJobCommand,
  TranscribeClient,
} from "@aws-sdk/client-transcribe";
import { deleteBatchJobToken, getBatchJobToken } from "../lib/store.js";
import { sendTaskFailure, sendTaskSuccess } from "../lib/sfn.js";

const transcribe = new TranscribeClient({});

interface TranscribeJobStateDetail {
  TranscriptionJobName: string;
  TranscriptionJobStatus: "COMPLETED" | "FAILED";
  FailureReason?: string;
}

/**
 * EventBridge `Transcribe Job State Change` target: the event carries only the
 * job name and status — no metadata channel exists for the task token — so the
 * token and owning meeting are resolved from the jobName-keyed record the
 * batchAsr phase persisted before starting the job (doc §2-P3).
 */
export const handler = async (
  event: EventBridgeEvent<"Transcribe Job State Change", TranscribeJobStateDetail>,
): Promise<void> => {
  const jobName = event.detail.TranscriptionJobName;

  // No record = a job this pipeline never started (the account is shared) or a
  // duplicate delivery after the record was consumed — both are ignorable.
  const record = await getBatchJobToken(jobName);
  if (!record) return;

  // The event is only a wake-up: any same-account principal with
  // events:PutEvents can publish a matching payload (EventBridge does not
  // authenticate the source), so status and failure reason come from the
  // Transcribe API, never from the event.
  const { TranscriptionJob: job } = await transcribe.send(
    new GetTranscriptionJobCommand({ TranscriptionJobName: jobName }),
  );
  const status = job?.TranscriptionJobStatus;

  if (status === "COMPLETED") {
    // The output location is deterministic (OutputKey set at job start), so the
    // mergeBatch phase re-derives it from tenant/meeting — the payload is for
    // the execution history, not a required input.
    await sendTaskSuccess(record.taskToken, {
      jobName,
      tenantId: record.tenantId,
      meetingId: record.meetingId,
    });
  } else if (status === "FAILED") {
    await sendTaskFailure(
      record.taskToken,
      "TranscribeJobFailed",
      job?.FailureReason ?? jobName,
    );
  } else {
    // Still IN_PROGRESS/QUEUED (spoofed or early event): keep the token record
    // for the genuine job-state event.
    return;
  }
  await deleteBatchJobToken(jobName);
};
