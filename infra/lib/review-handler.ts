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
  ReviewPayload,
  PRMetadata,
  generateTaskId,
  createRepoSlug,
  getInstallationToken,
  createArtifactPrefix,
  type ReviewEnvironment,
  type GitHubAppConfig,
} from "./types";

const ecs = new ECSClient({});
const ssm = new SSMClient({});
const s3 = new S3Client({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const REVIEW_TASK_DEFINITION_ARN = process.env.REVIEW_TASK_DEFINITION_ARN!;
const REVIEW_CONTAINER_NAME = process.env.REVIEW_CONTAINER_NAME!;
const SUBNETS = process.env.SUBNETS!;
const SECURITY_GROUP = process.env.SECURITY_GROUP!;
const GITHUB_APP_ID_PARAM = process.env.GITHUB_APP_ID_PARAM!;
const GITHUB_APP_PRIVATE_KEY_PARAM = process.env.GITHUB_APP_PRIVATE_KEY_PARAM!;
const ANTHROPIC_API_KEY_PARAM = process.env.ANTHROPIC_API_KEY_PARAM!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

// Bot username for filtering PRs created by the coding agent
const CODING_AGENT_BOT_LOGIN = "cenetex-coding-agent[bot]";

// Protected file patterns that should never be auto-merged
const PROTECTED_PATHS = [
  ".github/workflows/",
  "infra/lib/stack.ts",
  "Dockerfile",
  "infra/",
  ".env",
  "credentials",
  "secrets",
  "*.key",
  "*.pem",
];

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
      "User-Agent": "github-agent-review",
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

/**
 * Discovers open PRs created by the coding agent that need review
 */
async function discoverReviewablePRs(token: string): Promise<any[]> {
  console.log("Discovering reviewable PRs...");

  // Get all open PRs across all repositories where the app is installed
  // For now, focusing on the current repository pattern
  // In full implementation, this would iterate over all installations

  // This is a simplified implementation - in reality we'd need to:
  // 1. List all app installations
  // 2. For each installation, list open PRs
  // 3. Filter by author (coding agent bot)

  // For this PR, we'll focus on a single repo pattern
  const testRepos = [
    "cenetex/agent" // This repository for testing
  ];

  const reviewablePRs: any[] = [];

  for (const repo of testRepos) {
    try {
      console.log(`Checking repository: ${repo}`);

      const response = await githubRequest(
        `/repos/${repo}/pulls?state=open&per_page=100`,
        token,
        { method: "GET" },
        [200]
      );

      const prs = await response.json() as any[];

      // Filter PRs created by the coding agent that don't have review labels yet
      const needsReview = prs.filter((pr: any) => {
        const isFromBot = pr.user.login === CODING_AGENT_BOT_LOGIN ||
                         pr.user.login.includes("github-agent") ||
                         pr.user.login.includes("coding-agent");

        const hasReviewLabel = pr.labels.some((label: any) =>
          label.name.startsWith("review:")
        );

        const hasPauseLabel = pr.labels.some((label: any) =>
          label.name === "pause-agent"
        );

        return isFromBot && !hasReviewLabel && !hasPauseLabel;
      });

      reviewablePRs.push(...needsReview.map(pr => ({ ...pr, repo })));
    } catch (error) {
      console.error(`Error checking repository ${repo}:`, error);
      // Continue with other repos
    }
  }

  console.log(`Found ${reviewablePRs.length} PRs needing review`);
  return reviewablePRs;
}

/**
 * Checks if a PR touches protected paths
 */
async function checkProtectedPaths(
  repo: string,
  prNumber: number,
  token: string
): Promise<{ hasProtectedFiles: boolean; protectedFiles: string[] }> {
  try {
    const response = await githubRequest(
      `/repos/${repo}/pulls/${prNumber}/files`,
      token,
      { method: "GET" },
      [200]
    );

    const files = await response.json() as any[];
    const protectedFiles: string[] = [];

    for (const file of files) {
      const filename = file.filename;

      for (const pattern of PROTECTED_PATHS) {
        if (pattern.includes("/") && filename.includes(pattern)) {
          protectedFiles.push(filename);
          break;
        } else if (pattern.includes("*")) {
          const regex = new RegExp(pattern.replace("*", ".*"));
          if (regex.test(filename)) {
            protectedFiles.push(filename);
            break;
          }
        } else if (filename.includes(pattern)) {
          protectedFiles.push(filename);
          break;
        }
      }
    }

    return {
      hasProtectedFiles: protectedFiles.length > 0,
      protectedFiles
    };
  } catch (error) {
    console.error(`Error checking files for PR ${prNumber}:`, error);
    return { hasProtectedFiles: true, protectedFiles: ["Error checking files"] };
  }
}

/**
 * Starts a review task for a PR
 */
async function startReviewTask(
  pr: any,
  githubToken: string,
  anthropicApiKey: string
): Promise<string> {
  const taskId = generateTaskId();
  const repoSlug = pr.repo;

  const prMetadata: PRMetadata = {
    number: pr.number,
    title: pr.title,
    body: pr.body || "",
    labels: pr.labels.map((label: any) => label.name),
    author: pr.user.login,
    head_ref: pr.head.ref,
    base_ref: pr.base.ref,
    created_by_bot: true,
  };

  const reviewPayload: ReviewPayload = {
    task_id: taskId,
    repo_slug: repoSlug,
    pr_number: pr.number,
    head_sha: pr.head.sha,
    base_sha: pr.base.sha,
    pr_metadata: prMetadata,
    created_at: new Date().toISOString(),
  };

  const artifactPrefix = createArtifactPrefix(repoSlug, taskId);

  const reviewCriteria = {
    check_compilation: true,
    check_security: true,
    check_issue_alignment: true,
    check_logic: true,
    check_complexity: true,
    check_cost_impact: true,
    protected_paths: PROTECTED_PATHS,
  };

  const reviewEnvironment: ReviewEnvironment = {
    REVIEW_PAYLOAD: JSON.stringify(reviewPayload),
    GITHUB_TOKEN: githubToken,
    ANTHROPIC_API_KEY: anthropicApiKey,
    ARTIFACTS_BUCKET,
    ARTIFACT_PREFIX: artifactPrefix,
    REPO: repoSlug,
    PR_NUMBER: pr.number.toString(),
    REVIEW_CRITERIA: JSON.stringify(reviewCriteria),
  };

  const params: RunTaskCommandInput = {
    cluster: CLUSTER_ARN,
    taskDefinition: REVIEW_TASK_DEFINITION_ARN,
    launchType: "FARGATE",
    count: 1,
    networkConfiguration: {
      awsvpcConfiguration: {
        subnets: SUBNETS.split(","),
        securityGroups: [SECURITY_GROUP],
        assignPublicIp: "DISABLED",
      },
    },
    overrides: {
      containerOverrides: [
        {
          name: REVIEW_CONTAINER_NAME,
          environment: Object.entries(reviewEnvironment).map(([name, value]) => ({
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
        ? `Review task launch failed: ${failureDetails.join(", ")}`
        : "Review task launch did not return a task ARN"
    );
  }

  // Store initial review metadata
  const metadata = {
    task_id: taskId,
    pr_number: pr.number,
    repo_slug: repoSlug,
    status: "running",
    task_arn: taskArn,
    created_at: reviewPayload.created_at,
    started_at: new Date().toISOString(),
  };

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: `${artifactPrefix}/review-metadata.json`,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: "application/json",
  }));

  console.log(`Started review task ${taskId} for PR ${pr.number} (${taskArn})`);
  return taskArn;
}

/**
 * Main handler function triggered by EventBridge
 */
export async function handler() {
  console.log("Review handler triggered");

  try {
    // Get credentials
    const [appId, privateKey, anthropicApiKey] = await Promise.all([
      getParameter(GITHUB_APP_ID_PARAM),
      getParameter(GITHUB_APP_PRIVATE_KEY_PARAM),
      getParameter(ANTHROPIC_API_KEY_PARAM),
    ]);

    const appConfig: GitHubAppConfig = {
      appId,
      privateKey,
    };

    // For simplicity, we'll get a token for a known repo
    // In full implementation, this would iterate over all installations
    const githubToken = await getInstallationToken("cenetex", "agent", appConfig);

    // Discover reviewable PRs
    const reviewablePRs = await discoverReviewablePRs(githubToken);

    if (reviewablePRs.length === 0) {
      console.log("No PRs need review at this time");
      return { statusCode: 200, body: "No PRs to review" };
    }

    // Process each PR
    const results = [];
    for (const pr of reviewablePRs) {
      try {
        // Check if PR touches protected paths
        const { hasProtectedFiles, protectedFiles } = await checkProtectedPaths(
          pr.repo,
          pr.number,
          githubToken
        );

        if (hasProtectedFiles) {
          console.log(`PR ${pr.number} touches protected files: ${protectedFiles.join(", ")}`);

          // Add a comment and label for human review
          await githubRequest(
            `/repos/${pr.repo}/issues/${pr.number}/comments`,
            githubToken,
            {
              method: "POST",
              body: JSON.stringify({
                body: `🛡️ **Protected files detected**

This PR modifies files that require human review:
${protectedFiles.map(f => `- \`${f}\``).join("\n")}

This PR will not be auto-merged and needs manual review.`
              }),
            },
            [201]
          );

          await githubRequest(
            `/repos/${pr.repo}/issues/${pr.number}/labels`,
            githubToken,
            {
              method: "POST",
              body: JSON.stringify({ labels: ["review:human-required"] }),
            },
            [200]
          );

          results.push({
            pr: pr.number,
            status: "protected-files",
            protectedFiles
          });
          continue;
        }

        // Start review task
        const taskArn = await startReviewTask(pr, githubToken, anthropicApiKey);

        results.push({
          pr: pr.number,
          status: "review-started",
          taskArn
        });

      } catch (error) {
        console.error(`Failed to process PR ${pr.number}:`, error);
        results.push({
          pr: pr.number,
          status: "error",
          error: error instanceof Error ? error.message : "Unknown error"
        });
      }
    }

    return {
      statusCode: 200,
      body: JSON.stringify({
        message: "Review handler completed",
        processed: results.length,
        results
      }),
    };

  } catch (error) {
    console.error("Review handler failed:", error);
    return {
      statusCode: 500,
      body: JSON.stringify({
        error: error instanceof Error ? error.message : "Unknown error"
      }),
    };
  }
}