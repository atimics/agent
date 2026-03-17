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

async function getParameter(name: string): Promise<string> {
  const resp = await ssm.send(
    new GetParameterCommand({ Name: name, WithDecryption: true })
  );
  return resp.Parameter?.Value ?? "";
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

  // --- Filter: only labeled events with label "agent" ---
  if (payload.action !== "labeled") {
    console.log("Ignoring non-labeled action");
    return { statusCode: 200, body: "Ignored: not a labeled action" };
  }

  const labelName = payload.label?.name?.toLowerCase();
  if (labelName !== "agent") {
    console.log(`Ignoring label: ${payload.label?.name}`);
    return { statusCode: 200, body: "Ignored: not the agent label" };
  }

  let repoOwner: string;
  let repoName: string;
  let issueNumber: number;
  let isPR = false;

  if (ghEvent === "issues") {
    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.issue.number;
    isPR = false;
  } else if (ghEvent === "pull_request") {
    repoOwner = payload.repository.owner.login;
    repoName = payload.repository.name;
    issueNumber = payload.pull_request.number;
    isPR = true;
  } else {
    console.log(`Ignoring event type: ${ghEvent}`);
    return { statusCode: 200, body: `Ignored: event type ${ghEvent}` };
  }

  console.log(
    `Launching agent for ${repoOwner}/${repoName}#${issueNumber} (PR=${isPR})`
  );

  // --- Fetch secrets for Fargate env overrides ---
  const [githubToken, openrouterKey] = await Promise.all([
    getParameter(GITHUB_TOKEN_PARAM),
    getParameter(OPENROUTER_API_KEY_PARAM),
  ]);

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
          ],
        },
      ],
    },
  };

  const result = await ecs.send(new RunTaskCommand(params));
  const taskArn = result.tasks?.[0]?.taskArn ?? "unknown";
  console.log(`Started Fargate task: ${taskArn}`);

  return {
    statusCode: 200,
    body: JSON.stringify({ message: "Agent launched", taskArn }),
  };
}
