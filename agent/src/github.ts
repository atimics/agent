const API_BASE = "https://api.github.com";

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

async function ghFetch(
  token: string,
  path: string,
  opts: RequestInit = {}
): Promise<any> {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    ...opts,
    headers: { ...headers(token), ...(opts.headers as Record<string, string>) },
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub API ${res.status} ${res.statusText}: ${body}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

export interface IssueDetails {
  number: number;
  title: string;
  body: string | null;
  state: string;
  labels: string[];
  comments: Array<{ user: string; body: string; created_at: string }>;
}

export interface PRDetails extends IssueDetails {
  diff: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
}

export async function getIssue(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<IssueDetails> {
  const issue = await ghFetch(token, `/repos/${owner}/${repo}/issues/${number}`);
  const commentsData = await ghFetch(
    token,
    `/repos/${owner}/${repo}/issues/${number}/comments?per_page=50`
  );
  return {
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l: any) => l.name),
    comments: commentsData.map((c: any) => ({
      user: c.user.login,
      body: c.body,
      created_at: c.created_at,
    })),
  };
}

export async function getPullRequest(
  token: string,
  owner: string,
  repo: string,
  number: number
): Promise<PRDetails> {
  const [pr, commentsData, diff] = await Promise.all([
    ghFetch(token, `/repos/${owner}/${repo}/pulls/${number}`),
    ghFetch(
      token,
      `/repos/${owner}/${repo}/issues/${number}/comments?per_page=50`
    ),
    fetch(`${API_BASE}/repos/${owner}/${repo}/pulls/${number}`, {
      headers: {
        ...headers(token),
        Accept: "application/vnd.github.v3.diff",
      },
    }).then((r) => r.text()),
  ]);
  return {
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    labels: pr.labels.map((l: any) => l.name),
    comments: commentsData.map((c: any) => ({
      user: c.user.login,
      body: c.body,
      created_at: c.created_at,
    })),
    diff,
    head: { ref: pr.head.ref, sha: pr.head.sha },
    base: { ref: pr.base.ref, sha: pr.base.sha },
  };
}

export async function postComment(
  token: string,
  owner: string,
  repo: string,
  number: number,
  body: string
): Promise<{ id: number; html_url: string }> {
  const res = await ghFetch(
    token,
    `/repos/${owner}/${repo}/issues/${number}/comments`,
    {
      method: "POST",
      body: JSON.stringify({ body }),
    }
  );
  return { id: res.id, html_url: res.html_url };
}

export async function createBranch(
  token: string,
  owner: string,
  repo: string,
  baseSha: string,
  branchName: string
): Promise<void> {
  await ghFetch(token, `/repos/${owner}/${repo}/git/refs`, {
    method: "POST",
    body: JSON.stringify({
      ref: `refs/heads/${branchName}`,
      sha: baseSha,
    }),
  });
}

export async function createOrUpdateFile(
  token: string,
  owner: string,
  repo: string,
  branch: string,
  path: string,
  content: string,
  message: string
): Promise<void> {
  // Check if file exists to get its sha
  let sha: string | undefined;
  try {
    const existing = await ghFetch(
      token,
      `/repos/${owner}/${repo}/contents/${path}?ref=${branch}`
    );
    sha = existing.sha;
  } catch {
    // File doesn't exist, that's fine
  }

  const body: Record<string, any> = {
    message,
    content: Buffer.from(content).toString("base64"),
    branch,
  };
  if (sha) body.sha = sha;

  await ghFetch(token, `/repos/${owner}/${repo}/contents/${path}`, {
    method: "PUT",
    body: JSON.stringify(body),
  });
}

export async function createPullRequest(
  token: string,
  owner: string,
  repo: string,
  title: string,
  body: string,
  head: string,
  base: string
): Promise<{ number: number; html_url: string }> {
  const res = await ghFetch(token, `/repos/${owner}/${repo}/pulls`, {
    method: "POST",
    body: JSON.stringify({ title, body, head, base }),
  });
  return { number: res.number, html_url: res.html_url };
}

export async function getRepoContent(
  token: string,
  owner: string,
  repo: string,
  path: string,
  ref?: string
): Promise<{ content: string; sha: string } | { entries: Array<{ name: string; type: string; path: string }> }> {
  const query = ref ? `?ref=${ref}` : "";
  const res = await ghFetch(
    token,
    `/repos/${owner}/${repo}/contents/${path}${query}`
  );
  // Directory listing
  if (Array.isArray(res)) {
    return {
      entries: res.map((e: any) => ({
        name: e.name,
        type: e.type,
        path: e.path,
      })),
    };
  }
  // File content
  return {
    content: Buffer.from(res.content, "base64").toString("utf-8"),
    sha: res.sha,
  };
}

export async function getDefaultBranch(
  token: string,
  owner: string,
  repo: string
): Promise<{ name: string; sha: string }> {
  const repoData = await ghFetch(token, `/repos/${owner}/${repo}`);
  const branch = repoData.default_branch;
  const ref = await ghFetch(
    token,
    `/repos/${owner}/${repo}/git/ref/heads/${branch}`
  );
  return { name: branch, sha: ref.object.sha };
}

export async function removeLabel(
  token: string,
  owner: string,
  repo: string,
  number: number,
  label: string
): Promise<void> {
  try {
    await ghFetch(
      token,
      `/repos/${owner}/${repo}/issues/${number}/labels/${encodeURIComponent(label)}`,
      { method: "DELETE" }
    );
  } catch {
    // Label might not exist, ignore
  }
}
