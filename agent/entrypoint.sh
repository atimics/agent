#!/bin/bash
set -Eeuo pipefail

# --- Required env vars (passed by Lambda via Fargate overrides) ---
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${OPENROUTER_API_KEY:?Missing OPENROUTER_API_KEY}"
: "${REPO_OWNER:?Missing REPO_OWNER}"
: "${REPO_NAME:?Missing REPO_NAME}"
: "${ISSUE_NUMBER:?Missing ISSUE_NUMBER}"
: "${IS_PR:=false}"
: "${TRIGGER_LABEL:=agent}"
: "${SIGNAL_LABEL_RUNNING:=agent:running}"
: "${SIGNAL_LABEL_WAITING:=agent:waiting}"
: "${SIGNAL_LABEL_FAILED:=agent:failed}"
: "${SIGNAL_LABEL_SUCCEEDED:=agent:succeeded}"

REPO="${REPO_OWNER}/${REPO_NAME}"
CURRENT_STAGE="startup"
RUN_STATUS="failed"
RUN_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
SIGNAL_LABELS=(
  "${SIGNAL_LABEL_RUNNING}"
  "${SIGNAL_LABEL_WAITING}"
  "${SIGNAL_LABEL_FAILED}"
  "${SIGNAL_LABEL_SUCCEEDED}"
)

set_signal_label() {
  local target_label="$1"
  local label

  for label in "${SIGNAL_LABELS[@]}"; do
    if [ "${label}" != "${target_label}" ]; then
      gh issue edit "${ISSUE_NUMBER}" --remove-label "${label}" -R "${REPO}" >/dev/null 2>&1 || true
    fi
  done

  gh issue edit "${ISSUE_NUMBER}" --remove-label "${TRIGGER_LABEL}" -R "${REPO}" >/dev/null 2>&1 || true
  gh issue edit "${ISSUE_NUMBER}" --add-label "${target_label}" -R "${REPO}" >/dev/null 2>&1 || true
}

on_exit() {
  local exit_code=$?

  set +e

  if [ "${RUN_STATUS}" = "waiting" ] && [ "${exit_code}" -eq 0 ]; then
    set_signal_label "${SIGNAL_LABEL_WAITING}"
    echo "=== Agent waiting for confirmation ==="
    exit 0
  fi

  if [ "${RUN_STATUS}" = "succeeded" ] && [ "${exit_code}" -eq 0 ]; then
    set_signal_label "${SIGNAL_LABEL_SUCCEEDED}"
    echo "=== Agent finished ==="
    exit 0
  fi

  set_signal_label "${SIGNAL_LABEL_FAILED}"

  # Prepare detailed error message based on the stage
  local error_details=""
  case "${CURRENT_STAGE}" in
    "authenticate GitHub CLI")
      error_details="

**Authentication Issue**: The GitHub token provided to the agent is invalid or lacks sufficient permissions.

