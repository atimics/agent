#!/bin/bash
set -Eeuo pipefail

# --- Required env vars (passed by Lambda via Fargate overrides) ---
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${OPENROUTER_API_KEY:?Missing OPENROUTER_API_KEY}"
: "${TASK_PAYLOAD:?Missing TASK_PAYLOAD}"
: "${ARTIFACTS_BUCKET:?Missing ARTIFACTS_BUCKET}"
: "${ARTIFACT_PREFIX:?Missing ARTIFACT_PREFIX}"
: "${TRIGGER_LABEL:=agent}"
: "${SIGNAL_LABEL_RUNNING:=agent:running}"
: "${SIGNAL_LABEL_WAITING:=agent:waiting}"
: "${SIGNAL_LABEL_FAILED:=agent:failed}"
: "${SIGNAL_LABEL_SUCCEEDED:=agent:succeeded}"

# --- Parse task payload ---
echo "Parsing task payload..."
TASK_ID=$(echo "$TASK_PAYLOAD" | jq -r '.task_id')
REPO_SLUG=$(echo "$TASK_PAYLOAD" | jq -r '.repo_slug')
REQUESTED_REF=$(echo "$TASK_PAYLOAD" | jq -r '.requested_ref')
RESOLVED_COMMIT_SHA=$(echo "$TASK_PAYLOAD" | jq -r '.resolved_commit_sha')
ISSUE_NUMBER=$(echo "$TASK_PAYLOAD" | jq -r '.issue_metadata.number')
TASK_MODE=$(echo "$TASK_PAYLOAD" | jq -r '.task_mode')
CREATED_AT=$(echo "$TASK_PAYLOAD" | jq -r '.created_at')

# Extract repo owner and name from slug
REPO_OWNER=$(echo "$REPO_SLUG" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO_SLUG" | cut -d'/' -f2)
REPO="${REPO_SLUG}"

# Determine if this is a PR based on task mode
IS_PR="false"
if [ "$TASK_MODE" = "pull_request" ]; then
  IS_PR="true"
fi

echo "Task ID: $TASK_ID"
echo "Repository: $REPO_SLUG"
echo "Requested ref: $REQUESTED_REF"
echo "Resolved commit SHA: $RESOLVED_COMMIT_SHA"
echo "Issue/PR #$ISSUE_NUMBER (mode: $TASK_MODE)"
echo "Created at: $CREATED_AT"
CURRENT_STAGE="startup"
RUN_STATUS="failed"
RUN_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
AGENT_LOG="/tmp/agent-output.log"
SIGNAL_LABELS=(
  "${SIGNAL_LABEL_RUNNING}"
  "${SIGNAL_LABEL_WAITING}"
  "${SIGNAL_LABEL_FAILED}"
  "${SIGNAL_LABEL_SUCCEEDED}"
)

# S3 artifact keys
METADATA_KEY="${ARTIFACT_PREFIX}/metadata.json"
LOG_KEY="${ARTIFACT_PREFIX}/agent.log"
SUMMARY_KEY="${ARTIFACT_PREFIX}/summary.md"
MANIFEST_KEY="${ARTIFACT_PREFIX}/manifest.json"

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

update_task_metadata() {
  local status="$1"
  local error_message="$2"
  local pr_url="$3"
  local completed_timestamp=""

  if [ "$status" != "running" ]; then
    completed_timestamp="\"completed_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\","
  fi

  # Create updated metadata JSON
  local metadata_json
  metadata_json=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "repo_slug": "${REPO_SLUG}",
  "issue_number": ${ISSUE_NUMBER},
  "task_mode": "${TASK_MODE}",
  "status": "${status}",
  "requested_ref": "${REQUESTED_REF}",
  "resolved_commit_sha": "${RESOLVED_COMMIT_SHA}",
  "task_arn": "$(echo "$TASK_PAYLOAD" | jq -r '.task_arn // empty')",
  "artifact_prefix": "${ARTIFACT_PREFIX}",
  "created_at": "${CREATED_AT}",
  "started_at": "${RUN_STARTED_AT}",
  ${completed_timestamp}
  "error_message": $(if [ -n "$error_message" ]; then echo "\"$error_message\""; else echo "null"; fi),
  "pr_url": $(if [ -n "$pr_url" ]; then echo "\"$pr_url\""; else echo "null"; fi),
  "issue_metadata": $(echo "$TASK_PAYLOAD" | jq '.issue_metadata')
}
EOF
)

  # Upload metadata to S3
  echo "$metadata_json" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${METADATA_KEY}" --content-type "application/json" || true
}

