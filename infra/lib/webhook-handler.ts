import { createHmac } from "crypto";
import {
  ECSClient,
  RunTaskCommand,
  type RunTaskCommandInput,
} from "@aws-sdk/client-ecs";
import {
  SSMClient,
  GetParameterCommand,
} from "@aws-sdk/client-ssm";
import {
  S3Client,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import {
  TaskPayload,
  IssueMetadata,
  generateTaskId,
  createRepoSlug,
  getInstallationToken,
  createInitialTaskMetadata,
  createArtifactKeys,
  type TaskEnvironment,
  type GitHubAppConfig,
  type TaskMetadata,
} from "./types";

const ecs = new ECSClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const CONTAINER_NAME = process.env.CONTAINER_NAME!;
const SUBNETS = process.env.SUBNETS!;
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const OPENROUTER_API_KEY_PARAM = process.env.OPENROUTER_API_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;
const TRIGGER_LABEL = "agent";
const SIGNAL_LABEL_RUNNING = "agent:running";
const SIGNAL_LABEL_WAITING = "agent:waiting";
const SIGNAL_LABEL_FAILED = "agent:failed";
const SIGNAL_LABEL_SUCCEEDED = "agent:succeeded";
const SIGNAL_LABELS = [
  {
    name: SIGNAL_LABEL_RUNNING,
    color: "1D76DB",
    description: "Autonomous run is currently in progress",
  },
  {
    name: SIGNAL_LABEL_WAITING,
    color: "FBCA04",
    description: "Autonomous run is waiting for confirmation or clarification",
  },
  {
    name: SIGNAL_LABEL_FAILED,
    color: "D73A4A",
    description: "Autonomous run failed before finishing",
  },
  {
    name: SIGNAL_LABEL_SUCCEEDED,
    color: "0E8A16",
    description: "Autonomous run finished successfully",
  },
] as const;

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
}

async function githubRequest(
  path: string,
  token: string,
  init: RequestInit,
  expectedStatuses: number[]
): Promise<Response> {
  const response = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${token}`,
      "User-Agent": "github-agent-control-plane",
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });

  if (!expectedStatuses.includes(response.status)) {
    const responseBody = await response.text();
    throw new Error(
      `GitHub API ${init.method ?? "GET"} ${path} failed with ${response.status}: ${responseBody}`
    );
  }

  return response;
}

async function ensureSignalLabels(
  repoOwner: string,
  repoName: string,
  token: string
): Promise<void> {
  for (const label of SIGNAL_LABELS) {
    await githubRequest(
      `/repos/${repoOwner}/${repoName}/labels`,
      token,
      {
        method: "POST",
        body: JSON.stringify(label),
      },
      [201, 422]
    );
  }
}

async function deleteLabelIfPresent(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels/${encodeURIComponent(label)}`,
    token,
    { method: "DELETE" },
    [200, 204, 404]
  );
}

