import {
  DescribeExecutionCommand,
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
  SFNClient,
  StartExecutionCommand,
} from "@aws-sdk/client-sfn";
import type { PipelinePhase } from "@teams-agent-core/shared";

const sfn = new SFNClient({});

const STATE_MACHINE_ARN = process.env.STATE_MACHINE_ARN!;

export interface PipelineInput {
  tenantId: string;
  meetingId: string;
  /** Restart point for reprocess runs; the state machine skips earlier phases. */
  fromPhase?: PipelinePhase;
}

/**
 * SFN execution names allow only [A-Za-z0-9_-] and 80 chars; meeting ids carry
 * ISO timestamps (colons, dots). The sanitization must stay deterministic — the
 * name IS the 90-day idempotency key for finalize.
 */
export function executionName(meetingId: string, attempt?: number): string {
  const base = meetingId.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 70);
  return attempt === undefined ? base : `${base}--${attempt}`;
}

/**
 * Starts the pipeline; returns the executionArn, or undefined when an execution
 * with this name already exists (idempotent finalize replay).
 */
export async function startPipeline(
  name: string,
  input: PipelineInput,
): Promise<string | undefined> {
  try {
    const { executionArn } = await sfn.send(
      new StartExecutionCommand({
        stateMachineArn: STATE_MACHINE_ARN,
        name,
        input: JSON.stringify(input),
      }),
    );
    return executionArn;
  } catch (err) {
    if ((err as Error).name === "ExecutionAlreadyExists") return undefined;
    throw err;
  }
}

// The waiting state carries HeartbeatSeconds/TimeoutSeconds (~2h), so by the
// time a delayed/duplicated EventBridge delivery lands the token may already
// be consumed or timed out — that is a resolved wait, not an error to retry.
const TOKEN_GONE = new Set(["TaskTimedOut", "TaskDoesNotExist"]);

export async function sendTaskSuccess(
  taskToken: string,
  output: unknown,
): Promise<void> {
  try {
    await sfn.send(
      new SendTaskSuccessCommand({ taskToken, output: JSON.stringify(output) }),
    );
  } catch (err) {
    if (!TOKEN_GONE.has((err as Error).name)) throw err;
  }
}

export async function sendTaskFailure(
  taskToken: string,
  error: string,
  cause?: string,
): Promise<void> {
  try {
    await sfn.send(new SendTaskFailureCommand({ taskToken, error, cause }));
  } catch (err) {
    if (!TOKEN_GONE.has((err as Error).name)) throw err;
  }
}

export async function isExecutionRunning(
  executionArn: string,
): Promise<boolean> {
  try {
    const { status } = await sfn.send(
      new DescribeExecutionCommand({ executionArn }),
    );
    return status === "RUNNING";
  } catch (err) {
    // A pruned execution history (>90 days) is trivially not running.
    if ((err as Error).name === "ExecutionDoesNotExist") return false;
    throw err;
  }
}
