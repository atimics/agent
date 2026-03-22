# Cenetex Agent Platform — Independent Assessment

**Author:** Claude Opus 4.6 (external review, not the agent under evaluation)
**Date:** 2026-03-21
**Scope:** Architecture, reliability, cost, security, and strategic positioning of `cenetex/agent`

---

## 1. Executive Summary

The agent platform is a scale-to-zero autonomous coding system that converts GitHub issues into pull requests using Claude Code running in AWS Fargate containers. In a single session, the system went from broken (wrong API key, template bugs, no retry logic) to self-improving — executing its own 6-issue backlog and producing 7 merged PRs.

The architecture is sound for a v1. The main risks are operational (no stale-run detection, no concurrency guard, blind trust in LLM output) and financial (OpenRouter markup, NAT gateway idle costs). The system is ready for controlled use on low-stakes tasks but needs guardrails before handling anything production-critical.

---

## 2. Architecture Review

### What Exists

```
GitHub Issue (labeled "agent")
    │
    ▼
API Gateway → Lambda (webhook-handler.ts)
    │  - Verifies webhook signature
    │  - Mints GitHub App installation token
    │  - Resolves commit SHA
    │  - Constructs TaskPayload JSON
    │  - Launches Fargate task
    │
    ▼
ECS Fargate Container (entrypoint.sh)
    │  - Parses task payload
    │  - Authenticates via GH_TOKEN
    │  - Clones repo at resolved SHA
    │  - Fetches issue/PR context
    │  - Runs Claude Code via OpenRouter
    │  - Verifies output (PR created? Question asked?)
    │  - Uploads artifacts to S3
    │  - Updates labels (succeeded/failed/waiting)
    │
    ▼
Pull Request (or failure comment with logs)
```

### Strengths

| Aspect | Assessment |
|--------|-----------|
| **Event-driven** | Zero idle compute cost. Lambda + Fargate scale to zero. No servers to manage. |
| **GitHub-native control plane** | Issues = task queue, labels = state machine, PRs = output. No custom UI, no database. Operators use tools they already know. |
| **Immutable task contract** | Each run pins to a resolved commit SHA. Deterministic, replayable. Good engineering. |
| **Self-contained deployment** | Single CDK stack, one Docker image, one workflow. Easy to reason about, easy to destroy and recreate. |
| **GitHub App auth** | Scoped permissions, auto-rotating tokens, proper bot identity. Better than PAT in every way. |

### Weaknesses

| Aspect | Assessment | Severity |
|--------|-----------|----------|
| **Fire-and-forget Fargate** | Lambda launches the task and forgets. If the container OOMs, gets spot-reclaimed, or hits a network partition, the issue stays `agent:running` forever. No watchdog. | **High** |
| **No concurrency guard** | Labeling an issue `agent` twice launches two containers racing on the same issue. Both clone, both try to create PRs, both flip labels. | **High** |
| **Single-shot LLM** | One `claude --print` call must do everything: read codebase, plan, code, test, commit, push, create PR. No iterative refinement, no tool-use loop beyond what Claude Code does internally. | **Medium** |
| **Verify step is a proxy** | "Did a PR appear?" ≠ "Is the code correct?" The agent gets `succeeded` for creating any PR, regardless of quality. | **Medium** |
| **No memory across runs** | Each task starts from zero context. The agent can't learn from previous failures or build cumulative understanding of the codebase. | **Medium** |
| **OpenRouter dependency** | Adds latency, cost markup (~20-30%), and a single point of failure. One credit shortfall halted all operations today. | **Medium** |
| **Git push auth fragility** | `gh repo clone` doesn't always embed the token in the remote URL for App installation tokens. The agent needed a manual hint to push. This will bite every issue-type task. | **High** |

---

## 3. Reliability Analysis

### Failure Modes Observed Today

