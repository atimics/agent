/**
 * Types for the immutable task contract system
 */

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
  /** GitHub token for API access */
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