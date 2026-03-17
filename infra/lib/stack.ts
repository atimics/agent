import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as ssm from "aws-cdk-lib/aws-ssm";
import * as logs from "aws-cdk-lib/aws-logs";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import * as path from "path";

export class GitHubAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // -------------------------------------------------------
    // SSM Parameters (create placeholders — fill values manually)
    // -------------------------------------------------------
    const githubTokenParam = new ssm.StringParameter(this, "GitHubToken", {
      parameterName: "/github-agent/GITHUB_TOKEN",
      stringValue: "REPLACE_ME",
      description: "GitHub personal access token",
      tier: ssm.ParameterTier.STANDARD,
    });

    const webhookSecretParam = new ssm.StringParameter(
      this,
      "GitHubWebhookSecret",
      {
        parameterName: "/github-agent/GITHUB_WEBHOOK_SECRET",
        stringValue: "REPLACE_ME",
        description: "GitHub webhook secret for HMAC validation",
        tier: ssm.ParameterTier.STANDARD,
      }
    );

    const openrouterKeyParam = new ssm.StringParameter(
      this,
      "OpenRouterApiKey",
      {
        parameterName: "/github-agent/OPENROUTER_API_KEY",
        stringValue: "REPLACE_ME",
        description: "OpenRouter API key",
        tier: ssm.ParameterTier.STANDARD,
      }
    );

    // -------------------------------------------------------
    // VPC — public subnets only, no NAT gateway
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, "AgentVpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
    });

    // Security group for Fargate tasks — egress only
    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSG", {
      vpc,
      description: "Security group for GitHub agent Fargate tasks",
      allowAllOutbound: true,
    });

    // -------------------------------------------------------
    // ECR Repository
    // -------------------------------------------------------
    const repository = new ecr.Repository(this, "AgentRepo", {
      repositoryName: "github-agent",
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          maxImageCount: 5,
          description: "Keep only 5 images",
        },
      ],
    });

    // -------------------------------------------------------
    // ECS Cluster (Fargate only — no EC2 capacity)
    // -------------------------------------------------------
    const cluster = new ecs.Cluster(this, "AgentCluster", {
      vpc,
      clusterName: "github-agent",
    });

    // -------------------------------------------------------
    // Fargate Task Definition
    // -------------------------------------------------------
    const taskRole = new iam.Role(this, "TaskRole", {
      assumedBy: new iam.ServicePrincipal("ecs-tasks.amazonaws.com"),
      description: "Role for GitHub agent Fargate task",
    });

    // Task role needs SSM access to read secrets at runtime
    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          githubTokenParam.parameterArn,
          webhookSecretParam.parameterArn,
          openrouterKeyParam.parameterArn,
        ],
      })
    );

    const taskDefinition = new ecs.FargateTaskDefinition(this, "AgentTask", {
      memoryLimitMiB: 2048,
      cpu: 1024,
      taskRole,
    });

    const containerName = "agent";

    taskDefinition.addContainer(containerName, {
      image: ecs.ContainerImage.fromEcrRepository(repository, "latest"),
      logging: ecs.LogDrivers.awsLogs({
        streamPrefix: "github-agent",
        logRetention: logs.RetentionDays.TWO_WEEKS,
      }),
      // Environment variables are passed as overrides when the task is launched
    });

    // -------------------------------------------------------
    // Lambda — Webhook Handler
    // -------------------------------------------------------
    const webhookHandler = new NodejsFunction(this, "WebhookHandler", {
      entry: path.join(__dirname, "webhook-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
      bundling: {
        minify: true,
        sourceMap: true,
        target: "node20",
        // AWS SDK v3 clients used in handler need to be bundled
        externalModules: [],
      },
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        CONTAINER_NAME: containerName,
        SUBNETS: vpc.publicSubnets.map((s) => s.subnetId).join(","),
        SECURITY_GROUP: taskSecurityGroup.securityGroupId,
        WEBHOOK_SECRET_PARAM: webhookSecretParam.parameterName,
        GITHUB_TOKEN_PARAM: githubTokenParam.parameterName,
        OPENROUTER_API_KEY_PARAM: openrouterKeyParam.parameterName,
      },
    });

    // Lambda IAM: run ECS tasks
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDefinition.taskDefinitionArn],
      })
    );

    // Lambda needs to pass the task role and execution role to ECS
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          taskDefinition.taskRole.roleArn,
          taskDefinition.executionRole!.roleArn,
        ],
      })
    );

    // Lambda IAM: read SSM parameters
    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: [
          githubTokenParam.parameterArn,
          webhookSecretParam.parameterArn,
          openrouterKeyParam.parameterArn,
        ],
      })
    );

    // -------------------------------------------------------
    // API Gateway HTTP API
    // -------------------------------------------------------
    const httpApi = new apigwv2.HttpApi(this, "WebhookApi", {
      apiName: "github-agent-webhook",
      description: "Receives GitHub webhooks for the agent",
    });

    httpApi.addRoutes({
      path: "/webhook",
      methods: [apigwv2.HttpMethod.POST],
      integration: new apigwv2Integrations.HttpLambdaIntegration(
        "WebhookIntegration",
        webhookHandler
      ),
    });

    // -------------------------------------------------------
    // Outputs
    // -------------------------------------------------------
    new cdk.CfnOutput(this, "WebhookUrl", {
      value: `${httpApi.apiEndpoint}/webhook`,
      description: "URL to configure as GitHub webhook endpoint",
    });

    new cdk.CfnOutput(this, "EcrRepositoryUri", {
      value: repository.repositoryUri,
      description: "ECR repository URI for pushing agent images",
    });

    new cdk.CfnOutput(this, "ClusterName", {
      value: cluster.clusterName,
      description: "ECS cluster name",
    });
  }
}