| Failure | Root Cause | Time to Diagnose | Fix |
|---------|-----------|-----------------|-----|
| Agent produces nothing | OpenRouter 402 (insufficient credits) | 3 runs before logs revealed it | New API key |
| PR #9 context fetch | `gh pr view` fails silently in container | Never fully diagnosed | Closed stale PR |
| Deploy OIDC failure | Trust policy referenced old `atimics/agent` repo | 1 run | Updated IAM policy |
| App token auth check | `gh api user` returns 403 for App tokens | 1 run + Lambda logs | Replaced with `gh repo view` |
| Agent can't push branches | App token not in git remote URL | Agent asked for help | Manual hint (not yet fixed in entrypoint) |

### Unobserved Failure Modes (Predicted)

1. **Container timeout/OOM** — 2GB RAM, 1 vCPU. Large repos or complex tasks will exhaust resources. No monitoring.
2. **Stale running label** — If container dies without reaching `on_exit` trap (SIGKILL, OOM), label stays `agent:running` indefinitely.
3. **Race condition on label swap** — The Lambda sets `agent:running` before launching Fargate. If Fargate launch fails after this point, the label is stuck (partially mitigated by the catch block).
4. **S3 artifact upload failure** — The new artifact system uses `|| true` on all S3 ops. Silent failure means no artifacts and no indication they're missing.
5. **OpenRouter rate limits** — No retry-with-backoff on 429s. Claude Code may handle this internally but it's unverified.

### Recommended Reliability Fixes (Priority Order)

1. **Fix git push auth** — Add `git remote set-url origin "https://x-access-token:${GITHUB_TOKEN}@github.com/${REPO}.git"` after clone in entrypoint. This is blocking every issue-type task from reliably creating PRs.
2. **Add stale-run sweeper** — Scheduled Lambda (every 15 min) that queries for `agent:running` labels older than 30 minutes and flips them to `agent:failed` with a timeout comment.
3. **Add concurrency guard** — In webhook handler, check if `agent:running` already exists on the issue before launching. Return 200 with "already running" message.
4. **Add Fargate task callback** — Use ECS task state change events (EventBridge) to detect container exits and update labels even if the trap didn't fire.

---

## 4. Cost Analysis

### Current Per-Run Costs

| Component | Cost per Run | Notes |
|-----------|-------------|-------|
| Fargate (2GB, 1vCPU, ~5-10 min) | ~$0.01-0.02 | On-demand Linux/ARM |
| OpenRouter (Sonnet 4, ~50K tokens) | ~$0.50-2.00 | Varies by task complexity |
| Lambda invocations | ~$0.0001 | Negligible |
| S3 artifacts | ~$0.0001 | Negligible |
| **Total per run** | **~$0.50-2.00** | Dominated by LLM cost |

### Monthly Fixed Costs

