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