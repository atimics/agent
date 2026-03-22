# GitHub Agent

Fargate container that runs Claude Code on GitHub issues/PRs.

## Quick Start

To trigger the agent on an issue or PR:
1. Add the `agent` label to any issue or PR
2. The agent will automatically remove the `agent` label and add `agent:running`
3. When complete, the agent will create a PR (for issues) or comment (for PRs)
4. Final status will be shown with `agent:succeeded` or `agent:failed`

## Architecture

- **Webhook Handler** (`infra/lib/webhook-handler.ts`) - Listens for `agent` label events
- **Agent Container** - Runs Claude Code in AWS Fargate
- **Infrastructure** - AWS CDK deployment in `infra/`

For security architecture and isolation controls, see [SECURITY.md](./SECURITY.md).

## Agent Workflow

### Label Semantics

The agent uses a trigger + status label system:

**Trigger Label:**
- `agent` - Activates the agent (automatically removed when processing starts)

**Status Labels:**
- `agent:running` - Agent is currently processing the issue/PR
- `agent:waiting` - Agent needs more information (re-add `agent` label to continue)
- `agent:failed` - Agent encountered an error and could not complete
- `agent:succeeded` - Agent completed successfully

### Expected Outputs

**For Issues:**
- Agent creates a new branch with implementing changes
- Agent creates a PR that links back to the original issue
- PR title follows format: "Implement #<issue-number>: <summary>"
- PR description includes "Fixes #<issue-number>"

**For Pull Requests:**
- Agent adds comments with review feedback or requested changes
- Agent may push commits to the PR branch if modifications are needed

### Retry Behavior

- **Failed Tasks**: Re-add the `agent` label to retry
- **Waiting Tasks**: Provide the requested clarification, then re-add `agent` label
- **Manual Stop**: Remove all agent labels to cancel a running task

## Best Practices

### Writing Effective Agent Issues

1. **Clear Problem Statement**: Describe what needs to be implemented or fixed
2. **Acceptance Criteria**: List specific requirements for completion
3. **Context**: Reference relevant files, functions, or existing behavior
4. **Constraints**: Mention any technical requirements or limitations

### Examples

**Good Issue:**
```
## Problem
The API returns 500 errors when users try to delete non-existent resources.

## Acceptance Criteria
- DELETE /api/resources/{id} returns 404 for non-existent resources
- Error response includes helpful message: "Resource {id} not found"
- Add test case covering this scenario

## Context
- Current behavior: `deleteResource()` in `src/api/resources.ts:45`
- Related issue: #123 (similar pattern for PATCH endpoints)
```

**Needs Improvement:**
```
Fix the delete bug
```

## Troubleshooting

- **Agent Not Triggering**: Ensure the `agent` label exists in your repository
- **Webhook Issues**: Check AWS CloudWatch logs for the webhook handler Lambda
- **Task Failures**: Look at the `agent:failed` status comment for error details
- **Long Running Tasks**: Agent has a 30-minute timeout for safety