async function setSignalLabel(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  label: string
): Promise<void> {
  const labelsToRemove = [TRIGGER_LABEL, ...SIGNAL_LABELS.map((entry) => entry.name)]
    .filter((candidate) => candidate !== label);

  for (const candidate of labelsToRemove) {
    await deleteLabelIfPresent(repoOwner, repoName, issueNumber, token, candidate);
  }

  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/labels`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ labels: [label] }),
    },
    [200]
  );
}

async function addIssueComment(
  repoOwner: string,
  repoName: string,
  issueNumber: number,
  token: string,
  body: string
): Promise<void> {
  await githubRequest(
    `/repos/${repoOwner}/${repoName}/issues/${issueNumber}/comments`,
    token,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    },
    [201]
  );
}

async function storeTaskMetadata(
  taskMetadata: TaskMetadata
): Promise<void> {
  const artifactKeys = createArtifactKeys(taskMetadata.artifact_prefix);

  try {
    await s3.send(new PutObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: artifactKeys.metadata,
      Body: JSON.stringify(taskMetadata, null, 2),
      ContentType: "application/json",
      Metadata: {
        taskId: taskMetadata.task_id,
        repoSlug: taskMetadata.repo_slug,
        issueNumber: taskMetadata.issue_number.toString(),
        status: taskMetadata.status,
      },
    }));

    console.log(`Stored task metadata at ${artifactKeys.metadata}`);
  } catch (error) {
    console.error(`Failed to store task metadata:`, error);
    throw error;
  }
}

function formatLaunchFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown launch error";
}

function verifySignature(
  payload: string,
  signature: string,
  secret: string
): boolean {
  const hmac = createHmac("sha256", secret);
  hmac.update(payload, "utf8");
  const expected = "sha256=" + hmac.digest("hex");
  if (signature.length !== expected.length) return false;
  // Constant-time comparison
  let mismatch = 0;
  for (let i = 0; i < expected.length; i++) {
    mismatch |= signature.charCodeAt(i) ^ expected.charCodeAt(i);
  }
  return mismatch === 0;
}

/**
 * Resolves a reference (branch, tag, or pull request) to an immutable commit SHA
 */
async function resolveCommitSha(
  repoOwner: string,
  repoName: string,
  ref: string,
  isPR: boolean,
  issueNumber: number,
  token: string
): Promise<string> {
  try {
    if (isPR) {
      // For PRs, get the head commit SHA
      const response = await githubRequest(
        `/repos/${repoOwner}/${repoName}/pulls/${issueNumber}`,
        token,
        { method: "GET" },
        [200]
      );
      const prData = await response.json() as any;
      return prData.head.sha;
    } else {
      // For issues, resolve the default branch HEAD
      // First get the default branch
      const repoResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}`,
        token,
        { method: "GET" },
        [200]
      );
      const repoData = await repoResponse.json() as any;
      const defaultBranch = repoData.default_branch;

      // Then get the HEAD commit SHA of the default branch
      const branchResponse = await githubRequest(
        `/repos/${repoOwner}/${repoName}/branches/${defaultBranch}`,
        token,
        { method: "GET" },
        [200]
      );
      const branchData = await branchResponse.json() as any;
      return branchData.commit.sha;
    }
  } catch (error) {
    console.error(`Failed to resolve commit SHA for ${ref}:`, error);
    throw new Error(`Failed to resolve commit SHA for ${ref}: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }
}

export async function handler(event: {
  headers: Record<string, string | undefined>;
  body?: string;
  isBase64Encoded?: boolean;
}) {
  console.log("Received webhook event");

  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body ?? "", "base64").toString("utf8")
    : event.body ?? "";

  // --- Validate signature ---
  const signature =
    event.headers["x-hub-signature-256"] ??
    event.headers["X-Hub-Signature-256"] ??
    "";
  if (!signature) {
    console.error("Missing signature header");
    return { statusCode: 401, body: "Missing signature" };
  }

  const webhookSecret = await getParameter(WEBHOOK_SECRET_PARAM);
  if (!verifySignature(rawBody, signature, webhookSecret)) {
    console.error("Invalid signature");
    return { statusCode: 401, body: "Invalid signature" };
  }

  // --- Parse payload ---
  const payload = JSON.parse(rawBody);
  const ghEvent =
    event.headers["x-github-event"] ??
    event.headers["X-GitHub-Event"] ??
    "";

  console.log(`GitHub event: ${ghEvent}, action: ${payload.action}`);

  let repoOwner: string;
  let repoName: string;
  let issueNumber: number;
  let isPR = false;
  let requestedRef: string;
  let issueData: any;
  let prData: any;

  if (ghEvent === "issues" && payload.action === "labeled") {
    const labelName = payload.label?.name?.toLowerCase();
    if (labelName !== TRIGGER_LABEL) {
      console.log(`Ignoring label: ${payload.label?.name}`);
      return { statusCode: 200, body: "Ignored: not the agent label" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.issue.number;
    isPR = false;
    requestedRef = payload.repository.default_branch || "main";
    issueData = payload.issue;
  } else if (ghEvent === "pull_request" && payload.action === "labeled") {
    const labelName = payload.label?.name?.toLowerCase();
    if (labelName !== TRIGGER_LABEL) {
      console.log(`Ignoring label: ${payload.label?.name}`);
      return { statusCode: 200, body: "Ignored: not the agent label" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.pull_request.number;
    isPR = true;
    requestedRef = payload.pull_request.head.ref;
    prData = payload.pull_request;
  } else {
    console.log(`Ignoring event: ${ghEvent}/${payload.action}`);
    return { statusCode: 200, body: `Ignored: ${ghEvent}/${payload.action}` };
  }

  console.log(
    `Launching agent for ${repoOwner}/${repoName}#${issueNumber} (PR=${isPR})`
  );

  // --- Fetch GitHub App credentials and mint installation token ---
  const [appId, privateKey, openrouterKey] = await Promise.all([
    getParameter(GITHUB_APP_ID_PARAM),
    getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
    getParameter(OPENROUTER_API_KEY_PARAM),
  ]);

  const appConfig: GitHubAppConfig = {
    appId,
    privateKey,
  };

  let githubToken: string;
  try {
    githubToken = await getInstallationToken(repoOwner, repoName, appConfig);
  } catch (error) {
    console.error(`Failed to get installation token for ${repoOwner}/${repoName}:`, error);
    throw new Error(`Failed to mint GitHub App installation token: ${error instanceof Error ? error.message : 'Unknown error'}`);
  }

  await ensureSignalLabels(repoOwner, repoName, githubToken);
  await setSignalLabel(
    repoOwner,
    repoName,
    issueNumber,
    githubToken,
    SIGNAL_LABEL_RUNNING
  );

  // --- Resolve commit SHA ---
  console.log(`Resolving commit SHA for ref: ${requestedRef}`);
  const resolvedCommitSha = await resolveCommitSha(
    repoOwner,
    repoName,
    requestedRef,
    isPR,
    issueNumber,
    githubToken
  );
  console.log(`Resolved ${requestedRef} to commit SHA: ${resolvedCommitSha}`);

  // --- Create task payload ---
  const taskId = generateTaskId();
  const repoSlug = createRepoSlug(repoOwner, repoName);

  // Extract label names from the webhook payload
  const labels = isPR
    ? (prData.labels || []).map((label: any) => label.name)
    : (issueData.labels || []).map((label: any) => label.name);

  const issueMetadata: IssueMetadata = {
    number: issueNumber,
    title: isPR ? prData.title : issueData.title,
    body: isPR ? prData.body : issueData.body,
    labels,
    head_ref: isPR ? prData.head.ref : undefined,
    base_ref: isPR ? prData.base.ref : undefined,
    author: isPR ? prData.user.login : issueData.user.login,
  };

  const taskPayload: TaskPayload = {
    task_id: taskId,
    repo_slug: repoSlug,
    requested_ref: requestedRef,
    resolved_commit_sha: resolvedCommitSha,
    issue_metadata: issueMetadata,
    task_mode: isPR ? "pull_request" : "issue",
    created_at: new Date().toISOString(),
  };

  console.log(`Created task ${taskId} with resolved SHA ${resolvedCommitSha}`);
  console.log(`Task payload:`, JSON.stringify(taskPayload, null, 2));

  try {
    // --- Run Fargate task ---
    const taskMetadata = createInitialTaskMetadata(taskPayload);
    const taskEnvironment: TaskEnvironment = {
      TASK_PAYLOAD: JSON.stringify(taskPayload),
      GITHUB_TOKEN: githubToken,
      OPENROUTER_API_KEY: openrouterKey,
      ARTIFACTS_BUCKET,
      ARTIFACT_PREFIX: taskMetadata.artifact_prefix,
      TRIGGER_LABEL,
      SIGNAL_LABEL_RUNNING,
      SIGNAL_LABEL_WAITING,
      SIGNAL_LABEL_FAILED,
      SIGNAL_LABEL_SUCCEEDED,
    };

    const params: RunTaskCommandInput = {
      cluster: CLUSTER_ARN,
      taskDefinition: TASK_DEFINITION_ARN,
      launchType: "FARGATE",
      count: 1,
      networkConfiguration: {
        awsvpcConfiguration: {
          subnets: SUBNETS.split(","),
          securityGroups: [SECURITY_GROUP],
          assignPublicIp: "ENABLED",
        },
      },
      overrides: {
        containerOverrides: [
          {
            name: CONTAINER_NAME,
            environment: Object.entries(taskEnvironment).map(([name, value]) => ({
              name,
              value,
            })),
          },
        ],
      },
    };

    const result = await ecs.send(new RunTaskCommand(params));
    const taskArn = result.tasks?.[0]?.taskArn;

    if (!taskArn || (result.failures?.length ?? 0) > 0) {
      const failureDetails =
        result.failures?.map((failure) => failure.reason ?? failure.arn ?? "unknown failure") ??
        [];
      throw new Error(
        failureDetails.length > 0
          ? `ECS task launch failed: ${failureDetails.join(", ")}`
          : "ECS task launch did not return a task ARN"
      );
    }

    console.log(`Started Fargate task: ${taskArn}`);
    console.log(`Task metadata - ID: ${taskId}, SHA: ${resolvedCommitSha}, Repo: ${repoSlug}`);

    // --- Store initial task metadata with ARN ---
    taskMetadata.task_arn = taskArn;
    taskMetadata.started_at = new Date().toISOString();
    taskMetadata.status = "running";
    await storeTaskMetadata(taskMetadata);

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Agent launched",
        taskArn,
        taskId,
        resolvedCommitSha,
        repoSlug
      }),
    };
  } catch (error) {
    const failureMessage = formatLaunchFailure(error);
    console.error(`Failed to launch agent task: ${failureMessage}`);

    try {
      await setSignalLabel(
        repoOwner,
        repoName,
        issueNumber,
        githubToken,
        SIGNAL_LABEL_FAILED
      );
      await addIssueComment(
        repoOwner,
        repoName,
        issueNumber,
        githubToken,
        [
          "Agent failed before the runtime started.",
          "",
          `Launch error: ${failureMessage}`,
        ].join("\n")
      );
    } catch (reportingError) {
      console.error("Failed to report launch failure to GitHub", reportingError);
    }

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Agent launch failed" }),
    };
  }
}
