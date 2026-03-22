import * as cdk from "aws-cdk-lib";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as ecr from "aws-cdk-lib/aws-ecr";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as apigwv2 from "aws-cdk-lib/aws-apigatewayv2";
import * as apigwv2Integrations from "aws-cdk-lib/aws-apigatewayv2-integrations";
import { NodejsFunction } from "aws-cdk-lib/aws-lambda-nodejs";
import * as lambda from "aws-cdk-lib/aws-lambda";
import * as events from "aws-cdk-lib/aws-events";
import * as targets from "aws-cdk-lib/aws-events-targets";
import { Construct } from "constructs";
import * as path from "path";

// SSM parameter names — created out-of-band (already exist)
const PARAM_GITHUB_APP_ID = "/github-agent/GITHUB_APP_ID";
const PARAM_GITHUB_APP_PRIVATE_KEY = "/github-agent/GITHUB_APP_PRIVATE_KEY";
const PARAM_WEBHOOK_SECRET = "/github-agent/GITHUB_WEBHOOK_SECRET";
const PARAM_OPENROUTER_KEY = "/github-agent/OPENROUTER_API_KEY";

export class GitHubAgentStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const ssmParamArns = [
      PARAM_GITHUB_APP_ID,
      PARAM_GITHUB_APP_PRIVATE_KEY,
      PARAM_WEBHOOK_SECRET,
      PARAM_OPENROUTER_KEY,
    ].map(
      (name) =>
        `arn:aws:ssm:${this.region}:${this.account}:parameter${name}`
    );

    // -------------------------------------------------------
    // VPC — private subnets with NAT gateway for isolation
    // -------------------------------------------------------
    const vpc = new ec2.Vpc(this, "AgentVpc", {
      maxAzs: 2,
      natGateways: 1, // Single NAT gateway for cost efficiency
      subnetConfiguration: [
        {
          name: "Public",
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    const taskSecurityGroup = new ec2.SecurityGroup(this, "TaskSG", {
      vpc,
      description: "Security group for GitHub agent Fargate tasks",
      allowAllOutbound: false,
    });

    // Explicit outbound rules for HTTPS, HTTP, and DNS
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      "HTTPS outbound for GitHub API, model inference, and AWS APIs"
    );
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      "HTTP outbound for package installations and redirects"
    );
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.udp(53),
      "DNS resolution"
    );
    taskSecurityGroup.addEgressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(53),
      "DNS over TCP"
    );

    // -------------------------------------------------------
    // VPC Endpoints for AWS services
    // -------------------------------------------------------
    // S3 Gateway Endpoint (no charge, better performance)
    vpc.addGatewayEndpoint("S3GatewayEndpoint", {
      service: ec2.GatewayVpcEndpointAwsService.S3,
      subnets: [
        { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      ],
    });

    // Interface endpoints for ECS/ECR services
    vpc.addInterfaceEndpoint("EcrApiEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSecurityGroup],
    });

    vpc.addInterfaceEndpoint("EcrDockerEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSecurityGroup],
    });

    vpc.addInterfaceEndpoint("CloudWatchLogsEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSecurityGroup],
    });

    vpc.addInterfaceEndpoint("SsmEndpoint", {
      service: ec2.InterfaceVpcEndpointAwsService.SSM,
      subnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [taskSecurityGroup],
    });

    // -------------------------------------------------------
    // S3 Bucket for Task Artifacts
    // -------------------------------------------------------
    const artifactsBucket = new s3.Bucket(this, "TaskArtifactsBucket", {
      bucketName: `github-agent-artifacts-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      publicReadAccess: false,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          id: "cleanup-old-artifacts",
          enabled: true,
          expiration: cdk.Duration.days(30), // Clean up artifacts after 30 days
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
        },
      ],
      versioned: false,
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
    // ECS Cluster
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

    taskRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for artifacts
    artifactsBucket.grantReadWrite(taskRole);

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
        externalModules: [],
      },
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        CONTAINER_NAME: containerName,
        SUBNETS: vpc.privateSubnets.map((s) => s.subnetId).join(","),
        SECURITY_GROUP: taskSecurityGroup.securityGroupId,
        WEBHOOK_SECRET_PARAM: PARAM_WEBHOOK_SECRET,
        GITHUB_APP_ID_PARAM: PARAM_GITHUB_APP_ID,
        GITHUB_APP_PRIVATE_KEY_PARAM: PARAM_GITHUB_APP_PRIVATE_KEY,
        OPENROUTER_API_KEY_PARAM: PARAM_OPENROUTER_KEY,
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
      },
    });

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ecs:RunTask"],
        resources: [taskDefinition.taskDefinitionArn],
      })
    );

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["iam:PassRole"],
        resources: [
          taskDefinition.taskRole.roleArn,
          taskDefinition.executionRole!.roleArn,
        ],
      })
    );

    webhookHandler.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ["ssm:GetParameter"],
        resources: ssmParamArns,
      })
    );

    // Grant S3 permissions for task metadata
    artifactsBucket.grantReadWrite(webhookHandler);

    // -------------------------------------------------------
    // Cleanup/Reaper Lambda
    // -------------------------------------------------------
    const cleanupFunction = new NodejsFunction(this, "CleanupFunction", {
      entry: path.join(__dirname, "cleanup-handler.ts"),
      handler: "handler",
      runtime: lambda.Runtime.NODEJS_20_X,
      architecture: lambda.Architecture.ARM_64,
      timeout: cdk.Duration.minutes(5),
      memorySize: 512,
      environment: {
        CLUSTER_ARN: cluster.clusterArn,
        TASK_DEFINITION_ARN: taskDefinition.taskDefinitionArn,
        ARTIFACTS_BUCKET: artifactsBucket.bucketName,
      },
    });

    // Grant permissions to the cleanup function
    cleanupFunction.addToRolePolicy(
      new iam.PolicyStatement({
        actions: [
          "ecs:DescribeTasks",
          "ecs:StopTask",
          "ecs:ListTasks"
        ],
        resources: ["*"], // ECS tasks don't have predictable ARNs
      })
    );

    artifactsBucket.grantReadWrite(cleanupFunction);

    // -------------------------------------------------------
    // EventBridge rule to trigger cleanup
    // -------------------------------------------------------
    const cleanupRule = new events.Rule(this, "CleanupRule", {
      description: "Trigger cleanup of stale agent tasks",
      schedule: events.Schedule.cron({
        minute: "0",
        hour: "*/2", // Every 2 hours
        day: "*",
        month: "*",
        year: "*",
      }),
    });

    cleanupRule.addTarget(new targets.LambdaFunction(cleanupFunction));

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

    new cdk.CfnOutput(this, "ArtifactsBucket", {
      value: artifactsBucket.bucketName,
      description: "S3 bucket for task artifacts and metadata",
    });
  }
}
