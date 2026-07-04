import { fileURLToPath } from "node:url";
import path from "node:path";
import {
  CfnOutput,
  Duration,
  RemovalPolicy,
  Stack,
  type StackProps,
} from "aws-cdk-lib";
import { AttributeType, BillingMode, Table } from "aws-cdk-lib/aws-dynamodb";
import { Bucket, BlockPublicAccess } from "aws-cdk-lib/aws-s3";
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
  JsonPath,
  StateMachine,
  TaskInput,
} from "aws-cdk-lib/aws-stepfunctions";
import { LambdaInvoke } from "aws-cdk-lib/aws-stepfunctions-tasks";
import {
  Distribution,
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

    const transcripts = new Bucket(this, "Transcripts", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
    });

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
    const bundling = { format: "esm" as never, target: "node20" };
    const bedrockInvoke = new PolicyStatement({
      actions: ["bedrock:InvokeModel", "bedrock:InvokeModelWithResponseStream"],
      resources: ["*"],
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

    const pipelineWorker = new NodejsFunction(this, "PipelineWorkerFn", {
      entry: path.join(BACKEND_SRC, "handlers", "pipeline.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(300),
      memorySize: 512,
      environment: {
        TABLE_NAME: table.tableName,
        TRANSCRIPT_BUCKET: transcripts.bucketName,
        // agent.ts resolves its model from BEDROCK_MODEL_ID; keep it in lockstep
        // with the IAM policy above so a model bump can't outrun the policy.
        BEDROCK_MODEL_ID: modelHaiku,
        MODEL_HAIKU: modelHaiku,
        MODEL_SONNET: modelSonnet,
        MODEL_OPUS: modelOpus,
      },
      bundling,
    });
    table.grantReadWriteData(pipelineWorker);
    transcripts.grantReadWrite(pipelineWorker);
    pipelineWorker.addToRolePolicy(bedrockModelAccess);

    const workerTask = (id: string, phase: string, resultPath: string) => {
      const task = new LambdaInvoke(this, id, {
        lambdaFunction: pipelineWorker,
        payload: TaskInput.fromObject({
          tenantId: JsonPath.stringAt("$.tenantId"),
          meetingId: JsonPath.stringAt("$.meetingId"),
          executionArn: JsonPath.stringAt("$$.Execution.Id"),
          phase,
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
    const publish = workerTask("Publish", "publish", JsonPath.DISCARD);
    for (const task of [correlate, asrScore, publish]) {
      task.addCatch(setError, { resultPath: "$.error" });
    }

    // Gate thresholds are baked into the Choice states at synth time; both
    // branches continue for now — real routing lands with the M3 gates.
    const gateAMaxUnresolvedPct = Number(
      process.env.GATE_A_MAX_UNRESOLVED_PCT ?? "15",
    );
    const gateAMinLabelMargin = Number(
      process.env.GATE_A_MIN_LABEL_MARGIN ?? "0.3",
    );
    const gateCMinMeanConfidence = Number(
      process.env.GATE_C_MIN_MEAN_CONFIDENCE ?? "0.8",
    );

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
        ),
        asrScore,
      )
      .otherwise(asrScore);

    const gateC = new Choice(this, "GateC")
      .when(
        Condition.and(
          Condition.isPresent("$.asrScore.scores.asr.meanConfidence"),
          Condition.numberLessThan(
            "$.asrScore.scores.asr.meanConfidence",
            gateCMinMeanConfidence,
          ),
        ),
        publish,
      )
      .otherwise(publish);

    correlate.next(gateA);
    asrScore.next(gateC);

    const pipeline = new StateMachine(this, "MeetingPipeline", {
      definitionBody: DefinitionBody.fromChainable(correlate),
      timeout: Duration.hours(2),
    });

    const ingest = new NodejsFunction(this, "IngestFn", {
      entry: path.join(BACKEND_SRC, "handlers", "ingest.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(15),
      memorySize: 512,
      environment: { ...fnEnv, STATE_MACHINE_ARN: pipeline.stateMachineArn },
      bundling,
    });
    table.grantReadWriteData(ingest);
    transcripts.grantPut(ingest);
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
      timeout: Duration.seconds(60),
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

    const authorizer = new HttpJwtAuthorizer(
      "JwtAuthorizer",
      `https://cognito-idp.${this.region}.amazonaws.com/${userPool.userPoolId}`,
      { jwtAudience: [userPoolClient.userPoolClientId] },
    );

    const api = new HttpApi(this, "Api", {
      corsPreflight: {
        allowOrigins: ["*"],
        allowMethods: [CorsHttpMethod.POST, CorsHttpMethod.GET, CorsHttpMethod.DELETE],
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

    // --- Web hosting: private S3 + CloudFront (OAC) for the Next.js dashboard ---
    const webBucket = new Bucket(this, "WebBucket", {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });
    const distribution = new Distribution(this, "WebDistribution", {
      defaultBehavior: {
        origin: S3BucketOrigin.withOriginAccessControl(webBucket),
        viewerProtocolPolicy: ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
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
    new CfnOutput(this, "WebUrl", {
      value: `https://${distribution.distributionDomainName}`,
    });
  }
}
