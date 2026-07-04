import { App } from "aws-cdk-lib";
import { TeamsAgentCoreStack } from "../lib/teams-agent-core-stack.js";

const app = new App();

new TeamsAgentCoreStack(app, "TeamsAgentCore", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION ?? "us-east-1",
  },
});
