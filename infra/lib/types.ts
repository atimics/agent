/**
 * Types for the immutable task contract system
 */
import { createSign } from "crypto";

export interface GitHubAppConfig {
  /** GitHub App ID */
  appId: string;
  /** GitHub App private key (PEM format) */
  privateKey: string;
}

export interface InstallationTokenResponse {
  /** The installation token */
  token: string;
  /** Token expiration time */
  expires_at: string;
}

/**
 * Creates a JWT for GitHub App authentication
 */
export function createGitHubAppJWT(appId: string, privateKey: string): string {
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    iat: now - 60, // Issues 1 minute in the past
    exp: now + 600, // Expires in 10 minutes
    iss: appId,
  };

  const header = {
    alg: "RS256",
    typ: "JWT",
  };

  const encodedHeader = Buffer.from(JSON.stringify(header)).toString("base64url");
  const encodedPayload = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signatureInput = `${encodedHeader}.${encodedPayload}`;

  const sign = createSign("RSA-SHA256");
  sign.update(signatureInput);
  const signature = sign.sign(privateKey).toString("base64url");

  return `${signatureInput}.${signature}`;
}

/**
 * Gets the installation ID for a repository using GitHub App JWT
 */
export async function getInstallationId(
  repoOwner: string,
  repoName: string,
  appJWT: string
): Promise<number> {
  const response = await fetch(
    `https://api.github.com/repos/${repoOwner}/${repoName}/installation`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJWT}`,
        "User-Agent": "github-agent-control-plane",
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to get installation ID for ${repoOwner}/${repoName}: ${response.status} ${errorBody}`
    );
  }

  const installation = await response.json() as any;
  return installation.id;
}

/**
 * Mints an installation token for a GitHub App installation
 */
export async function createInstallationToken(
  installationId: number,
  appJWT: string
): Promise<InstallationTokenResponse> {
  const response = await fetch(
    `https://api.github.com/app/installations/${installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${appJWT}`,
        "User-Agent": "github-agent-control-plane",
      },
    }
  );

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(
      `Failed to create installation token for installation ${installationId}: ${response.status} ${errorBody}`
    );
  }

  return await response.json() as InstallationTokenResponse;
}

/**
 * Gets a GitHub App installation token for a repository
 */
export async function getInstallationToken(
  repoOwner: string,
  repoName: string,
  appConfig: GitHubAppConfig
): Promise<string> {
  const jwt = createGitHubAppJWT(appConfig.appId, appConfig.privateKey);
  const installationId = await getInstallationId(repoOwner, repoName, jwt);
  const tokenResponse = await createInstallationToken(installationId, jwt);
  return tokenResponse.token;
}

export interface TaskPayload {
  /** Unique identifier for this task execution */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** The original reference that was requested (branch, tag, PR) */
  requested_ref: string;
  /** The immutable commit SHA that was resolved from requested_ref */
  resolved_commit_sha: string;
  /** Issue or PR metadata */
  issue_metadata: IssueMetadata;
  /** Task execution mode */
  task_mode: "issue" | "pull_request";
  /** Timestamp when task was created */
  created_at: string;
}

export interface IssueMetadata {
  /** Issue or PR number */
  number: number;
  /** Issue or PR title */
  title: string;
  /** Issue or PR body */
  body: string;
  /** Array of label names */
  labels: string[];
  /** For PRs: the head branch name */
  head_ref?: string;
  /** For PRs: the base branch name */
  base_ref?: string;
  /** Author of the issue/PR */
  author: string;
}

/**
 * Task lifecycle states
 */
export type TaskLifecycleState =
  | "requested"     // Task has been created and queued
  | "running"       // Task is currently executing
  | "succeeded"     // Task completed successfully
  | "failed"        // Task failed during execution
  | "timed_out"     // Task exceeded time limit
  | "waiting";      // Task is waiting for user input

/**
 * Task metadata record for persistence
 */
export interface TaskMetadata {
  /** Unique task identifier */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** Issue or PR number */
  issue_number: number;
  /** Task execution mode */
  task_mode: "issue" | "pull_request";
  /** Current lifecycle state */
  status: TaskLifecycleState;
  /** The original reference that was requested */
  requested_ref: string;
  /** The immutable commit SHA that was resolved */
  resolved_commit_sha: string;
  /** Fargate task ARN */
  task_arn?: string;
  /** S3 artifact prefix for this task */
  artifact_prefix: string;
  /** Task creation timestamp */
  created_at: string;
  /** Task start timestamp */
  started_at?: string;
  /** Task completion timestamp */
  completed_at?: string;
  /** Error message if failed */
  error_message?: string;
  /** Created PR URL if applicable */
  pr_url?: string;
  /** Issue/PR metadata at task creation time */
  issue_metadata: IssueMetadata;
}

/**
 * Artifact manifest for a task execution
 */
export interface TaskArtifacts {
  /** Unique task identifier */
  task_id: string;
  /** Task metadata file location */
  metadata_key: string;
  /** Agent log file location */
  log_key?: string;
  /** Summary file location */
  summary_key?: string;
  /** Exit code from task execution */
  exit_code?: number;
  /** Size of artifacts in bytes */
  total_size_bytes?: number;
  /** Artifact creation timestamp */
  created_at: string;
}

export interface TaskResult {
  /** Unique task identifier */
  task_id: string;
  /** Task completion status */
  status: "succeeded" | "failed" | "waiting";
  /** Commit SHA that was checked out */
  resolved_commit_sha: string;
  /** Error message if failed */
  error?: string;
  /** Created PR URL if applicable */
  pr_url?: string;
  /** Task execution timestamps */
  timestamps: {
    started_at: string;
    completed_at: string;
  };
}

