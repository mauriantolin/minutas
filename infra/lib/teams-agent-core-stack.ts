import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
  aws_s3vectors as s3vectors,
} from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import {
  Bucket,
  BlockPublicAccess,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { Key } from "aws-cdk-lib/aws-kms";
import {
  Alarm,
  ComparisonOperator,
  Metric,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction } from "aws-cdk-lib/aws-events-targets";
import {
  AccountRecovery,
  CfnIdentityPool,
  CfnIdentityPoolRoleAttachment,
  StringAttribute,
  UserPool,
  UserPoolClient,
} from "aws-cdk-lib/aws-cognito";
import {
  FederatedPrincipal,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { HttpApi, HttpMethod, CorsHttpMethod } from "aws-cdk-lib/aws-apigatewayv2";
import { HttpJwtAuthorizer } from "aws-cdk-lib/aws-apigatewayv2-authorizers";
import { HttpLambdaIntegration } from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import { Runtime } from "aws-cdk-lib/aws-lambda";
import {
  Choice,
  Condition,
  DefinitionBody,
  Fail,
  IntegrationPattern,
  JsonPath,
  Pass,
  Result,
  StateMachine,
  Succeed,
  TaskInput,
  Timeout,
  Wait,
  WaitTime,
  type IChainable,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import {
  Distribution,
  Function as CloudFrontFunction,
  FunctionCode,
  FunctionEventType,
  FunctionRuntime,
  ViewerProtocolPolicy,
} from "aws-cdk-lib/aws-cloudfront";
import { S3BucketOrigin } from "aws-cdk-lib/aws-cloudfront-origins";
import type { Construct } from "constructs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BACKEND_SRC = path.join(__dirname, "..", "..", "backend", "src");

export class TeamsAgentCoreStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    // --- Storage: single-table multi-tenant + raw transcripts ---
    const table = new Table(this, "Table", {
      partitionKey: { name: "PK", type: AttributeType.STRING },
      sortKey: { name: "SK", type: AttributeType.STRING },
      billingMode: BillingMode.PAY_PER_REQUEST,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // Customer-managed key so Tier-2 audio (§7) is SSE-KMS end to end.
    // BucketEncryption is an in-place CloudFormation update — the existing
    // bucket resource ("Transcripts" logical id) is reconfigured, not replaced.
    const transcriptsKey = new Key(this, "TranscriptsKey", {
      alias: "teams-agent-core/transcripts",
      enableKeyRotation: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const transcripts = new Bucket(this, "Transcripts", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      encryption: BucketEncryption.KMS,
      encryptionKey: transcriptsKey,
      bucketKeyEnabled: true,
      // S3 lifecycle filters cannot express the mid-key prefix `*/audio/`, so
      // the 7-day hard cap (§7) keys off an `audio=true` object tag; the
      // presigned PUT URLs issued at finalize must sign `x-amz-tagging:
      // audio=true` so uploads land already tagged.
      lifecycleRules: [
        {
          id: "ExpireAudio",
          tagFilters: { audio: "true" },
          expiration: Duration.days(7),
        },
      ],
      removalPolicy: RemovalPolicy.DESTROY,
    });

    // --- Second brain: S3 Vectors bucket (per-tenant indexes created lazily) ---
    const vectorBucket = new s3vectors.CfnVectorBucket(
      this,
      "BrainVectorBucket",
      { vectorBucketName: `${this.account}-teams-agent-core-brain` },
    );
    const vectorBucketName = vectorBucket.vectorBucketName!;
    const vectorBucketArn = `arn:aws:s3vectors:${this.region}:${this.account}:bucket/${vectorBucketName}`;
    const vectorIndexArns = `${vectorBucketArn}/index/tenant-*`;

    // --- Auth: User Pool (login) + Identity Pool (temp creds for Transcribe) ---
    const userPool = new UserPool(this, "UserPool", {
      selfSignUpEnabled: true,
      signInAliases: { email: true },
      autoVerify: { email: true },
      standardAttributes: { fullname: { required: false, mutable: true } },
      customAttributes: {
        tenantId: new StringAttribute({ mutable: true }),
      },
      accountRecovery: AccountRecovery.EMAIL_ONLY,
      removalPolicy: RemovalPolicy.DESTROY,
    });

    const userPoolClient = new UserPoolClient(this, "UserPoolClient", {
      userPool,
      authFlows: { userSrp: true, userPassword: true },
    });

    const identityPool = new CfnIdentityPool(this, "IdentityPool", {
      allowUnauthenticatedIdentities: false,
      cognitoIdentityProviders: [
        {
          clientId: userPoolClient.userPoolClientId,
          providerName: userPool.userPoolProviderName,
        },
      ],
    });

    // Authenticated identities get temp creds scoped ONLY to Transcribe streaming.
    const authRole = new Role(this, "AuthRole", {
      assumedBy: new FederatedPrincipal(
        "cognito-identity.amazonaws.com",
        {
          StringEquals: {
            "cognito-identity.amazonaws.com:aud": identityPool.ref,
          },
          "ForAnyValue:StringLike": {
            "cognito-identity.amazonaws.com:amr": "authenticated",
          },
        },
        "sts:AssumeRoleWithWebIdentity",
      ),
    });
    authRole.addToPolicy(
      new PolicyStatement({
        actions: [
          "transcribe:StartStreamTranscription",
          "transcribe:StartStreamTranscriptionWebSocket",
        ],
        resources: ["*"],
      }),
    );

    new CfnIdentityPoolRoleAttachment(this, "IdentityPoolRoles", {
      identityPoolId: identityPool.ref,
      roles: { authenticated: authRole.roleArn },
    });

    // --- API: HTTP API with JWT authorizer, POST /meetings -> ingest ---
    const fnEnv = {
      TABLE_NAME: table.tableName,
      TRANSCRIPT_BUCKET: transcripts.bucketName,
      BEDROCK_MODEL_ID: "us.anthropic.claude-haiku-4-5-20251001-v1:0",
    };
    const brainEnv = {
      ...fnEnv,
      VECTOR_BUCKET: vectorBucketName,
      EMBED_MODEL_ID: "amazon.titan-embed-text-v2:0",
    };
    const bundling = { format: "esm" as never, target: "node20" };
    const bedrockInvoke = new PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"],
    });
    // Foundation-model ARNs carry no account id.
    const titanInvoke = new PolicyStatement({
      actions: ["bedrock:InvokeModel"],
      resources: [
        `arn:aws:bedrock:${this.region}::foundation-model/amazon.titan-embed-text-v2:0`,
      ],
    });
    // Defense-in-depth: index-level access only under the `tenant-*` pattern.
    const vectorWrite = new PolicyStatement({
      actions: [
        "s3vectors:CreateIndex",
        "s3vectors:GetIndex",
        "s3vectors:ListIndexes",
        "s3vectors:PutVectors",
        "s3vectors:GetVectors",
        "s3vectors:QueryVectors",
        "s3vectors:DeleteVectors",
      ],
      resources: [vectorBucketArn, vectorIndexArns],
    });
    // QueryVectors with filter/returnMetadata also requires GetVectors.
    const vectorQuery = new PolicyStatement({
      actions: [
        "s3vectors:QueryVectors",
        "s3vectors:GetVectors",
        "s3vectors:GetIndex",
      ],
      resources: [vectorBucketArn, vectorIndexArns],
    });

    // --- Async pipeline: one worker Lambda + MeetingPipeline state machine ---
    const modelHaiku = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
    const modelSonnet = "us.anthropic.claude-sonnet-4-5-20250929-v1:0";
    const modelOpus = "us.anthropic.claude-opus-4-5-20251101-v1:0";
    // Cross-region inference profiles route to regional foundation models, so
    // InvokeModel needs both the profile ARN and the underlying model ARNs.
    const bedrockModelAccess = new PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: [modelHaiku, modelSonnet, modelOpus].flatMap((id) => [
        `arn:aws:bedrock:${this.region}:${this.account}:inference-profile/${id}`,
        `arn:aws:bedrock:*::foundation-model/${id.replace(/^us\./, "")}`,
      ]),
    });

    // Gate thresholds are baked into the Choice states at synth time and
    // mirrored into the worker env so the worker's GateDecision audit trail
    // can never disagree with the SFN routing.
    const gateAMaxUnresolvedPct = Number(
      process.env.GATE_A_MAX_UNRESOLVED_PCT ?? "15",
    );
    const gateAMinLabelMargin = Number(
      process.env.GATE_A_MIN_LABEL_MARGIN ?? "0.3",
    );
    const gateAMinCaptionAgreementPct = Number(
      process.env.GATE_A_MIN_CAPTION_AGREEMENT_PCT ?? "80",
    );
    const gateCMinMeanConfidence = Number(
      process.env.GATE_C_MIN_MEAN_CONFIDENCE ?? "0.8",
    );
    const gateCMinP10Confidence = Number(
      process.env.GATE_C_MIN_P10_CONFIDENCE ?? "0.5",
    );
    const gateCMaxCaptionWer = Number(
      process.env.GATE_C_MAX_CAPTION_WER ?? "0.35",
    );
    const gateCMinSelfQuality = Number(
      process.env.GATE_C_MIN_SELF_QUALITY ?? "0.5",
    );
    const gateCMaxGarbledPct = Number(
      process.env.GATE_C_MAX_GARBLED_PCT ?? "20",
    );
    const gateEMaxUnsupportedRate = Number(
      process.env.GATE_E_MAX_UNSUPPORTED_RATE ?? "0.1",
    );
    // Gate B reads tab-source stats (scores.gateB) — meeting-wide asr stats
    // include the always-high-confidence mic stream and would mask a bad tab.
    const gateBMinTabMeanConfidence = Number(
      process.env.GATE_B_MIN_TAB_MEAN_CONFIDENCE ?? "0.8",
    );
    const gateBMinTabP10Confidence = Number(
      process.env.GATE_B_MIN_TAB_P10_CONFIDENCE ?? "0.5",
    );

    const metricsNamespace = "TeamsAgentCore/Pipeline";

    const pipelineWorker = new NodejsFunction(this, "PipelineWorkerFn", {
      entry: path.join(BACKEND_SRC, "handlers", "pipeline.ts"),
      runtime: Runtime.NODEJS_20_X,
      // Sized for the Opus escalation pass on long transcripts.
      timeout: Duration.seconds(600),
      memorySize: 1024,
      environment: {
        TABLE_NAME: table.tableName,
        TRANSCRIPT_BUCKET: transcripts.bucketName,
        // agent.ts resolves its model from BEDROCK_MODEL_ID; keep it in lockstep
        // with the IAM policy above so a model bump can't outrun the policy.
        BEDROCK_MODEL_ID: modelHaiku,
        MODEL_HAIKU: modelHaiku,
        MODEL_SONNET: modelSonnet,
        MODEL_OPUS: modelOpus,
        GATE_A_MAX_UNRESOLVED_PCT: String(gateAMaxUnresolvedPct),
        GATE_A_MIN_LABEL_MARGIN: String(gateAMinLabelMargin),
        GATE_A_MIN_CAPTION_AGREEMENT_PCT: String(gateAMinCaptionAgreementPct),
        GATE_C_MIN_MEAN_CONFIDENCE: String(gateCMinMeanConfidence),
        GATE_C_MIN_P10_CONFIDENCE: String(gateCMinP10Confidence),
        GATE_C_MAX_CAPTION_WER: String(gateCMaxCaptionWer),
        GATE_C_MIN_SELF_QUALITY: String(gateCMinSelfQuality),
        GATE_C_MAX_GARBLED_PCT: String(gateCMaxGarbledPct),
        GATE_E_MAX_UNSUPPORTED_RATE: String(gateEMaxUnsupportedRate),
        GATE_B_MIN_TAB_MEAN_CONFIDENCE: String(gateBMinTabMeanConfidence),
        GATE_B_MIN_TAB_P10_CONFIDENCE: String(gateBMinTabP10Confidence),
        // §2-P3 bounded audio wait: the waitAudio phase owns the deadline and
        // records pipeline.audioTimeout, so the SFN loop can stay counter-free.
        AUDIO_WAIT_TIMEOUT_SEC: "1200",
        METRICS_NAMESPACE: metricsNamespace,
        VECTOR_BUCKET: vectorBucketName,
        EMBED_MODEL_ID: "amazon.titan-embed-text-v2:0",
      },
      bundling,
    });
    table.grantReadWriteData(pipelineWorker);
    transcripts.grantReadWrite(pipelineWorker);
    pipelineWorker.addToRolePolicy(bedrockModelAccess);
    pipelineWorker.addToRolePolicy(vectorWrite);
    pipelineWorker.addToRolePolicy(titanInvoke);
    pipelineWorker.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "transcribe:StartTranscriptionJob",
          "transcribe:GetTranscriptionJob",
        ],
        resources: [
          `arn:aws:transcribe:${this.region}:${this.account}:transcription-job/*`,
        ],
      }),
    );
    // batchAsr fails its own task token immediately when StartTranscriptionJob
    // throws, instead of leaving the wait to run out its 2 h timeout.
    // SendTask* validates the token itself; no resource-level scoping exists.
    pipelineWorker.addToRolePolicy(
      new PolicyStatement({
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
        resources: ["*"],
      }),
    );
    pipelineWorker.addToRolePolicy(
      new PolicyStatement({
        actions: ["cloudwatch:PutMetricData"],
        resources: ["*"],
        conditions: {
          StringEquals: { "cloudwatch:namespace": metricsNamespace },
        },
      }),
    );

    const workerTask = (
      id: string,
      phase: string,
      resultPath: string,
      extraPayload: Record<string, unknown> = {},
    ) => {
      const task = new LambdaInvoke(this, id, {
        lambdaFunction: pipelineWorker,
        payload: TaskInput.fromObject({
          tenantId: JsonPath.stringAt("$.tenantId"),
          meetingId: JsonPath.stringAt("$.meetingId"),
          executionArn: JsonPath.stringAt("$$.Execution.Id"),
          phase,
          ...extraPayload,
        }),
        payloadResponseOnly: true,
        resultPath,
      });
      task.addRetry({
        errors: ["States.ALL"],
        maxAttempts: 2,
        interval: Duration.seconds(3),
        backoffRate: 2,
      });
      return task;
    };

    const setError = new LambdaInvoke(this, "SetError", {
      lambdaFunction: pipelineWorker,
      payload: TaskInput.fromObject({
        tenantId: JsonPath.stringAt("$.tenantId"),
        meetingId: JsonPath.stringAt("$.meetingId"),
        executionArn: JsonPath.stringAt("$$.Execution.Id"),
        phase: "fail",
        error: JsonPath.objectAt("$.error"),
      }),
      payloadResponseOnly: true,
      resultPath: JsonPath.DISCARD,
    });
    // Without retries a transient invoke failure here would end the execution
    // with the meeting stuck in "processing" and no lastError written.
    setError.addRetry({
      errors: ["States.ALL"],
      maxAttempts: 2,
      interval: Duration.seconds(3),
      backoffRate: 2,
    });
    setError.next(new Fail(this, "PipelineFailed"));

    const correlate = workerTask("Correlate", "correlate", "$.correlate");
    const asrScore = workerTask("AsrScore", "asrScore", "$.asrScore");
    // Every LLM phase keeps its result visible at $.phaseResult (read once by
    // the guard right after it) so a needs_review status is never discarded.
    const clean = workerTask("Clean", "clean", "$.phaseResult", {
      modelTier: "haiku",
      speakerRepair: JsonPath.objectAt("$.speakerRepair"),
    });
    const extract = workerTask("Extract", "extract", "$.phaseResult", {
      modelTier: "haiku",
    });
    const synthesize = workerTask("Synthesize", "synthesize", "$.phaseResult", {
      modelTier: JsonPath.stringAt("$.synthTier"),
    });
    // Every verify pass overwrites $.verify so all Gate E choices read one path.
    const verify = workerTask("Verify", "verify", "$.verify", {
      modelTier: "haiku",
    });
    const repair = workerTask("Repair", "repair", "$.phaseResult", {
      modelTier: "haiku",
    });
    const reVerify = workerTask("ReVerify", "verify", "$.verify", {
      modelTier: "haiku",
    });
    const synthesizeSonnet = workerTask(
      "SynthesizeSonnet",
      "synthesize",
      "$.phaseResult",
      { modelTier: "sonnet" },
    );
    const verifyFinal = workerTask("VerifyFinal", "verify", "$.verify", {
      modelTier: "haiku",
    });
    const opusFinal = workerTask("OpusFinal", "synthesize", "$.phaseResult", {
      modelTier: "opus",
    });
    const verifyOpus = workerTask("VerifyOpus", "verify", "$.verify", {
      modelTier: "haiku",
    });
    const publish = workerTask("Publish", "publish", JsonPath.DISCARD);
    // Ladder exhausted: worker publishes with needs_review if the persisted
    // verification scores still fail the Gate E thresholds in its env.
    const publishWithFlag = workerTask(
      "PublishWithFlag",
      "publish",
      JsonPath.DISCARD,
      { flagIfUnverified: true },
    );

    const allTasks = [
      correlate,
      asrScore,
      clean,
      extract,
      synthesize,
      verify,
      repair,
      reVerify,
      synthesizeSonnet,
      verifyFinal,
      opusFinal,
      verifyOpus,
      publish,
      publishWithFlag,
    ];
    for (const task of allTasks) {
      task.addCatch(setError, { resultPath: "$.error" });
    }

    // Choice states cannot mutate state, so each gate routes through a Pass
    // that stamps its decision onto the payload for downstream worker phases.
    const flagSpeakerRepair = new Pass(this, "FlagSpeakerRepair", {
      result: Result.fromBoolean(true),
      resultPath: "$.speakerRepair",
    });
    const skipSpeakerRepair = new Pass(this, "SkipSpeakerRepair", {
      result: Result.fromBoolean(false),
      resultPath: "$.speakerRepair",
    });
    const hintTierSonnet = new Pass(this, "HintTierSonnet", {
      result: Result.fromString("sonnet"),
      resultPath: "$.synthTier",
    });
    const hintTierHaiku = new Pass(this, "HintTierHaiku", {
      result: Result.fromString("haiku"),
      resultPath: "$.synthTier",
    });

    const gateA = new Choice(this, "GateA")
      .when(
        Condition.or(
          Condition.and(
            Condition.isPresent("$.correlate.scores.correlation.unresolvedPct"),
            Condition.numberGreaterThan(
              "$.correlate.scores.correlation.unresolvedPct",
              gateAMaxUnresolvedPct,
            ),
          ),
          Condition.and(
            Condition.isPresent("$.correlate.scores.correlation.labelMarginMin"),
            Condition.numberLessThan(
              "$.correlate.scores.correlation.labelMarginMin",
              gateAMinLabelMargin,
            ),
          ),
          Condition.and(
            Condition.isPresent(
              "$.correlate.scores.correlation.captionAgreementPct",
            ),
            Condition.numberLessThan(
              "$.correlate.scores.correlation.captionAgreementPct",
              gateAMinCaptionAgreementPct,
            ),
          ),
        ),
        flagSpeakerRepair,
      )
      .otherwise(skipSpeakerRepair);

    // GateC here only sees the SFN-visible meanConfidence; the worker's
    // synthesize phase re-reads the full recorded gateC decision (p10, caption
    // WER, P4 self-report) and may out-escalate a haiku hint, never downgrade.
    const gateC = new Choice(this, "GateC")
      .when(
        Condition.and(
          Condition.isPresent("$.asrScore.scores.asr.meanConfidence"),
          Condition.numberLessThan(
            "$.asrScore.scores.asr.meanConfidence",
            gateCMinMeanConfidence,
          ),
        ),
        hintTierSonnet,
      )
      .otherwise(hintTierHaiku);

    // --- Gate B (M5): consented batch re-ASR on the tab source ---
    // The worker emits scores.gateB only under consent Tier 2 with audio
    // declared at finalize (§7), so an absent block == gate structurally closed.
    // The poll deadline anchors on execution start (not meeting end): retried
    // or orphan-recovered finalizes run long after endedAt and their upload
    // starts only at that finalize's 202.
    const waitAudio = workerTask("WaitAudio", "waitAudio", "$.audioWait", {
      executionStartTime: JsonPath.stringAt("$$.Execution.StartTime"),
    });
    // Overwrites $.asrScore so GateC re-evaluates the synth tier on the merged
    // transcript's scores instead of the streaming pass it just replaced.
    const mergeBatch = workerTask("MergeBatch", "mergeBatch", "$.asrScore");

    const batchAsr = new LambdaInvoke(this, "BatchAsr", {
      lambdaFunction: pipelineWorker,
      integrationPattern: IntegrationPattern.WAIT_FOR_TASK_TOKEN,
      payload: TaskInput.fromObject({
        tenantId: JsonPath.stringAt("$.tenantId"),
        meetingId: JsonPath.stringAt("$.meetingId"),
        executionArn: JsonPath.stringAt("$$.Execution.Id"),
        phase: "batchAsr",
        taskToken: JsonPath.taskToken,
      }),
      resultPath: "$.batchAsr",
      // The single Transcribe job-state event via the callback Lambda is the
      // only completion signal — nothing emits heartbeats, so any heartbeat
      // shorter than the job would fail every wait. The timeout alone bounds
      // a lost event (doc §2-P3).
      taskTimeout: Timeout.duration(Duration.hours(2)),
    });
    batchAsr.addRetry({
      errors: [
        "Lambda.ServiceException",
        "Lambda.AWSLambdaException",
        "Lambda.SdkClientException",
        "Lambda.TooManyRequestsException",
      ],
      maxAttempts: 2,
      interval: Duration.seconds(3),
      backoffRate: 2,
    });

    // Batch re-ASR failing must never kill the meeting: every batch-path
    // failure falls back to the streaming-text pipeline (GateC onward, exactly
    // as if Gate B never fired), keeping the error for the audit trail.
    waitAudio.addCatch(gateC, { resultPath: "$.batchError" });
    batchAsr.addCatch(gateC, { resultPath: "$.batchError" });
    mergeBatch.addCatch(gateC, { resultPath: "$.batchError" });

    // The upload races the pipeline (doc D3): poll the sources declared at
    // finalize, never an opportunistic S3 check. On timeout the worker records
    // pipeline.audioTimeout and the pipeline proceeds on streaming text.
    const audioPollWait = new Wait(this, "AudioPollWait", {
      time: WaitTime.duration(Duration.seconds(30)),
    });
    const audioReady = new Choice(this, "AudioReady")
      .when(
        Condition.and(
          Condition.isPresent("$.audioWait.audioReady"),
          Condition.booleanEquals("$.audioWait.audioReady", true),
        ),
        batchAsr,
      )
      .when(
        Condition.and(
          Condition.isPresent("$.audioWait.audioTimedOut"),
          Condition.booleanEquals("$.audioWait.audioTimedOut", true),
        ),
        gateC,
      )
      .otherwise(audioPollWait);

    // Routes on the worker's flat action, not raw thresholds: §7 consent is
    // part of the Gate B decision (thresholds alone would send every
    // non-consented captions-primary meeting — zero tab confidence — into the
    // poll loop), and the recorded GateDecision can never disagree with SFN.
    const gateB = new Choice(this, "GateB")
      .when(
        Condition.and(
          Condition.isPresent("$.asrScore.gateBAction"),
          Condition.stringEquals("$.asrScore.gateBAction", "batchAsr"),
        ),
        waitAudio,
      )
      .otherwise(gateC);

    const verifRate = "$.verify.scores.verification.unsupportedRate";
    const verifUnsupported = "$.verify.scores.verification.unsupported";
    // Optional absolute floor: any UNSUPPORTED on a critical field escalates
    // regardless of rate. isPresent-guarded because the worker only emits it
    // once critical-claim tallying lands.
    const verifCritical = "$.verify.scores.verification.criticalUnsupported";
    const gateEFail = () =>
      Condition.or(
        Condition.and(
          Condition.isPresent(verifRate),
          Condition.numberGreaterThan(verifRate, gateEMaxUnsupportedRate),
        ),
        Condition.and(
          Condition.isPresent(verifCritical),
          Condition.numberGreaterThan(verifCritical, 0),
        ),
      );

    // §2-P7 ladder: heavy failure skips targeted repair and goes straight to
    // Sonnet; any leftover unsupported claim below the rate threshold gets one
    // targeted repair pass; zero unsupported publishes.
    const gateE = new Choice(this, "GateE")
      .when(gateEFail(), synthesizeSonnet)
      .when(
        Condition.and(
          Condition.isPresent(verifUnsupported),
          Condition.numberGreaterThan(verifUnsupported, 0),
        ),
        repair,
      )
      .otherwise(publish);
    // Post-repair residual below the rate bar publishes, but the worker's
    // publish phase flags any leftover unsupported claim as needs_review —
    // "ready" is reserved for fully verified summaries.
    const gateE2 = new Choice(this, "GateE2")
      .when(gateEFail(), synthesizeSonnet)
      .otherwise(publish);
    const gateE3 = new Choice(this, "GateE3")
      .when(gateEFail(), opusFinal)
      .otherwise(publish);

    // A parse/validation failure inside an LLM phase already published the
    // meeting as needs_review (a valid terminal state, §2-P7): the execution
    // must SUCCEED there instead of running the next phase against a missing
    // artifact and letting SetError stamp a terminal "failed" over it.
    const needsReviewPublished = new Succeed(this, "NeedsReviewPublished");
    const parseGuard = (id: string, statusPath: string, next: IChainable) =>
      new Choice(this, id)
        .when(
          Condition.and(
            Condition.isPresent(statusPath),
            Condition.stringEquals(statusPath, "needs_review"),
          ),
          needsReviewPublished,
        )
        .otherwise(next);

    correlate.next(gateA);
    flagSpeakerRepair.next(asrScore);
    skipSpeakerRepair.next(asrScore);
    asrScore.next(gateB);
    waitAudio.next(audioReady);
    audioPollWait.next(waitAudio);
    batchAsr.next(mergeBatch);
    // Re-enters the LLM ladder through GateC: mergeBatch re-ran P2 + P3 over
    // the merged transcript and left the fresh scores at $.asrScore.
    mergeBatch.next(gateC);
    hintTierSonnet.next(clean);
    hintTierHaiku.next(clean);
    clean.next(parseGuard("CleanOk", "$.phaseResult.status", extract));
    extract.next(parseGuard("ExtractOk", "$.phaseResult.status", synthesize));
    synthesize.next(parseGuard("SynthesizeOk", "$.phaseResult.status", verify));
    verify.next(parseGuard("VerifyOk", "$.verify.status", gateE));
    repair.next(parseGuard("RepairOk", "$.phaseResult.status", reVerify));
    reVerify.next(parseGuard("ReVerifyOk", "$.verify.status", gateE2));
    synthesizeSonnet.next(
      parseGuard("SynthesizeSonnetOk", "$.phaseResult.status", verifyFinal),
    );
    verifyFinal.next(parseGuard("VerifyFinalOk", "$.verify.status", gateE3));
    opusFinal.next(parseGuard("OpusFinalOk", "$.phaseResult.status", verifyOpus));
    verifyOpus.next(
      parseGuard("VerifyOpusOk", "$.verify.status", publishWithFlag),
    );

    // Post-publish vector indexing: the meeting is already published, so an
    // indexing failure must never re-route through SetError and stamp a
    // terminal "failed" over a live meeting — it records indexStatus instead.
    const indexMeetingTask = workerTask(
      "IndexMeeting",
      "index",
      JsonPath.DISCARD,
    );
    const indexFail = workerTask(
      "IndexMeetingFail",
      "indexFail",
      JsonPath.DISCARD,
    );
    indexMeetingTask.addCatch(indexFail, { resultPath: "$.indexError" });
    indexMeetingTask.next(new Succeed(this, "Indexed"));
    indexFail.next(
      new Fail(this, "IndexingFailed", {
        error: "IndexingFailed",
        cause: "vector indexing failed after publish",
      }),
    );
    publish.next(indexMeetingTask);
    publishWithFlag.next(indexMeetingTask);

    const pipeline = new StateMachine(this, "MeetingPipeline", {
      definitionBody: DefinitionBody.fromChainable(correlate),
      // 2 h LLM budget + Gate B worst case (20 min audio poll + 2 h batch job).
      timeout: Duration.hours(5),
    });

    // EventBridge is the only completion channel for Transcribe Batch — the
    // event carries just jobName + status, so the callback resolves the task
    // token from the jobName-keyed record persisted before the job started.
    const transcribeCallback = new NodejsFunction(this, "TranscribeCallbackFn", {
      entry: path.join(BACKEND_SRC, "handlers", "transcribe-callback.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: { TABLE_NAME: table.tableName },
      bundling,
    });
    // Read-write: the handler deletes the consumed BATCHJOB# token record.
    table.grantReadWriteData(transcribeCallback);
    // The callback re-reads the authoritative job status — the EventBridge
    // event itself is unauthenticated in a shared account.
    transcribeCallback.addToRolePolicy(
      new PolicyStatement({
        actions: ["transcribe:GetTranscriptionJob"],
        resources: [
          `arn:aws:transcribe:${this.region}:${this.account}:transcription-job/*`,
        ],
      }),
    );
    // SendTask* validates the token itself; no resource-level scoping exists.
    transcribeCallback.addToRolePolicy(
      new PolicyStatement({
        actions: ["states:SendTaskSuccess", "states:SendTaskFailure"],
        resources: ["*"],
      }),
    );
    new Rule(this, "TranscribeJobStateChange", {
      eventPattern: {
        source: ["aws.transcribe"],
        detailType: ["Transcribe Job State Change"],
        detail: { TranscriptionJobStatus: ["COMPLETED", "FAILED"] },
      },
      targets: [new LambdaFunction(transcribeCallback)],
    });

    // --- Telemetry alarms (M6): dashboard-only, no actions until the
    // thresholds are calibrated against the golden set (§8 risk 2). Rates are
    // pre-computed at emission, so alarms read a single metric.
    const alarmMaxEscalationRate = Number(
      process.env.ALARM_MAX_ESCALATION_RATE ?? "0.25",
    );
    const alarmMaxNeedsReviewRate = Number(
      process.env.ALARM_MAX_NEEDS_REVIEW_RATE ?? "0.15",
    );
    const rateAlarm = (id: string, metricName: string, threshold: number) =>
      new Alarm(this, id, {
        metric: new Metric({
          namespace: metricsNamespace,
          metricName,
          statistic: "Average",
          period: Duration.hours(1),
        }),
        threshold,
        evaluationPeriods: 1,
        comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
        treatMissingData: TreatMissingData.NOT_BREACHING,
      });
    rateAlarm("EscalationRateAlarm", "EscalationRate", alarmMaxEscalationRate);
    rateAlarm(
      "NeedsReviewRateAlarm",
      "NeedsReviewRate",
      alarmMaxNeedsReviewRate,
    );

    const ingest = new NodejsFunction(this, "IngestFn", {
      entry: path.join(BACKEND_SRC, "handlers", "ingest.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: { ...fnEnv, STATE_MACHINE_ARN: pipeline.stateMachineArn },
      bundling,
    });
    table.grantReadWriteData(ingest);
    // Presigned audio PUT URLs issued at finalize sign with THIS role. The
    // internet-facing handler only ever writes `*/audio/*` (presigned) and
    // `*/raw-payload.json` — bucket-wide grantPut would turn any future
    // key-construction bug into cross-tenant artifact tampering.
    // s3:PutObjectTagging covers the signed x-amz-tagging lifecycle tag.
    ingest.addToRolePolicy(
      new PolicyStatement({
        actions: ["s3:PutObject", "s3:PutObjectTagging"],
        resources: [
          `${transcripts.bucketArn}/*/audio/*`,
          `${transcripts.bucketArn}/*/raw-payload.json`,
        ],
      }),
    );
    // The narrow S3 statement no longer carries the KMS grant that grantPut
    // emitted (SSE-KMS writes need GenerateDataKey*).
    transcriptsKey.grantEncrypt(ingest);
    pipeline.grantStartExecution(ingest);
    // Reprocess must 409 on an already-running execution.
    pipeline.grantRead(ingest);

    // Read + Q&A over stored meetings.
    const meetingsGet = new NodejsFunction(this, "MeetingsGetFn", {
      entry: path.join(BACKEND_SRC, "handlers", "meetings.ts"),
      handler: "get",
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: fnEnv,
      bundling,
    });
    table.grantReadData(meetingsGet);
    transcripts.grantRead(meetingsGet);

    const meetingsAsk = new NodejsFunction(this, "MeetingsAskFn", {
      entry: path.join(BACKEND_SRC, "handlers", "meetings.ts"),
      handler: "ask",
      runtime: Runtime.NODEJS_20_X,
      // API Gateway HTTP APIs abandon the request at a hard 30s; anything
      // longer only bills for answers the client already dropped.
      timeout: Duration.seconds(29),
      environment: fnEnv,
      bundling,
    });
    table.grantReadData(meetingsAsk);
    transcripts.grantRead(meetingsAsk);
    meetingsAsk.addToRolePolicy(bedrockInvoke);

    const meetingsDelete = new NodejsFunction(this, "MeetingsDeleteFn", {
      entry: path.join(BACKEND_SRC, "handlers", "meetings.ts"),
      handler: "del",
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      environment: fnEnv,
      bundling,
    });
    // Prefix delete reads the meeting item, queries SEGS# chunks and lists the
    // S3 prefix before deleting.
    table.grantReadWriteData(meetingsDelete);
    transcripts.grantRead(meetingsDelete);
    transcripts.grantDelete(meetingsDelete);

    // Admin API: Cognito user management, gated to the "admin" group in-handler.
    const adminFn = new NodejsFunction(this, "AdminFn", {
      entry: path.join(BACKEND_SRC, "handlers", "admin.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(30),
      memorySize: 256,
      environment: { USER_POOL_ID: userPool.userPoolId },
      bundling,
    });
    adminFn.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "cognito-idp:ListUsers",
          "cognito-idp:AdminCreateUser",
          "cognito-idp:AdminSetUserPassword",
          "cognito-idp:AdminDeleteUser",
          "cognito-idp:AdminAddUserToGroup",
          "cognito-idp:AdminRemoveUserFromGroup",
          "cognito-idp:AdminListGroupsForUser",
          "cognito-idp:AdminGetUser",
          "cognito-idp:AdminUpdateUserAttributes",
        ],
        resources: [userPool.userPoolArn],
      }),
    );

    // --- Second brain: account-level chat, notes CRUD and admin backfill ---
    const brainFn = new NodejsFunction(this, "BrainFn", {
      entry: path.join(BACKEND_SRC, "handlers", "brain.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...brainEnv,
        MODEL_HAIKU: modelHaiku,
        MODEL_SONNET: modelSonnet,
        MODEL_OPUS: modelOpus,
      },
      bundling,
    });
    table.grantReadWriteData(brainFn);
    brainFn.addToRolePolicy(bedrockModelAccess);
    brainFn.addToRolePolicy(titanInvoke);
    brainFn.addToRolePolicy(vectorQuery);

    const notesFn = new NodejsFunction(this, "NotesFn", {
      entry: path.join(BACKEND_SRC, "handlers", "notes.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      memorySize: 512,
      environment: {
        ...brainEnv,
        MODEL_HAIKU: modelHaiku,
        MODEL_SONNET: modelSonnet,
        MODEL_OPUS: modelOpus,
      },
      bundling,
    });
    table.grantReadWriteData(notesFn);
    notesFn.addToRolePolicy(bedrockModelAccess);
    notesFn.addToRolePolicy(titanInvoke);
    notesFn.addToRolePolicy(vectorWrite);

    const reindexFn = new NodejsFunction(this, "ReindexFn", {
      entry: path.join(BACKEND_SRC, "handlers", "reindex.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(29),
      memorySize: 1024,
      environment: brainEnv,
      bundling,
    });
    table.grantReadWriteData(reindexFn);
    transcripts.grantRead(reindexFn);
    reindexFn.addToRolePolicy(titanInvoke);
    reindexFn.addToRolePolicy(vectorWrite);

    const authorizer = new HttpJwtAuthorizer(
      "JwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    const api = new HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [
          CorsHttpMethod.POST,
          CorsHttpMethod.GET,
          CorsHttpMethod.PUT,
          CorsHttpMethod.DELETE,
        ],
        allowHeaders: ["authorization", "content-type"],
      },
    });
    api.addRoutes({
      path: "/meetings",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("IngestIntegration", ingest),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}/segments",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("SegmentsIntegration", ingest),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}/finalize",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("FinalizeIntegration", ingest),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}/reprocess",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("ReprocessIntegration", ingest),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("ListIntegration", meetingsGet),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}",
      methods: [HttpMethod.GET],
      integration: new HttpLambdaIntegration("GetIntegration", meetingsGet),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}",
      methods: [HttpMethod.DELETE],
      integration: new HttpLambdaIntegration("DeleteIntegration", meetingsDelete),
      authorizer,
    });
    api.addRoutes({
      path: "/meetings/{id}/ask",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("AskIntegration", meetingsAsk),
      authorizer,
    });

    const adminIntegration = new HttpLambdaIntegration(
      "AdminIntegration",
      adminFn,
    );
    api.addRoutes({
      path: "/admin/users",
      methods: [HttpMethod.GET, HttpMethod.POST],
      integration: adminIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/admin/users/{email}",
      methods: [HttpMethod.DELETE],
      integration: adminIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/admin/users/{email}/password",
      methods: [HttpMethod.POST],
      integration: adminIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/admin/users/{email}/role",
      methods: [HttpMethod.POST],
      integration: adminIntegration,
      authorizer,
    });

    const brainIntegration = new HttpLambdaIntegration(
      "BrainIntegration",
      brainFn,
    );
    api.addRoutes({
      path: "/brain/ask",
      methods: [HttpMethod.POST],
      integration: brainIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/brain/threads",
      methods: [HttpMethod.GET],
      integration: brainIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/brain/threads/{id}",
      methods: [HttpMethod.GET, HttpMethod.DELETE],
      integration: brainIntegration,
      authorizer,
    });

    const notesIntegration = new HttpLambdaIntegration(
      "NotesIntegration",
      notesFn,
    );
    api.addRoutes({
      path: "/notes",
      methods: [HttpMethod.POST, HttpMethod.GET],
      integration: notesIntegration,
      authorizer,
    });
    api.addRoutes({
      path: "/notes/{id}",
      methods: [HttpMethod.GET, HttpMethod.PUT, HttpMethod.DELETE],
      integration: notesIntegration,
      authorizer,
    });

    api.addRoutes({
      path: "/admin/reindex",
      methods: [HttpMethod.POST],
      integration: new HttpLambdaIntegration("ReindexIntegration", reindexFn),
      authorizer,
    });

    // --- Web hosting: private S3 + CloudFront (OAC) for the Next.js dashboard ---
    const webBucket = new Bucket(this, "WebBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    // Next.js static export writes each route as <route>/index.html; S3 origins
    // don't resolve directory indexes, so extensionless route requests are
    // rewritten at the edge. Query strings live outside request.uri and pass
    // through untouched. Unknown paths still fall to the SPA 404 fallback below.
    const spaRewrite = new CloudFrontFunction(this, "SpaRewriteFn", {
      runtime: FunctionRuntime.JS_2_0,
      code: FunctionCode.fromInline(`
function handler(event) {
  var request = event.request;
  var routes = ["/login", "/meetings", "/meeting", "/live", "/kits", "/settings", "/admin", "/brain", "/notes"];
  var uri = request.uri.endsWith("/") ? request.uri.slice(0, -1) : request.uri;
  if (routes.includes(uri)) {
    request.uri = uri + "/index.html";
  }
  return request;
}
`),
    });
    const distribution = new Distribution(this, "WebDistribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        functionAssociations: [
          {
            function: spaRewrite,
            eventType: FunctionEventType.VIEWER_REQUEST,
          },
        ],
      },
      defaultRootObject: "index.html",
      errorResponses: [
        { httpStatus: 403, responseHttpStatus: 200, responsePagePath: "/index.html" },
        { httpStatus: 404, responseHttpStatus: 200, responsePagePath: "/index.html" },
      ],
    });

    // --- Outputs (consumed by extension + web config) ---
    new CfnOutput(this, "UserPoolId", { value: userPool.userPoolId });
    new CfnOutput(this, "UserPoolClientId", {
      value: userPoolClient.userPoolClientId,
    });
    new CfnOutput(this, "IdentityPoolId", { value: identityPool.ref });
    new CfnOutput(this, "ApiUrl", { value: api.apiEndpoint });
    new CfnOutput(this, "WebBucketName", { value: webBucket.bucketName });
    new CfnOutput(this, "WebDistributionId", {
      value: distribution.distributionId,
    });
    new CfnOutput(this, "WebUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
    new CfnOutput(this, "VectorBucketName", { value: vectorBucketName });
  }
}