upload_artifacts() {
  local exit_code="$1"
  local pr_url="$2"

  # Upload agent log if it exists
  if [ -f "${AGENT_LOG}" ] && [ -s "${AGENT_LOG}" ]; then
    aws s3 cp "${AGENT_LOG}" "s3://${ARTIFACTS_BUCKET}/${LOG_KEY}" --content-type "text/plain" || true
  fi

  # Create and upload task manifest
  local manifest_json
  manifest_json=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "metadata_key": "${METADATA_KEY}",
  "log_key": "$(if [ -f "${AGENT_LOG}" ] && [ -s "${AGENT_LOG}" ]; then echo "${LOG_KEY}"; else echo "null"; fi)",
  "summary_key": null,
  "exit_code": ${exit_code},
  "total_size_bytes": $(if [ -f "${AGENT_LOG}" ]; then wc -c < "${AGENT_LOG}"; else echo "0"; fi),
  "created_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)

  echo "$manifest_json" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${MANIFEST_KEY}" --content-type "application/json" || true
}

create_completion_summary() {
  local status="$1"
  local pr_url="$2"
  local error_message="$3"

  local summary=""
  case "$status" in
    "succeeded")
      if [ "${IS_PR}" = "true" ]; then
        summary="✅ **Agent run completed successfully**

The agent has reviewed and processed PR #${ISSUE_NUMBER}.