| Component | Monthly Cost | Notes |
|-----------|-------------|-------|
| NAT Gateway (from PR #21) | ~$32-45 | $0.045/hr + data processing. **This is the biggest idle cost.** |
| VPC Endpoints (4 interface endpoints) | ~$29 | $0.01/hr each. Added in PR #21. |
| ECR storage | ~$1 | 5 images retained |
| S3 storage | <$1 | 30-day lifecycle |
| **Total idle cost** | **~$62-76/month** | Before PR #21: ~$0/month |

### Cost Concern

PR #21 (isolation/private subnets) increased idle costs from near-zero to ~$70/month. For an agent that might run a few times a day, the NAT gateway and VPC endpoints cost more than the actual compute. Consider:
- Reverting to public subnets with security group lockdown (inbound denied, outbound scoped) — cheaper, nearly as secure for this use case
- Or using NAT instances instead of NAT gateway ($3-5/month on t4g.nano)

---

## 5. Security Assessment

### Good

- Webhook signature verification (HMAC-SHA256)
- GitHub App with scoped permissions (not a broad PAT)
- Secrets in SSM Parameter Store with encryption
- OIDC federation for deploys (no long-lived AWS credentials)
- Container runs as non-root user
- `--dangerously-skip-permissions` is appropriate for isolated containers

### Concerns

| Risk | Severity | Mitigation |
|------|----------|-----------|
| **Agent can push arbitrary code** | Medium | Human review before merge. Never auto-merge. |
| **OpenRouter sees all code** | Medium | All repo content passes through OpenRouter's proxy. Consider direct Anthropic API for sensitive repos. |
| **No container image scanning** | Low | Dockerfile installs latest `gh`, `claude-code`, `node:20`. No pinning, no vulnerability scanning. |
| **GITHUB_TOKEN in container env** | Low | Standard pattern, but the token is visible in ECS task definition overrides (CloudTrail logs). |
| **No network egress filtering** | Low | Container can reach any internet host. Fine for now, but consider egress filtering for sensitive workloads. |

---

## 6. Strategic Assessment

### What This System Actually Is

This is not just a CI bot. It's a **minimal autonomous software engineering platform**. The pattern — structured task input, isolated execution, verified output, human review gate — is the correct architecture for AI-assisted development. Most "AI coding" tools are either:
- IDE copilots (reactive, no autonomy)
- Chatbots with file access (no execution isolation)
- Heavy platforms like Devin (expensive, opaque)

This system sits in a sweet spot: autonomous enough to work unsupervised, transparent enough to review via normal GitHub workflow, cheap enough to run on side projects.

### What Would Make It Dangerous (in a good way)

1. **Per-repo CLAUDE.md** — Give the agent persistent instructions per repository. It reads the repo's CLAUDE.md as context, accumulates knowledge about conventions, known issues, and architectural decisions. This turns stateless runs into a learning system.

2. **Task chaining** — One issue's output triggers the next. "Implement feature X" → agent creates PR → on merge, auto-creates "Write tests for feature X" issue → agent runs again. This is how you get multi-step autonomous workflows.

3. **Multi-repo operation** — The GitHub App is already installed org-wide. The webhook handler already parses `repoOwner/repoName` from the payload. You're one webhook registration away from the agent working across every cenetex repo.

4. **Self-review** — Before creating a PR, the agent runs itself as a reviewer on its own diff. Two-pass: write code, then critique code. Would catch many of the "garbage PR that still gets `succeeded`" cases.

5. **Feedback loop on merge/close** — If a PR is merged, record what the agent did right. If closed without merge, record why. Feed this back into future prompts. This is how you get compound improvement.

### What to Avoid

- **Auto-merging** — The human review gate is the most important safety mechanism. Removing it turns a useful tool into a liability.
- **Over-engineering the platform** — The system works because it's simple. Every abstraction layer (task queues, databases, custom UIs) adds complexity that the agent itself can't debug.
- **Running on production codebases without guardrails** — The agent pushes to branches, not main. Keep it that way. Branch protection rules are your last line of defense.

---

## 7. Recommended Next Steps

### Phase 1 — Stabilize (This Week)
1. Fix git push auth in entrypoint (systemic, blocks all issue tasks)
2. Add concurrency guard in webhook handler
3. Add stale-run sweeper Lambda
4. Consider reverting NAT gateway to reduce idle costs

### Phase 2 — Improve (Next 2 Weeks)
5. Switch from OpenRouter to direct Anthropic API
6. Fix the PR review path (IS_PR=true)
7. Add per-repo CLAUDE.md support to the mission prompt
8. Pin Docker base image and add vulnerability scanning

### Phase 3 — Scale (Next Month)
9. Register webhook on additional cenetex repos
10. Implement task chaining (merge → auto-create follow-up issue)
11. Add self-review pass before PR creation
12. Build a simple status dashboard from S3 artifacts

---

*This assessment reflects the state of `cenetex/agent` as of commit `14c6a2c` (2026-03-21). The agent's own upgrade plan (issue #22) may overlap with or diverge from these recommendations — comparing the two would be a useful exercise.*
