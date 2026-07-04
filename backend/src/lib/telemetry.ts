import {
  CloudWatchClient,
  PutMetricDataCommand,
  type MetricDatum,
} from "@aws-sdk/client-cloudwatch";
import type { PipelineState } from "@teams-agent-core/shared";

const cloudwatch = new CloudWatchClient({});

const NAMESPACE = process.env.METRICS_NAMESPACE ?? "MeetingPipeline";

/** Gate D only drops bad quotes — no extra spend or path, so not an escalation. */
const ESCALATION_GATES = new Set(["gateA", "gateB", "gateC", "gateE"]);

function escalated(pipeline: PipelineState): boolean {
  return (
    pipeline.tier !== "haiku" ||
    (pipeline.scores.gates ?? []).some(
      (g) => g.fired && ESCALATION_GATES.has(g.gate),
    )
  );
}

/**
 * M6 telemetry, emitted per published meeting. Escalation/NeedsReview are 0|1
 * so a CloudWatch `Average` over any window IS the rate — alarms read a single
 * metric, no math expression (matches PipelineTelemetryCounters semantics).
 * Best-effort: a metrics outage must never fail a publish.
 */
export async function emitPublishMetrics(
  pipeline: PipelineState,
  needsReview: boolean,
): Promise<void> {
  const captionAgreementPct = pipeline.scores.correlation?.captionAgreementPct;
  const data: MetricDatum[] = [
    { MetricName: "MeetingPublished", Value: 1, Unit: "Count" },
    // Named *Rate because the alarms read the 0|1 datapoints with `Average`.
    {
      MetricName: "EscalationRate",
      Value: escalated(pipeline) ? 1 : 0,
      Unit: "Count",
    },
    { MetricName: "NeedsReviewRate", Value: needsReview ? 1 : 0, Unit: "Count" },
    // Caption agreement only exists when both signals (captions + ASR) ran —
    // the Gate 0 activation criterion reads this series.
    ...(captionAgreementPct !== undefined
      ? [
          {
            MetricName: "CaptionAgreementPct",
            Value: captionAgreementPct,
            Unit: "Percent" as const,
          },
        ]
      : []),
  ];
  try {
    await cloudwatch.send(
      new PutMetricDataCommand({ Namespace: NAMESPACE, MetricData: data }),
    );
  } catch (err) {
    console.error("telemetry: PutMetricData failed", err);
  }
}
