#!/bin/bash
set -Eeuo pipefail

# --- Required env vars (passed by Lambda via Fargate overrides) ---
: "${GITHUB_TOKEN:?Missing GITHUB_TOKEN}"
: "${OPENROUTER_API_KEY:?Missing OPENROUTER_API_KEY}"
: "${REVIEW_PAYLOAD:?Missing REVIEW_PAYLOAD}"
: "${ARTIFACTS_BUCKET:?Missing ARTIFACTS_BUCKET}"
: "${ARTIFACT_PREFIX:?Missing ARTIFACT_PREFIX}"
: "${REPO:?Missing REPO}"
: "${PR_NUMBER:?Missing PR_NUMBER}"
: "${REVIEW_CRITERIA:?Missing REVIEW_CRITERIA}"

# --- Parse review payload ---
echo "Parsing review payload..."
TASK_ID=$(echo "$REVIEW_PAYLOAD" | jq -r '.task_id')
REPO_SLUG=$(echo "$REVIEW_PAYLOAD" | jq -r '.repo_slug')
HEAD_SHA=$(echo "$REVIEW_PAYLOAD" | jq -r '.head_sha')
BASE_SHA=$(echo "$REVIEW_PAYLOAD" | jq -r '.base_sha')
PR_TITLE=$(echo "$REVIEW_PAYLOAD" | jq -r '.pr_metadata.title')
PR_AUTHOR=$(echo "$REVIEW_PAYLOAD" | jq -r '.pr_metadata.author')
CREATED_AT=$(echo "$REVIEW_PAYLOAD" | jq -r '.created_at')

# Extract repo owner and name from slug
REPO_OWNER=$(echo "$REPO_SLUG" | cut -d'/' -f1)
REPO_NAME=$(echo "$REPO_SLUG" | cut -d'/' -f2)

echo "=== Review Task Starting ==="
echo "Task ID: $TASK_ID"
echo "Repository: $REPO_SLUG"
echo "PR #$PR_NUMBER: $PR_TITLE"
echo "Author: $PR_AUTHOR"
echo "HEAD SHA: $HEAD_SHA"
echo "BASE SHA: $BASE_SHA"
echo "Created at: $CREATED_AT"

CURRENT_STAGE="startup"
REVIEW_STATUS="error"
RUN_STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
REVIEW_LOG="/tmp/review-output.log"

# S3 artifact keys
METADATA_KEY="${ARTIFACT_PREFIX}/review-metadata.json"
LOG_KEY="${ARTIFACT_PREFIX}/review.log"
RESULT_KEY="${ARTIFACT_PREFIX}/review-result.json"

update_review_status() {
  local status="$1"
  local decision="$2"
  local findings="$3"
  local error_message="$4"
  local completed_timestamp=""

  if [ "$status" != "running" ]; then
    completed_timestamp="\"completed_at\": \"$(date -u +"%Y-%m-%dT%H:%M:%SZ")\","
  fi

  # Create updated metadata JSON
  local metadata_json
  metadata_json=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "pr_number": ${PR_NUMBER},
  "repo_slug": "${REPO_SLUG}",
  "status": "${status}",
  "decision": $(if [ -n "$decision" ]; then echo "\"$decision\""; else echo "null"; fi),
  "task_arn": "",
  "created_at": "${CREATED_AT}",
  "started_at": "${RUN_STARTED_AT}",
  ${completed_timestamp}
  "error_message": $(if [ -n "$error_message" ]; then echo "\"$error_message\""; else echo "null"; fi)
}
EOF
)

  # Upload metadata to S3
  echo "$metadata_json" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${METADATA_KEY}" --content-type "application/json" || true

  # Upload findings if provided
  if [ -n "$findings" ]; then
    echo "$findings" | aws s3 cp - "s3://${ARTIFACTS_BUCKET}/${RESULT_KEY}" --content-type "application/json" || true
  fi
}

upload_review_artifacts() {
  # Upload review log if it exists
  if [ -f "${REVIEW_LOG}" ] && [ -s "${REVIEW_LOG}" ]; then
    aws s3 cp "${REVIEW_LOG}" "s3://${ARTIFACTS_BUCKET}/${LOG_KEY}" --content-type "text/plain" || true
  fi
}

post_review_comment() {
  local decision="$1"
  local findings="$2"

  local comment_body=""
  case "$decision" in
    "approved")
      comment_body="✅ **Automated Review: APPROVED**

This PR has been reviewed by the agent and is approved for merging.

**Review Summary:**
$findings

The PR will be automatically merged after a 1-hour hold period unless manually intervened.

