#!/usr/bin/env node
import "source-map-support/register";
import * as cdk from "aws-cdk-lib";
import { GitHubAgentStack } from "../lib/stack";

const app = new cdk.App();

new GitHubAgentStack(app, "GitHubAgentStack", {
  env: {
    account: process.env.CDK_DEFAULT_ACCOUNT,
    region: process.env.CDK_DEFAULT_REGION,
  },
});