**Task Details:**
- Task ID: \`${TASK_ID}\`
- Commit SHA: \`${RESOLVED_COMMIT_SHA}\`
- Completed at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

[View artifacts](https://console.aws.amazon.com/s3/buckets/${ARTIFACTS_BUCKET}?prefix=${ARTIFACT_PREFIX}/)"
      elif [ -n "$pr_url" ]; then
        summary="✅ **Agent run completed successfully**

The agent has created a pull request to address issue #${ISSUE_NUMBER}: $pr_url

**Task Details:**
- Task ID: \`${TASK_ID}\`
- Commit SHA: \`${RESOLVED_COMMIT_SHA}\`
- Completed at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

[View artifacts](https://console.aws.amazon.com/s3/buckets/${ARTIFACTS_BUCKET}?prefix=${ARTIFACT_PREFIX}/)"
      else
        summary="✅ **Agent run completed**

The agent has finished working on issue #${ISSUE_NUMBER}.

**Task Details:**
- Task ID: \`${TASK_ID}\`
- Commit SHA: \`${RESOLVED_COMMIT_SHA}\`
- Completed at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")

[View artifacts](https://console.aws.amazon.com/s3/buckets/${ARTIFACTS_BUCKET}?prefix=${ARTIFACT_PREFIX}/)"
      fi
      ;;
    "waiting")
      summary="⏸️ **Agent is waiting for confirmation**

The agent has asked questions and is waiting for your response before continuing.

**Task Details:**
- Task ID: \`${TASK_ID}\`
- Commit SHA: \`${RESOLVED_COMMIT_SHA}\`

[View artifacts](https://console.aws.amazon.com/s3/buckets/${ARTIFACTS_BUCKET}?prefix=${ARTIFACT_PREFIX}/)"
      ;;
    "failed")
      summary="❌ **Agent run failed**

The agent encountered an error while working on issue #${ISSUE_NUMBER}.

**Task Details:**
- Task ID: \`${TASK_ID}\`
- Commit SHA: \`${RESOLVED_COMMIT_SHA}\`
- Failed at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")
$(if [ -n "$error_message" ]; then echo "- Error: $error_message"; fi)

[View artifacts](https://console.aws.amazon.com/s3/buckets/${ARTIFACTS_BUCKET}?prefix=${ARTIFACT_PREFIX}/)"
      ;;
  esac

  echo "$summary"
}

on_exit() {
  local exit_code=$?
  local pr_url=""

  set +e

  if [ "${RUN_STATUS}" = "waiting" ] && [ "${exit_code}" -eq 0 ]; then
    set_signal_label "${SIGNAL_LABEL_WAITING}"
    update_task_metadata "waiting" "" ""
    upload_artifacts "$exit_code" ""

    local summary=$(create_completion_summary "waiting" "" "")
    gh issue comment "${ISSUE_NUMBER}" -R "${REPO}" --body "$summary" >/dev/null 2>&1 || true

    echo "=== Agent waiting for confirmation ==="
    exit 0
  fi

  if [ "${RUN_STATUS}" = "succeeded" ] && [ "${exit_code}" -eq 0 ]; then
    set_signal_label "${SIGNAL_LABEL_SUCCEEDED}"

    # Find created PR URL if this was an issue
    if [ "${IS_PR}" = "false" ]; then
      pr_url="$(find_created_pr_url)"
    fi

    update_task_metadata "succeeded" "" "$pr_url"
    upload_artifacts "$exit_code" "$pr_url"

    local summary=$(create_completion_summary "succeeded" "$pr_url" "")
    gh issue comment "${ISSUE_NUMBER}" -R "${REPO}" --body "$summary" >/dev/null 2>&1 || true

    echo "=== Agent finished ==="
    echo "Task ID: ${TASK_ID}"
    echo "Commit SHA: ${RESOLVED_COMMIT_SHA}"
    echo "Completed at: $(date -u +"%Y-%m-%dT%H:%M:%SZ")"
    exit 0
  fi

  set_signal_label "${SIGNAL_LABEL_FAILED}"

  # Prepare detailed error message based on the stage
  local error_message="${CURRENT_STAGE}"
  local error_details=""
  case "${CURRENT_STAGE}" in
    "authenticate GitHub CLI")
      error_message="Authentication failed"
      error_details="

**Authentication Issue**: The GitHub App installation token is invalid or lacks sufficient permissions.

Please check:
- The GitHub App is installed on the target repository
- The GitHub App has the required permissions (contents, pull requests, issues)
- The \`GITHUB_APP_ID\` and \`GITHUB_APP_PRIVATE_KEY\` SSM parameters are correct
- The repository is accessible with the GitHub App installation"
      ;;
    "clone repository"|"fetch issue context")
      error_message="Repository access failed"
      error_details="

**Repository Access Issue**: Unable to access repository \`${REPO}\` or issue/PR #${ISSUE_NUMBER}.

Please check:
- The repository exists and is accessible
- The GitHub token has appropriate permissions
- The issue/PR number is correct"
      ;;
    *)
      error_message="Task failed during ${CURRENT_STAGE}"
      ;;
  esac

  # Update metadata and upload artifacts
  update_task_metadata "failed" "$error_message" ""
  upload_artifacts "$exit_code" ""

  # Include last 50 lines of agent output if available
  local log_tail=""
  if [ -f "${AGENT_LOG}" ] && [ -s "${AGENT_LOG}" ]; then
    log_tail="

<details><summary>Agent output (last 50 lines)</summary>

\`\`\`
$(tail -50 "${AGENT_LOG}")
\`\`\`
</details>"
  fi

  # Create completion summary
  local summary=$(create_completion_summary "failed" "" "$error_message")

  gh issue comment "${ISSUE_NUMBER}" -R "${REPO}" --body "${summary}${error_details}${log_tail}

Exit code: ${exit_code}" >/dev/null 2>&1 || true

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

# Validate authentication by testing repository access directly
# Note: gh auth status and gh api user don't work with GitHub App installation tokens
echo "Validating GitHub App installation token..."
if ! gh repo view "${REPO}" --json nameWithOwner >/dev/null 2>&1; then
  echo "ERROR: Cannot access repository ${REPO}"
  echo "GitHub App installation may not have access to this repository"
  echo "Token test: gh api repos/${REPO} response:"
  gh api "repos/${REPO}" 2>&1 | head -5 || true
  exit 1
fi
echo "Repository access confirmed for ${REPO}"

# Configure git identity for commits
git config --global user.name "github-agent[bot]"
git config --global user.email "github-agent[bot]@users.noreply.github.com"

echo "GitHub CLI authentication successful"
set_signal_label "${SIGNAL_LABEL_RUNNING}"

# Update task status to running
update_task_metadata "running" "" ""

# --- Clone repo ---
CURRENT_STAGE="clone repository"
echo "Cloning ${REPO}..."
gh repo clone "${REPO}" repo -- --depth=50
cd repo

# Fix git remote URL for push authentication
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"

# --- Checkout resolved commit SHA ---
# For PRs, the SHA is on the PR branch — not in the shallow main clone.
# Fetch it explicitly before attempting checkout.
if [ "${IS_PR}" = "true" ]; then
  echo "Fetching PR ref for commit $RESOLVED_COMMIT_SHA..."
  git fetch origin "pull/${ISSUE_NUMBER}/head" --depth=50 2>&1 || true
fi

echo "Checking out resolved commit SHA: $RESOLVED_COMMIT_SHA"
if ! git checkout "$RESOLVED_COMMIT_SHA" 2>&1; then
  echo "ERROR: Failed to checkout commit SHA $RESOLVED_COMMIT_SHA"
  echo "Attempting full fetch..." >&2
  git fetch --unshallow 2>&1 || git fetch origin 2>&1 || true
  if ! git checkout "$RESOLVED_COMMIT_SHA" 2>&1; then
    echo "ERROR: Still cannot checkout $RESOLVED_COMMIT_SHA after full fetch"
    exit 1
  fi
fi

echo "Successfully checked out commit $RESOLVED_COMMIT_SHA"

# --- Fetch issue/PR context ---
CURRENT_STAGE="fetch issue context"
echo "Fetching context for #${ISSUE_NUMBER}..."
if [ "${IS_PR}" = "true" ]; then
  echo "Fetching PR context via API..."

  # Use the GitHub REST API directly — more reliable than gh pr view with App tokens
  PR_JSON=$(gh api "repos/${REPO}/pulls/${ISSUE_NUMBER}" 2>&1) || {
    echo "ERROR: Failed to fetch PR via API:" >&2
    echo "$PR_JSON" >&2
    echo "$PR_JSON" >> "${AGENT_LOG}"
    exit 1
  }

  PR_TITLE=$(echo "$PR_JSON" | jq -r '.title // "(no title)"')
  PR_BODY=$(echo "$PR_JSON" | jq -r '.body // "(no description)"')
  PR_HEAD_REF=$(echo "$PR_JSON" | jq -r '.head.ref')
  PR_BASE_REF=$(echo "$PR_JSON" | jq -r '.base.ref')

  CONTEXT="## PR #${ISSUE_NUMBER}: ${PR_TITLE}
Base: ${PR_BASE_REF} <- Head: ${PR_HEAD_REF}

### Description
${PR_BODY}"

  # Get issue comments (PR comments are on the issues endpoint)
  if COMMENTS=$(gh api "repos/${REPO}/issues/${ISSUE_NUMBER}/comments" 2>/dev/null \
    | jq -r '.[] | "**\(.user.login)**: \(.body)"' 2>/dev/null); then
    if [ -n "$COMMENTS" ]; then
      CONTEXT="${CONTEXT}

### Comments
${COMMENTS}"
    fi
  fi

  # Get the diff
  DIFF=$(gh api "repos/${REPO}/pulls/${ISSUE_NUMBER}" -H "Accept: application/vnd.github.v3.diff" 2>/dev/null \
    | head -c 20000 || echo "(diff too large or unavailable)")
  CONTEXT="${CONTEXT}

### Diff
${DIFF}"

  # Checkout the PR branch for easier modification
  echo "Checking out PR branch ${PR_HEAD_REF}..."
  git fetch origin "${PR_HEAD_REF}" 2>>"${AGENT_LOG}" || true
  if ! git checkout "${PR_HEAD_REF}" 2>>"${AGENT_LOG}"; then
    echo "WARNING: Could not checkout PR branch, staying on commit SHA ${RESOLVED_COMMIT_SHA}" >&2
  fi
else
  # Capture stderr for better error diagnosis
  ISSUE_STDERR="${AGENT_LOG}.issue_stderr"

  if ! CONTEXT=$(gh issue view "${ISSUE_NUMBER}" -R "${REPO}" --json number,title,body,comments,labels \
    --template '## Issue #{{.number}}: {{.title}}
Labels: {{range .labels}}{{.name}}, {{end}}

### Description
{{.body}}

### Comments
{{range .comments}}**{{.author.login}}** ({{.createdAt}}):
{{.body}}

{{end}}' 2>"${ISSUE_STDERR}"); then
    echo "ERROR: gh issue view failed:" >&2
    if [ -f "${ISSUE_STDERR}" ]; then
      cat "${ISSUE_STDERR}" >&2
      cat "${ISSUE_STDERR}" >> "${AGENT_LOG}"
    fi
    exit 1
  fi
fi

# --- Build the mission prompt ---
if [ "${IS_PR}" = "true" ]; then
  MISSION="You have been triggered by the 'agent' label on PR #${ISSUE_NUMBER} in ${REPO}.

Here is the PR context:
${CONTEXT}

Your mission:
- Review the PR diff and understand the changes
- If improvements are needed, make the changes directly
- Commit and push any changes you make
- Post a comment on the PR summarizing what you did using: gh issue comment ${ISSUE_NUMBER} --body '<your comment>'
- If you need clarification from the author, post a comment asking for it and stop
- Be concise. Make minimal, focused changes.

Note: You are working on commit SHA ${RESOLVED_COMMIT_SHA} which was the head of the PR when this task was created."
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

# --- Run Claude Code with OpenRouter ---
# OpenRouter's Claude Code compatibility layer expects the base API path and auth token envs.
export ANTHROPIC_BASE_URL="https://openrouter.ai/api"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""
export CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1

MAX_ATTEMPTS=2
ATTEMPT=0
RUN_STATUS=""

while [ -z "${RUN_STATUS}" ] && [ "${ATTEMPT}" -lt "${MAX_ATTEMPTS}" ]; do
  ATTEMPT=$((ATTEMPT + 1))
  CURRENT_STAGE="run agent (attempt ${ATTEMPT}/${MAX_ATTEMPTS})"
  echo "=== Starting Claude Code (attempt ${ATTEMPT}/${MAX_ATTEMPTS}) ==="
  echo "Task ID: ${TASK_ID}"
  echo "Mission: Working on #${ISSUE_NUMBER} in ${REPO}"
  echo "Commit SHA: ${RESOLVED_COMMIT_SHA}"
  echo "Requested ref: ${REQUESTED_REF}"

  # Run in non-interactive mode with the mission prompt
  # --dangerously-skip-permissions skips tool approval (we're in an isolated container)
  # Capture output for debugging failed runs
  claude --dangerously-skip-permissions \
    --model "anthropic/claude-sonnet-4" \
    --print \
    "${MISSION}" 2>&1 | tee "${AGENT_LOG}" || true

  echo "--- Claude Code exit status: ${PIPESTATUS[0]} ---" | tee -a "${AGENT_LOG}"

  # --- Verify outputs ---
  CURRENT_STAGE="verify outputs"

  # Give GitHub a moment to index cross-references
  sleep 5

  if [ "${IS_PR}" = "true" ]; then
    RUN_STATUS="succeeded"
  elif PR_URL="$(find_created_pr_url)" && [ -n "${PR_URL}" ]; then
    RUN_STATUS="succeeded"
  elif has_agent_question_comment; then
    RUN_STATUS="waiting"
  elif [ "${ATTEMPT}" -lt "${MAX_ATTEMPTS}" ]; then
    echo "Attempt ${ATTEMPT}: no PR created and no questions asked — retrying..." >&2
  else
    echo "Agent exited successfully but no PR was created for issue #${ISSUE_NUMBER} after ${MAX_ATTEMPTS} attempts" >&2
    exit 1
  fi
done