🔄 **Labels Applied:** \`review:approved\`
⏱️ **Auto-merge:** Scheduled for $(date -d '+1 hour' '+%Y-%m-%d %H:%M UTC')

To prevent auto-merge, remove the \`review:approved\` label or close this PR.

*Task ID: \`${TASK_ID}\`*"
      ;;
    "changes_requested")
      comment_body="❌ **Automated Review: CHANGES REQUESTED**

The automated review has identified issues that need to be addressed before this PR can be merged.

**Review Findings:**
$findings

Please address these issues and push new commits. The review will run again automatically.

🔄 **Labels Applied:** \`review:changes-requested\`

*Task ID: \`${TASK_ID}\`*"
      ;;
    "error")
      comment_body="🔧 **Automated Review: ERROR**

The automated review encountered an error and could not complete.

**Error Details:**
$findings

This PR will require manual review.

🔄 **Labels Applied:** \`review:error\`

*Task ID: \`${TASK_ID}\`*"
      ;;
  esac

  # Post the review comment
  gh issue comment "${PR_NUMBER}" -R "${REPO}" --body "$comment_body" 2>&1 | tee -a "${REVIEW_LOG}" || true
}

apply_review_labels() {
  local decision="$1"

  # Remove any existing review labels
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:approved" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:changes-requested" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:error" 2>/dev/null || true
  gh issue edit "${PR_NUMBER}" -R "${REPO}" --remove-label "review:human-required" 2>/dev/null || true

  # Apply the appropriate label
  case "$decision" in
    "approved")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:approved" 2>/dev/null || true
      ;;
    "changes_requested")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:changes-requested" 2>/dev/null || true
      ;;
    "error")
      gh issue edit "${PR_NUMBER}" -R "${REPO}" --add-label "review:error" 2>/dev/null || true
      ;;
  esac
}

on_exit() {
  local exit_code=$?

  set +e

  if [ "${REVIEW_STATUS}" = "error" ] || [ "${exit_code}" -ne 0 ]; then
    local error_message="Review failed during ${CURRENT_STAGE}"
    update_review_status "failed" "error" "" "$error_message"
    upload_review_artifacts
    apply_review_labels "error"
    post_review_comment "error" "Error during ${CURRENT_STAGE}. Exit code: ${exit_code}"

    echo "=== Review failed ==="
    exit "${exit_code}"
  else
    echo "=== Review completed successfully ==="
    exit 0
  fi
}

trap on_exit EXIT

# --- Auth gh CLI ---
CURRENT_STAGE="authenticate GitHub CLI"
echo "Setting up GitHub CLI authentication..."

# Clear any existing gh auth state to avoid conflicts
gh auth logout --hostname github.com >/dev/null 2>&1 || true

# Use environment-based auth
export GH_TOKEN="${GITHUB_TOKEN}"

# Validate authentication
echo "Validating GitHub App installation token..."
if ! gh repo view "${REPO}" --json nameWithOwner >/dev/null 2>&1; then
  echo "ERROR: Cannot access repository ${REPO}"
  exit 1
fi
echo "Repository access confirmed for ${REPO}"

# Configure git identity for potential commits
git config --global user.name "github-agent-review[bot]"
git config --global user.email "github-agent-review[bot]@users.noreply.github.com"

echo "GitHub CLI authentication successful"

# --- Clone repo and set up worktree ---
CURRENT_STAGE="clone repository"
echo "Cloning ${REPO}..."
gh repo clone "${REPO}" repo -- --depth=50
cd repo

# Fix git remote URL for authenticated access
git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"

# --- Create worktrees for base and head ---
CURRENT_STAGE="setup worktrees"
echo "Setting up worktrees for comparison..."

# Create worktree for base branch at base SHA
git worktree add ../base-worktree "$BASE_SHA" 2>&1 | tee -a "${REVIEW_LOG}"

# Create worktree for PR head at head SHA
git worktree add ../pr-worktree "$HEAD_SHA" 2>&1 | tee -a "${REVIEW_LOG}"

echo "Worktrees created:"
echo "- Base: ../base-worktree (${BASE_SHA})"
echo "- PR Head: ../pr-worktree (${HEAD_SHA})"

# --- Fetch PR context ---
CURRENT_STAGE="fetch PR context"
echo "Fetching PR context..."

PR_JSON=$(gh pr view "${PR_NUMBER}" -R "${REPO}" --json number,title,body,headRefName,baseRefName,author,labels,files 2>&1 | tee -a "${REVIEW_LOG}")

# Get the diff
echo "Getting PR diff..."
DIFF=$(gh pr diff "${PR_NUMBER}" -R "${REPO}" 2>&1 | tee -a "${REVIEW_LOG}")

# Get linked issues from PR body
LINKED_ISSUES=$(echo "$PR_JSON" | jq -r '.body // ""' | grep -oE '#[0-9]+' | sort -u | tr '\n' ' ' || echo "")

echo "PR context fetched. Linked issues: ${LINKED_ISSUES:-none}"

# --- Build the review prompt ---
CURRENT_STAGE="run review analysis"
echo "Starting automated review analysis..."

REVIEW_MISSION="You are an automated code review agent for PR #${PR_NUMBER} in ${REPO}.

## PR Details
**Title:** ${PR_TITLE}
**Author:** ${PR_AUTHOR}
**HEAD SHA:** ${HEAD_SHA}
**BASE SHA:** ${BASE_SHA}
**Linked Issues:** ${LINKED_ISSUES:-None identified}

## PR Context
${PR_JSON}

## Review Criteria
You must evaluate this PR against the following criteria and provide structured findings:

1. **Compilation/Linting**: Does the code compile and pass basic linting?
2. **Security**: Are there any security issues (secret exposure, injection vulnerabilities, unsafe patterns)?
3. **Issue Alignment**: Does this PR actually address the linked issue(s)?
4. **Logic**: Are there obvious logic errors or bugs?
5. **Complexity**: Does it introduce unnecessary complexity or scope creep?
6. **Cost Impact**: Are there concerning cost implications (new infrastructure, expensive dependencies)?

## Your Tasks
1. **Examine the codebase**: Use your tools to read relevant files and understand the changes
2. **Analyze the diff**: Review the actual changes being made
3. **Check for issues**: Look for the problems listed in the review criteria
4. **Make a decision**: Determine if this should be APPROVED or if CHANGES ARE REQUESTED
5. **Document findings**: Create a structured summary of your analysis

## Output Format
End your analysis by calling the special review function with your findings:

\`\`\`
review_complete(
  decision=\"approved\" or \"changes_requested\",
  summary=\"Brief summary of the review\",
  findings={
    \"compilation\": {\"status\": \"pass/fail/unknown\", \"details\": \"...\"},
    \"security\": {\"status\": \"pass/fail/unknown\", \"issues\": [...]},
    \"issue_alignment\": {\"status\": \"pass/fail/unknown\", \"details\": \"...\"},
    \"logic\": {\"status\": \"pass/fail/unknown\", \"issues\": [...]},
    \"complexity\": {\"status\": \"pass/fail/unknown\", \"details\": \"...\"},
    \"cost_impact\": {\"status\": \"pass/fail/unknown\", \"details\": \"...\"}
  }
)
\`\`\`

## Working Directory
You are in the PR head worktree (${HEAD_SHA}). The base version is available at ../base-worktree.

## Guidelines
- Be thorough but efficient with your analysis
- Focus on real issues, not style preferences
- If unsure about something critical, request changes rather than approve
- Consider the impact and scope of changes
- Check that tests pass if there are any

Begin your review now."

# --- Run Claude with OpenRouter API ---
echo "Running review analysis with Claude Opus..."
export ANTHROPIC_BASE_URL="https://openrouter.ai/api/v1"
export ANTHROPIC_AUTH_TOKEN="${OPENROUTER_API_KEY}"
export ANTHROPIC_API_KEY=""

# Change to the PR head worktree for analysis
cd ../pr-worktree

# Run Claude Code with the review mission
claude --dangerously-skip-permissions \
  --model "anthropic/claude-opus-4-6" \
  --print \
  "${REVIEW_MISSION}" 2>&1 | tee "${REVIEW_LOG}"

# Parse the review output for the decision and findings
REVIEW_OUTPUT=$(cat "${REVIEW_LOG}")

# Look for the review_complete call in the output
if echo "$REVIEW_OUTPUT" | grep -q "review_complete"; then
  # Extract the decision and create findings JSON
  # This is a simplified parser - in production you'd want more robust parsing
  if echo "$REVIEW_OUTPUT" | grep -q 'decision="approved"'; then
    REVIEW_DECISION="approved"
  elif echo "$REVIEW_OUTPUT" | grep -q 'decision="changes_requested"'; then
    REVIEW_DECISION="changes_requested"
  else
    REVIEW_DECISION="error"
  fi

  # Create a structured findings summary from the review output
  FINDINGS_SUMMARY=$(echo "$REVIEW_OUTPUT" | tail -100 | head -50)

  # Create structured findings JSON
  FINDINGS_JSON=$(cat <<EOF
{
  "task_id": "${TASK_ID}",
  "pr_number": ${PR_NUMBER},
  "decision": "${REVIEW_DECISION}",
  "findings": {
    "compilation": {"status": "unknown", "details": "See full review log"},
    "security": {"status": "unknown", "issues": []},
    "issue_alignment": {"status": "unknown", "details": "See full review log"},
    "logic": {"status": "unknown", "issues": []},
    "complexity": {"status": "unknown", "details": "See full review log"},
    "cost_impact": {"status": "unknown", "details": "See full review log"},
    "summary": "${FINDINGS_SUMMARY}"
  },
  "completed_at": "$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
}
EOF
)

  echo "=== Review Analysis Complete ==="
  echo "Decision: ${REVIEW_DECISION}"
  echo "Findings: ${FINDINGS_SUMMARY}"

  # Update status and post results
  update_review_status "completed" "$REVIEW_DECISION" "$FINDINGS_JSON" ""
  upload_review_artifacts
  apply_review_labels "$REVIEW_DECISION"
  post_review_comment "$REVIEW_DECISION" "$FINDINGS_SUMMARY"

  REVIEW_STATUS="completed"
else
  echo "ERROR: Review analysis did not complete properly"
  REVIEW_STATUS="error"
  exit 1
fi