export interface TaskEnvironment {
  /** The complete task payload as JSON string */
  TASK_PAYLOAD: string;
  /** GitHub installation token for API access */
  GITHUB_TOKEN: string;
  /** OpenRouter API key */
  OPENROUTER_API_KEY: string;
  /** S3 bucket for artifacts */
  ARTIFACTS_BUCKET: string;
  /** S3 prefix for this task's artifacts */
  ARTIFACT_PREFIX: string;
  /** Signal labels for status tracking */
  TRIGGER_LABEL: string;
  SIGNAL_LABEL_RUNNING: string;
  SIGNAL_LABEL_WAITING: string;
  SIGNAL_LABEL_FAILED: string;
  SIGNAL_LABEL_SUCCEEDED: string;
}

/**
 * Generates a unique task ID using timestamp and random string
 */
export function generateTaskId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).substring(2, 8);
  return `task_${timestamp}_${random}`;
}

/**
 * Parses a repository slug into owner and name components
 */
export function parseRepoSlug(repoSlug: string): { owner: string; name: string } {
  const [owner, name] = repoSlug.split('/');
  if (!owner || !name) {
    throw new Error(`Invalid repository slug: ${repoSlug}`);
  }
  return { owner, name };
}

/**
 * Creates a repository slug from owner and name
 */
export function createRepoSlug(owner: string, name: string): string {
  return `${owner}/${name}`;
}

/**
 * Creates a predictable artifact prefix for a task
 */
export function createArtifactPrefix(repoSlug: string, taskId: string): string {
  return `tasks/${repoSlug}/${taskId}`;
}

/**
 * Creates standardized S3 keys for task artifacts
 */
export function createArtifactKeys(artifactPrefix: string) {
  return {
    metadata: `${artifactPrefix}/metadata.json`,
    log: `${artifactPrefix}/agent.log`,
    summary: `${artifactPrefix}/summary.md`,
    manifest: `${artifactPrefix}/manifest.json`,
  };
}

/**
 * Creates initial task metadata when task is requested
 */
export function createInitialTaskMetadata(
  taskPayload: TaskPayload,
  taskArn?: string
): TaskMetadata {
  const artifactPrefix = createArtifactPrefix(
    taskPayload.repo_slug,
    taskPayload.task_id
  );

  return {
    task_id: taskPayload.task_id,
    repo_slug: taskPayload.repo_slug,
    issue_number: taskPayload.issue_metadata.number,
    task_mode: taskPayload.task_mode,
    status: "requested",
    requested_ref: taskPayload.requested_ref,
    resolved_commit_sha: taskPayload.resolved_commit_sha,
    task_arn: taskArn,
    artifact_prefix: artifactPrefix,
    created_at: taskPayload.created_at,
    issue_metadata: taskPayload.issue_metadata,
  };
}

/**
 * Review Agent Types
 */

export interface ReviewPayload {
  /** Unique identifier for this review task */
  task_id: string;
  /** Repository in owner/name format */
  repo_slug: string;
  /** PR number to review */
  pr_number: number;
  /** The commit SHA at the head of the PR */
  head_sha: string;
  /** The base branch commit SHA */
  base_sha: string;
  /** PR metadata */
  pr_metadata: PRMetadata;
  /** Timestamp when review was requested */
  created_at: string;
}

export interface PRMetadata {
  /** PR number */
  number: number;
  /** PR title */
  title: string;
  /** PR body */
  body: string;
  /** Array of label names */
  labels: string[];
  /** PR author */
  author: string;
  /** Head branch name */
  head_ref: string;
  /** Base branch name */
  base_ref: string;
  /** Created by the coding agent */
  created_by_bot: boolean;
}

export interface ReviewResult {
  /** Unique review task identifier */
  task_id: string;
  /** PR number that was reviewed */
  pr_number: number;
  /** Review decision: approved, changes_requested, or error */
  decision: "approved" | "changes_requested" | "error";
  /** Structured review findings */
  findings: ReviewFindings;
  /** Error message if review failed */
  error?: string;
  /** Review completion timestamp */
  completed_at: string;
}

export interface ReviewFindings {
  /** Does the code compile/pass linting? */
  compilation: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Are there security issues? */
  security: {
    status: "pass" | "fail" | "unknown";
    issues?: string[];
  };
  /** Does it address the linked issue? */
  issue_alignment: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Are there obvious logic errors? */
  logic: {
    status: "pass" | "fail" | "unknown";
    issues?: string[];
  };
  /** Does it introduce unnecessary complexity? */
  complexity: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Is the cost impact reasonable? */
  cost_impact: {
    status: "pass" | "fail" | "unknown";
    details?: string;
  };
  /** Overall summary */
  summary: string;
}

export interface ReviewEnvironment {
  /** The complete review payload as JSON string */
  REVIEW_PAYLOAD: string;
  /** GitHub installation token for API access */
  GITHUB_TOKEN: string;
  /** Anthropic API key for direct API access */
  ANTHROPIC_API_KEY: string;
  /** S3 bucket for review artifacts */
  ARTIFACTS_BUCKET: string;
  /** S3 prefix for this review's artifacts */
  ARTIFACT_PREFIX: string;
  /** Repository in owner/name format */
  REPO: string;
  /** PR number being reviewed */
  PR_NUMBER: string;
  /** Review criteria configuration */
  REVIEW_CRITERIA: string;
}