Please check:
- The \`GITHUB_TOKEN\` SSM parameter contains a valid GitHub Personal Access Token
- The token has \`repo\` and \`read:org\` permissions
- The token hasn't expired
- The repository is accessible with this token"
      ;;
    "clone repository"|"fetch issue context")
      error_details="

**Repository Access Issue**: Unable to access repository \`${REPO}\` or issue/PR #${ISSUE_NUMBER}.

Please check:
- The repository exists and is accessible
- The GitHub token has appropriate permissions
- The issue/PR number is correct"
      ;;
    *)
      error_details=""
      ;;
  esac

  gh issue comment "${ISSUE_NUMBER}" -R "${REPO}" --body "$(cat <<EOF
Agent run failed during \`${CURRENT_STAGE}\`.${error_details}

Exit code: ${exit_code}
EOF
)" >/dev/null 2>&1 || true

  echo "=== Agent failed ==="
  exit "${exit_code}"
}

trap on_exit EXIT

find_created_pr_url() {
  gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/timeline?per_page=100" \
    -H "Accept: application/vnd.github+json" \
    | jq -r --arg since "${RUN_STARTED_AT}" '
      map(
        select(
          .event == "cross-referenced"
          and .created_at >= $since
          and .source.issue.pull_request.html_url != null
        )
      )
      | last
      | .source.issue.html_url // empty
    '
}

has_agent_question_comment() {
  local comments_json

  comments_json="$(gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/comments?per_page=100")"

  jq -e --arg since "${RUN_STARTED_AT}" '
    map(
      select(
        .created_at >= $since
        and (.body | test("\\?"))
      )
    )
    | length > 0
  ' >/dev/null <<<"${comments_json}"
}

# --- Auth gh CLI ---
CURRENT_STAGE="authenticate GitHub CLI"
echo "Setting up GitHub CLI authentication..."

# Clear any existing gh auth state to avoid conflicts
gh auth logout --hostname github.com >/dev/null 2>&1 || true

# Use environment-based auth (preferred for headless environments)
export GH_TOKEN="${GITHUB_TOKEN}"

# Validate authentication early
echo "Validating GitHub CLI authentication..."
if ! gh auth status >/dev/null 2>&1; then
  echo "ERROR: GitHub CLI authentication failed"
  echo "GitHub CLI auth status:"
  gh auth status 2>&1 || true
  echo ""
  echo "This usually means:"
  echo "1. The GITHUB_TOKEN is invalid or expired"
  echo "2. The token doesn't have sufficient permissions"
  echo "3. GitHub API is unavailable"
  exit 1
fi

# Test basic GitHub API access
echo "Testing GitHub API access..."
if ! gh api user >/dev/null 2>&1; then
  echo "ERROR: Cannot access GitHub API with provided token"
  echo "Token may be invalid or lack required permissions (repo, read:org)"
  exit 1
fi

# Test repository access specifically
echo "Testing repository access for ${REPO}..."
if ! gh repo view "${REPO}" >/dev/null 2>&1; then
  echo "ERROR: Cannot access repository ${REPO}"
  echo "Token may lack access to this specific repository"
  exit 1
fi

# Configure git identity for commits
git config --global user.name "github-agent[bot]"
git config --global user.email "github-agent[bot]@users.noreply.github.com"

echo "GitHub CLI authentication successful"
set_signal_label "${SIGNAL_LABEL_RUNNING}"

# --- Clone repo ---
CURRENT_STAGE="clone repository"
echo "Cloning ${REPO}..."
gh repo clone "${REPO}" repo -- --depth=50
cd repo

# --- Fetch issue/PR context ---
CURRENT_STAGE="fetch issue context"
echo "Fetching context for #${ISSUE_NUMBER}..."
if [ "${IS_PR}" = "true" ]; then
  CONTEXT=$(gh pr view "${ISSUE_NUMBER}" --json title,body,comments,labels,headRefName,baseRefName,files \
    --template '## PR #{{.number}}: {{.title}}
Base: {{.baseRefName}} <- Head: {{.headRefName}}
Labels: {{range .labels}}{{.name}}, {{end}}

### Description
{{.body}}

### Changed Files
{{range .files}}{{.path}} (+{{.additions}} -{{.deletions}})
{{end}}

### Comments
{{range .comments}}**{{.author.login}}** ({{.createdAt}}):
{{.body}}

{{end}}')

  # Also get the diff
  DIFF=$(gh pr diff "${ISSUE_NUMBER}" 2>/dev/null | head -c 20000 || echo "(diff too large or unavailable)")
  CONTEXT="${CONTEXT}

### Diff
${DIFF}"
else
  CONTEXT=$(gh issue view "${ISSUE_NUMBER}" --json title,body,comments,labels \
    --template '## Issue #{{.number}}: {{.title}}
Labels: {{range .labels}}{{.name}}, {{end}}

### Description
{{.body}}

### Comments
{{range .comments}}**{{.author.login}}** ({{.createdAt}}):
{{.body}}

{{end}}')
fi

# --- Build the mission prompt ---
if [ "${IS_PR}" = "true" ]; then
  MISSION="You have been triggered by the 'agent' label on PR #${ISSUE_NUMBER} in ${REPO}.

Here is the PR context:
${CONTEXT}

Your mission:
- Review the PR diff and understand the changes
- If improvements are needed, make the changes directly (you're on the PR branch already)
- Commit and push any changes you make
- Post a comment on the PR summarizing what you did using: gh issue comment ${ISSUE_NUMBER} --body '<your comment>'
- If you need clarification from the author, post a comment asking for it and stop
- Be concise. Make minimal, focused changes."

  # Check out the PR branch
  gh pr checkout "${ISSUE_NUMBER}"
else
  MISSION="You have been triggered by the 'agent' label on issue #${ISSUE_NUMBER} in ${REPO}.

Here is the issue context:
${CONTEXT}

Your mission:
- Understand the issue and explore the codebase to find the relevant files
- Make the code changes needed to resolve the issue
- Create a new branch, commit your changes, and push
- Create a PR that references this issue using: gh pr create --title '<title>' --body 'Fixes #${ISSUE_NUMBER}\n\n<description>'
- If you need more information to proceed, post a comment asking for clarification using: gh issue comment ${ISSUE_NUMBER} --body '<your question>'
- Be concise. Make minimal, focused changes. Don't refactor unrelated code."
fi

echo "=== Starting Claude Code ==="
echo "Mission: Working on #${ISSUE_NUMBER} in ${REPO}"

# --- Run Claude Code with OpenRouter ---
# OpenRouter's Claude Code compatibility layer expects the base API path and auth token envs.
CURRENT_STAGE="run agent"
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

# Run in non-interactive mode with the mission prompt
# --dangerously-skip-permissions skips tool approval (we're in an isolated container)
claude --dangerously-skip-permissions \
  --model "anthropic/claude-sonnet-4" \
  --print \
  "${MISSION}"

CURRENT_STAGE="verify outputs"
if [ "${IS_PR}" = "true" ]; then
  RUN_STATUS="succeeded"
elif PR_URL="$(find_created_pr_url)" && [ -n "${PR_URL}" ]; then
  RUN_STATUS="succeeded"
elif has_agent_question_comment; then
  RUN_STATUS="waiting"
else
  echo "Agent exited successfully but no PR was created for issue #${ISSUE_NUMBER}" >&2
  exit 1
fi
