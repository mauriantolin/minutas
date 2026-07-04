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

    const ingest = new NodejsFunction(this, "IngestFn", {
      entry: path.join(BACKEND_SRC, "handlers", "ingest.ts"),
      runtime: Runtime.NODEJS_20_X,
      timeout: Duration.seconds(120),
      memorySize: 512,
      environment: fnEnv,
      bundling,
    });
    table.grantWriteData(ingest);
    transcripts.grantPut(ingest);
    ingest.addToRolePolicy(bedrockInvoke);

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
    table.grantWriteData(meetingsDelete);
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
