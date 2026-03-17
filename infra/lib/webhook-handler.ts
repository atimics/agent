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

const ecs = new ECSClient({});
const ssm = new SSMClient({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const CONTAINER_NAME = process.env.CONTAINER_NAME!;
const SUBNETS = process.env.SUBNETS!;
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const WEBHOOK_SECRET_PARAM = process.env.WEBHOOK_SECRET_PARAM!;
const GITHUB_TOKEN_PARAM = process.env.GITHUB_TOKEN_PARAM!;
const OPENROUTER_API_KEY_PARAM = process.env.OPENROUTER_API_KEY_PARAM!;
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

function formatLaunchFailure(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return "Unknown launch error";
}

function isResumeConfirmation(body: string): boolean {
  return /(^|\n)\s*\/agent\s+(continue|resume)\b/i.test(body);
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
  } else if (ghEvent === "issue_comment" && payload.action === "created") {
    const issueLabels =
      payload.issue?.labels?.map((label: { name?: string }) => label.name?.toLowerCase()) ?? [];
    const isWaiting = issueLabels.includes(SIGNAL_LABEL_WAITING);
    if (!isWaiting) {
      console.log("Ignoring issue comment because the issue is not waiting");
      return { statusCode: 200, body: "Ignored: issue not in waiting state" };
    }

    const commentBody = payload.comment?.body ?? "";
    if (!isResumeConfirmation(commentBody)) {
      console.log("Ignoring issue comment because it is not a resume confirmation");
      return { statusCode: 200, body: "Ignored: not a resume confirmation" };
    }

    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.issue.number;
    isPR = Boolean(payload.issue.pull_request);
  } else {
    console.log(`Ignoring event: ${ghEvent}/${payload.action}`);
    return { statusCode: 200, body: `Ignored: ${ghEvent}/${payload.action}` };
  }

  console.log(
    `Launching agent for ${repoOwner}/${repoName}#${issueNumber} (PR=${isPR})`
  );

  // --- Fetch secrets for Fargate env overrides ---
  const [githubToken, openrouterKey] = await Promise.all([
    getParameter(GITHUB_TOKEN_PARAM),
    getParameter(OPENROUTER_API_KEY_PARAM),
  ]);

  await ensureSignalLabels(repoOwner, repoName, githubToken);
  await setSignalLabel(
    repoOwner,
    repoName,
    issueNumber,
    githubToken,
    SIGNAL_LABEL_RUNNING
  );

  try {
    // --- Run Fargate task ---
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
            environment: [
              { name: "GITHUB_TOKEN", value: githubToken },
              { name: "OPENROUTER_API_KEY", value: openrouterKey },
              { name: "REPO_OWNER", value: repoOwner },
              { name: "REPO_NAME", value: repoName },
              { name: "ISSUE_NUMBER", value: String(issueNumber) },
              { name: "IS_PR", value: String(isPR) },
              { name: "ACTION", value: payload.action },
              { name: "TRIGGER_LABEL", value: TRIGGER_LABEL },
              { name: "SIGNAL_LABEL_RUNNING", value: SIGNAL_LABEL_RUNNING },
              { name: "SIGNAL_LABEL_WAITING", value: SIGNAL_LABEL_WAITING },
              { name: "SIGNAL_LABEL_FAILED", value: SIGNAL_LABEL_FAILED },
              { name: "SIGNAL_LABEL_SUCCEEDED", value: SIGNAL_LABEL_SUCCEEDED },
            ],
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

    return {
      statusCode: 200,
      body: JSON.stringify({ message: "Agent launched", taskArn }),
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
