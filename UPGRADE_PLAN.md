# Agent Platform Upgrade Plan

## 1. Current State Assessment

### Working Components ✅

**Infrastructure (CDK Stack)**
- ✅ Private network isolation with NAT gateway (PR #21)
- ✅ VPC endpoints for S3, ECR, CloudWatch, SSM reducing internet egress
- ✅ Explicit security group rules (HTTPS/443, HTTP/80, DNS/53)
- ✅ ECR repository with lifecycle management (keep 5 images)
- ✅ S3 artifacts bucket with 30-day lifecycle policy
- ✅ EventBridge-triggered cleanup every 2 hours for stale tasks

**Webhook Handler (Lambda)**
- ✅ GitHub App authentication with installation tokens (PR #18)
- ✅ Commit SHA resolution for immutable task contracts (PR #16)
- ✅ HMAC-SHA256 webhook signature validation
- ✅ Structured task metadata storage to S3 (PR #20)
- ✅ Error handling and GitHub label management

**Agent Container (Fargate)**
- ✅ Claude Code integration with OpenRouter compatibility
- ✅ Retry logic for empty output scenarios (PR #14)
- ✅ Comprehensive logging and error capture (PR #15)
- ✅ Exit handler for proper status reporting
- ✅ Repository cloning and checkout at resolved SHA

**Task Lifecycle Management**
- ✅ Persistent artifacts with metadata, logs, and summaries
- ✅ Label-based status signaling (`agent:running`, `agent:waiting`, etc.)
- ✅ Automated cleanup of tasks >60 minutes old

### Fragile Components ⚠️

**Stale Label Detection**
- `agent:running` labels persist forever if container crashes or cleanup fails
- No monitoring for containers that die without updating metadata
- GitHub webhook may miss label removals if cleanup Lambda fails

**Concurrency Control**
- Multiple webhook events can launch duplicate tasks for same issue
- No distributed locking mechanism to prevent race conditions
- ECS task limits provide crude concurrency bounds but no per-issue protection

**Error Diagnostics**
- Claude Code failures often produce cryptic or empty error messages
- Authentication failures show generic messages not specific root causes
- Network connectivity issues in VPC endpoints not well-diagnosed

**Git Push Authentication**
- Agent manual troubleshooting required `x-access-token` prefix hint
- Error messages unclear when GitHub App permissions insufficient
- No automated validation of repository write access before task launch

### Missing Components ❌

**Observability & Metrics**
- No success/failure rate dashboards
- No alerting on high failure rates or stuck tasks
- No visibility into resource utilization or cost trends
- No performance metrics (task duration, queue depth)

**Cost Monitoring**
- No tracking of OpenRouter API token usage per task
- No breakdown of NAT gateway egress costs
- No analysis of Fargate resource efficiency (2GB/1vCPU utilization rates)

**Multi-repository Support**
- Single GitHub App installation assumes one repository
- No agent instructions (CLAUDE.md) per-repository configuration
- Cross-repo operations not supported despite GitHub App scope

**PR Review Workflow**
- `IS_PR=true` path exists but broken/incomplete
- No proper handling of PR review comments vs implementation changes
- Branch modification permissions unclear for external contributor PRs

### Tech Debt from Recent PRs

**PR #21 (Network Isolation)**: VPC endpoint costs not quantified, may exceed NAT gateway savings for low-traffic scenarios

**PR #20 (Artifacts)**: S3 artifact structure includes redundant metadata duplication in multiple formats

**PR #19 (Auth Fix)**: Added workaround for GitHub App auth checking instead of proper solution

**PR #18 (GitHub App)**: Error messages still reference PAT authentication in some paths

**PR #16 (Immutable Tasks)**: Task retry logic doesn't account for different commit SHAs between attempts

**PR #15 (Error Logging)**: Log capture limited to 50 lines may truncate important diagnostic information

## 2. Reliability & Observability

### Stale Label Detection

**Problem**: Container crashes leave `agent:running` labels forever
**Files to change**: `infra/lib/cleanup-handler.ts`, `infra/lib/stack.ts`

**Solution**:
```typescript
// Add to cleanup-handler.ts
async function reconcileStaleLabels(clusterArn: string) {
  // Query ECS for running tasks with agent labels
  // Cross-reference with GitHub issues having agent:running
  // Remove agent:running labels for issues without active ECS tasks
  // Update task metadata to 'failed' status with timeout reason
}
```

**Implementation**:
- Add ECS `DescribeTasks` and `ListTasks` calls to find running agent containers
- Add GitHub API integration to query issues with `agent:running` labels
- Reconcile the two data sources to identify orphaned labels
- Update cleanup-handler to call this reconciliation function
- Increase cleanup frequency to every 30 minutes for faster recovery

### Concurrency Guard

**Problem**: Multiple webhooks create duplicate Fargate tasks for same issue
**Files to change**: `infra/lib/webhook-handler.ts`, `infra/lib/types.ts`

**Solution**:
```typescript
// Add to webhook-handler.ts
async function acquireIssueLock(issueId: string, repoSlug: string): Promise<boolean> {
  const lockKey = `locks/${repoSlug}/${issueId}`;
  try {
    await s3.putObject({
      Bucket: ARTIFACTS_BUCKET,
      Key: lockKey,
      Body: JSON.stringify({ locked_at: new Date().toISOString(), ttl: 60 }),
      IfNoneMatch: '*' // Fail if object exists
    });
    return true;
  } catch (err) {
    return false; // Lock already exists
  }
}
```

**Implementation**:
- Use S3 `IfNoneMatch` condition for atomic lock acquisition
- Lock timeout of 60 seconds with automatic expiration
- Update webhook handler to check/acquire lock before launching tasks
- Add lock cleanup to the cleanup-handler function
- Return HTTP 409 Conflict for concurrent webhook attempts with clear message

### Enhanced Error Diagnostics

**Problem**: Claude Code fails silently with unclear error messages
**Files to change**: `agent/entrypoint.sh`, `infra/lib/types.ts`

**Solution**:
```bash
# Add to entrypoint.sh diagnostic functions
diagnose_github_connectivity() {
  echo "Testing GitHub connectivity..."
  curl -s -o /dev/null -w "HTTP %{http_code} in %{time_total}s" https://api.github.com/user
  gh auth status --hostname github.com or return $?
  gh api user --jq '.login' or return $?
}

diagnose_model_connectivity() {
  echo "Testing OpenRouter connectivity..."
  curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    "https://openrouter.ai/api/v1/models" | jq '.data[0].id // "No models available"'
}
```

**Implementation**:
- Add pre-flight connectivity tests for GitHub API, OpenRouter, and AWS services
- Capture specific error codes and network latency
- Structured error reporting with diagnostic codes for common failure modes
- Enhanced retry logic with exponential backoff for transient network issues

### Success/Failure Dashboards

**Problem**: No visibility into task outcomes or performance trends
**Files to change**: `infra/lib/stack.ts`, new CloudWatch dashboard

**Solution**:
```typescript
// Add to stack.ts
const dashboard = new cloudwatch.Dashboard(this, 'AgentDashboard', {
  dashboardName: 'github-agent-metrics',
  widgets: [
    // Task success/failure rates over time
    // Average task duration by outcome
    // Fargate resource utilization
    // OpenRouter API usage and costs
    // Failed task error code distribution
  ]
});
```

**Implementation**:
- Add CloudWatch custom metrics to webhook handler and cleanup function
- Track task outcomes, duration, resource usage, and error codes
- Create CloudWatch alarms for high failure rates (>20% in 1 hour)
- Add SNS notifications for critical failures or stuck task accumulation
- Weekly cost reports including Fargate, NAT gateway, and OpenRouter usage

## 3. Cost & Performance

### OpenRouter vs Direct Anthropic API

**Current state**: Using OpenRouter for Claude API access
**Trade-offs analysis**:

| Factor | OpenRouter | Direct Anthropic |
|--------|------------|------------------|
| **Cost** | +15-20% markup over direct API | Direct pricing |
| **Authentication** | Simple API key | OAuth 2.0 flow required |
| **Rate limiting** | Shared pools, potential throttling | Dedicated limits |
| **Latency** | +50-100ms proxy overhead | Direct connection |
| **Model availability** | Includes fallback models | Claude models only |
| **Setup complexity** | Low | High (implement OAuth flow) |

**Recommendation**: Evaluate after month 1 metrics. Switch if volume >10k requests/month or latency >95th percentile 2s.

**Files to change**: `agent/entrypoint.sh`, `infra/lib/stack.ts` (SSM parameters)

### Fargate Resource Optimization

**Current allocation**: 2048 MiB memory, 1024 CPU (1 vCPU)
**Right-sizing analysis needed**:

```typescript
// Add to cleanup-handler.ts
async function analyzeResourceUsage() {
  // Query CloudWatch for memory and CPU utilization per task
  // Correlate with task outcomes and duration
  // Generate recommendations for resource adjustments
}
```

**Investigation plan**:
- Monitor memory usage patterns over 200+ tasks
- CPU utilization during git clone, Claude Code execution, and git push phases
- Task failure correlation with resource constraints (OOM kills)
- Cost comparison for 1024/512 CPU vs 2048/1024 current allocation

**Expected outcome**: 15-25% cost reduction with right-sized resources

### NAT Gateway Cost Analysis

**Problem**: Network isolation added NAT gateway costs (~$45/month + data transfer)
**Files to investigate**: VPC flow logs, CloudWatch NAT gateway metrics

**Analysis needed**:
- Data transfer volume per task (git clone + model API calls)
- Cost comparison: NAT gateway + VPC endpoints vs direct internet access
- Alternative architectures (Lambda + Fargate hybrid, VPN, Transit Gateway)

**Break-even calculation**: NAT gateway worthwhile if >100 tasks/month due to VPC endpoint cost savings

### Token Usage Tracking

**Problem**: No visibility into OpenRouter API costs per task
**Files to change**: `agent/entrypoint.sh`, `infra/lib/types.ts`

**Solution**:
```bash
# Add to entrypoint.sh
track_token_usage() {
  local start_tokens=$(curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    "https://openrouter.ai/api/v1/auth/key" | jq '.usage.requests')

  # ... run claude code ...

  local end_tokens=$(curl -s -H "Authorization: Bearer $OPENROUTER_API_KEY" \
    "https://openrouter.ai/api/v1/auth/key" | jq '.usage.requests')

  echo "Token usage: $((end_tokens - start_tokens)) requests"
}
```

**Implementation**:
- Track OpenRouter API usage before/after Claude Code execution
- Store token counts in task metadata for cost allocation
- Weekly cost reports by repository, task type, and success rate
- Alert when approaching OpenRouter rate limits or budget thresholds

## 4. Developer Experience

### Git Push Authentication Fix

**Problem**: Manual troubleshooting required `x-access-token:` URL prefix
**Files to change**: `agent/entrypoint.sh`

**Root cause**: GitHub CLI auth setup doesn't automatically configure git remote URLs for GitHub App tokens

**Solution**:
```bash
# Add to entrypoint.sh after git clone
configure_git_auth() {
  # Automatically configure remote URL with token prefix for authenticated pushes
  local remote_url="https://x-access-token:${GH_TOKEN}@github.com/${REPO_SLUG}.git"
  git remote set-url origin "$remote_url"

  # Test push access before starting main processing
  git ls-remote --exit-code origin >/dev/null 2>&1 || {
    echo "ERROR: Cannot push to repository. Check GitHub App permissions."
    return 1
  }
}
```

**Validation**: Automated test of push access before Claude Code execution begins

### PR Review Workflow Fix

**Problem**: `IS_PR=true` path broken since GitHub App migration
**Files to change**: `agent/entrypoint.sh`, `infra/lib/webhook-handler.ts`

**Issues to resolve**:
1. PR context fetching fails for external contributor PRs
2. Branch modification permissions unclear for fork-based PRs
3. No clear workflow for review comments vs. implementation changes

**Solution**:
```bash
# Add to entrypoint.sh PR handling
handle_pr_context() {
  if [ "$IS_PR" = "true" ]; then
    # Fetch PR diff and metadata with error handling
    PR_DIFF=$(gh pr diff "$ISSUE_NUMBER" -R "$REPO" 2>/dev/null || echo "Error: Cannot access PR diff")
    PR_HEAD_SHA=$(gh pr view "$ISSUE_NUMBER" -R "$REPO" --json headRefOid -q '.headRefOid')

    # Check if this is a fork-based PR (external contributor)
    PR_HEAD_LABEL=$(gh pr view "$ISSUE_NUMBER" -R "$REPO" --json headRepositoryOwner,headRefName -q '.headRepositoryOwner.login + ":" + .headRefName')

    if [[ "$PR_HEAD_LABEL" == *":"* ]] && [[ ! "$PR_HEAD_LABEL" == "$REPO_OWNER:"* ]]; then
      echo "Fork-based PR detected. Review-only mode."
      REVIEW_ONLY_MODE="true"
    fi
  fi
}
```

**Implementation**:
- Detect fork-based PRs to enable review-only mode
- Add clear error handling for permission failures
- Separate review comment logic from code modification logic
- Test with external contributor PR scenarios

### Multi-Repository Support

**Problem**: Agent assumes single repository per GitHub App installation
**Files to change**: `infra/lib/webhook-handler.ts`, `infra/lib/types.ts`

**Solution**:
```typescript
// Add to webhook-handler.ts
async function getRepositoryConfig(repoSlug: string): Promise<RepositoryConfig> {
  // Try to fetch CLAUDE.md from repository
  try {
    const response = await githubRequest(`/repos/${repoSlug}/contents/CLAUDE.md`,
      installationToken, { method: 'GET' }, [200, 404]);

    if (response.status === 200) {
      const content = JSON.parse(await response.text());
      return parseClaudeConfig(Buffer.from(content.content, 'base64').toString());
    }
  } catch (err) {
    console.log(`No CLAUDE.md found for ${repoSlug}, using defaults`);
  }

  return getDefaultConfig();
}
```

**CLAUDE.md format**:
```markdown
# Claude Agent Configuration

## Model Settings
- model: claude-3.5-sonnet
- temperature: 0.1
- max_tokens: 4000

## Repository Rules
- max_task_duration: 30m
- allowed_file_patterns: ["src/**", "tests/**", "docs/**"]
- protected_paths: ["package-lock.json", ".github/workflows/**"]

## Custom Instructions
The agent should follow existing code patterns and maintain compatibility with Node.js 18+.
```

**Implementation**:
- Support GitHub App installations across multiple repositories
- Per-repository configuration via CLAUDE.md files
- Repository-specific model settings, timeouts, and custom instructions
- Fallback to global defaults when CLAUDE.md missing

### Enhanced Issue Templates

**Problem**: Current template insufficient for complex tasks
**Files to change**: `.github/ISSUE_TEMPLATE/agent_task.yml`

**Improvements needed**:
```yaml
# Add to agent_task.yml
- type: textarea
  id: dependencies
  attributes:
    label: "Dependencies & Prerequisites"
    description: "List any dependencies, prerequisites, or blockers"
    placeholder: "- Requires completion of #123\n- Needs access to external API"
  validations:
    required: false

- type: dropdown
  id: effort_estimate
  attributes:
    label: "Effort Estimate"
    description: "Rough complexity estimate for task planning"
    options:
      - "Quick fix (< 30 min)"
      - "Small feature (< 2 hours)"
      - "Medium feature (< 1 day)"
      - "Large feature (> 1 day, consider breaking down)"
  validations:
    required: true

- type: checkboxes
  id: testing_requirements
  attributes:
    label: "Testing Requirements"
    description: "What testing is needed?"
    options:
      - label: "Unit tests required"
      - label: "Integration tests required"
      - label: "Manual testing sufficient"
      - label: "No testing needed"
```

## 5. Security

### GitHub App Permission Audit

**Current permissions** (from GitHub App): contents, pull_requests, issues, metadata
**Audit needed**:

| Permission | Current Scope | Recommended Scope | Justification |
|------------|---------------|-------------------|---------------|
| contents | read/write | read/write | Clone repo, create branches, push changes |
| pull_requests | read/write | read/write | Create PRs, add comments, modify PR branches |
| issues | read/write | read/write | Read issue content, manage labels, add comments |
| metadata | read | read | Access repository basic information |
| actions | none | read | **ADD**: Check CI status before merging (future) |
| checks | none | read/write | **ADD**: Create check runs for task status (future) |

**Recommendations**:
- Add actions:read for future CI integration
- Consider checks:write for native GitHub status reporting
- Regular permission audit every 6 months

### Secret Management Review

**Current secrets** (SSM Parameters):
- `/github-agent/GITHUB_APP_ID` - GitHub App identifier
- `/github-agent/GITHUB_APP_PRIVATE_KEY` - RSA private key for JWT signing
- `/github-agent/GITHUB_WEBHOOK_SECRET` - HMAC webhook validation
- `/github-agent/OPENROUTER_API_KEY` - Model API access

**Recommendations**:
- Add parameter versioning for key rotation
- Implement automatic secret rotation for OpenRouter API key (90 days)
- Add CloudTrail monitoring for SSM parameter access
- Consider AWS Secrets Manager for automatic rotation capabilities

**Files to change**: `infra/lib/stack.ts`, `deploy.sh` documentation

### Container Security Enhancements

**Current**: Node.js 20 base image, non-root user, ephemeral containers
**Missing security controls**:

```dockerfile
# Add to agent/Dockerfile
# Scan for vulnerabilities during build
RUN npm audit --audit-level=high

# Pin specific package versions
RUN npm ci --production --frozen-lockfile

# Remove package manager after installation
RUN npm cache clean --force && rm -rf /tmp/*

# Add security labels
LABEL security.scan-policy="daily"
LABEL security.vulnerability-scan="enabled"
```

**Implementation**:
- Enable ECR vulnerability scanning with daily scans
- Add automated security updates for base image
- Container image signing with AWS Signer
- Regular dependency updates with automated PRs for security patches

## 6. Prioritized Roadmap

### Phase 1: Quick Wins (2-4 weeks)

**High Impact, Low Effort**

1. **Fix git push authentication** (2 days)
   - Add automatic token URL configuration in `agent/entrypoint.sh:configure_git_auth()`
   - Pre-flight push access validation
   - Clear error messages for permission failures

2. **Implement concurrency guard** (3 days)
   - S3-based issue locking in `infra/lib/webhook-handler.ts`
   - Prevent duplicate task launches
   - HTTP 409 responses for concurrent attempts

3. **Enhanced error diagnostics** (1 week)
   - Connectivity pre-flight checks for GitHub API, OpenRouter
   - Structured error codes and diagnostic information
   - Expanded log capture beyond 50 lines

4. **Token usage tracking** (3 days)
   - OpenRouter API usage monitoring per task
   - Cost allocation and budget alerting
   - Weekly spend reports by repository

### Phase 2: Foundation (4-6 weeks)

**Medium Impact, Medium Effort**

5. **Stale label reconciliation** (1 week)
   - ECS task vs GitHub label cross-reference
   - Cleanup orphaned `agent:running` labels
   - More frequent reconciliation (30 min intervals)

6. **Success/failure dashboards** (2 weeks)
   - CloudWatch custom metrics and alarms
   - Task outcome tracking and trend analysis
   - SNS alerting for high failure rates

7. **PR review workflow fix** (1 week)
   - Fix broken `IS_PR=true` execution path
   - Handle fork-based PRs correctly
   - Separate review vs implementation modes

8. **Multi-repository configuration** (2 weeks)
   - CLAUDE.md per-repository settings
   - Repository-specific model and timeout configuration
   - GitHub App multi-repo installation support

### Phase 3: Optimization (6-8 weeks)

**High Impact, High Effort**

9. **Fargate resource optimization** (2 weeks)
   - Monitor resource utilization across 200+ tasks
   - Right-size memory and CPU allocations
   - Cost-performance trade-off analysis

10. **OpenRouter vs Direct API evaluation** (1 week)
    - Performance and cost comparison
    - Implementation of direct Anthropic API option
    - A/B testing framework for API providers

11. **Container security enhancements** (2 weeks)
    - ECR vulnerability scanning automation
    - Container image signing and verification
    - Automated security update pipeline

12. **Advanced observability** (3 weeks)
    - Distributed tracing for task execution
    - Performance profiling and bottleneck identification
    - Automated performance regression detection

### Phase 4: Future Vision (8-12 weeks)

**Future Capabilities**

13. **Advanced workflow integration**
    - GitHub Actions integration for custom CI/CD
    - Multi-step task decomposition and orchestration
    - Cross-repository dependency management

14. **Enhanced model capabilities**
    - Model selection per task complexity
    - Fine-tuned prompts per repository domain
    - Continuous learning from task outcomes

15. **Enterprise features**
    - Multi-tenant repository isolation
    - Advanced cost allocation and chargebacks
    - Enterprise SSO and policy integration

### Dependencies

**Phase 1 → Phase 2**: Error diagnostics inform dashboard metrics design
**Phase 2 → Phase 3**: Performance monitoring guides resource optimization
**All phases**: Security reviews required before production deployment

### Success Metrics

**Phase 1 targets**:
- Task failure rate <15% (currently unknown baseline)
- Git authentication errors eliminated
- Concurrency conflicts <5% of webhook events

**Phase 2 targets**:
- Task completion visibility for 100% of runs
- Stale label duration <30 minutes
- PR workflow success rate >90%

**Phase 3 targets**:
- 20-30% cost reduction through resource optimization
- Task duration P95 <20 minutes
- Security vulnerability resolution <48 hours

This roadmap prioritizes reliability and developer experience improvements first, followed by cost optimization and advanced features. Each phase builds upon previous improvements while delivering immediate value to platform users.