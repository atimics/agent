# GitHub Agent

An automated agent system that responds to GitHub issues and pull requests to perform software engineering tasks.

## Quick Start

1. **Deploy the infrastructure**: Run `./deploy.sh` to set up the webhook handler and agent container
2. **Configure GitHub webhook**: Follow the setup instructions in the deploy output
3. **Trigger the agent**: Add the `agent` label to any issue or pull request
4. **Monitor progress**: The agent will update labels and post comments during execution
5. **Review results**: The agent will create pull requests or provide status updates

## How It Works

### Architecture

The system consists of three main components:

- **Webhook Handler** (`infra/lib/webhook-handler.ts`): AWS Lambda function that processes GitHub webhooks
- **Agent Container** (`agent/`): Docker container running Claude Code that performs the actual work
- **Infrastructure** (`infra/`): AWS CDK stack managing Lambda, ECS, SSM parameters, and IAM roles

### Agent Workflow

#### Triggering the Agent

The agent is triggered by adding the `agent` label to:
- **Issues**: For general tasks, bug fixes, feature requests, or documentation
- **Pull Requests**: For code review, optimization, or refinement tasks

#### Label Lifecycle

| Label | Description | When Applied |
|-------|-------------|--------------|
| `agent` | Trigger label | Added by user to start agent |
| `agent:running` | Agent is actively working | Set when container starts |
| `agent:waiting` | Agent is pausing for confirmation | Set when agent needs user input |
| `agent:succeeded` | Task completed successfully | Set on successful completion |
| `agent:failed` | Task failed or errored | Set on failure or timeout |

The `agent` trigger label is automatically removed when the agent starts, and one of the status labels is applied.

#### Workflow Diagram

```
GitHub Issue/PR + agent label
           ↓
    Webhook Handler (Lambda)
           ↓
    Agent Container (ECS Fargate)
           ↓
    ┌─── agent:running ────┐
    │                     │
    │   Claude Code       │
    │   performs task     │
    │                     │
    └─────────────────────┘
           ↓
    ┌─ Success ─┐     ┌─ Waiting ─┐     ┌─ Failure ─┐
    │           │     │           │     │           │
    │  Creates  │     │  Posts    │     │  Posts    │
    │  PR and   │     │  comment  │     │  error    │
    │  comments │     │  asking   │     │  message  │
    │           │     │  for user │     │           │
    │           │     │  input    │     │           │
    └───────────┘     └───────────┘     └───────────┘
           │                 │                 │
           ▼                 ▼                 ▼
   agent:succeeded   agent:waiting    agent:failed
```

#### Expected Outputs

When successful, the agent typically:
- Creates a pull request with the implemented changes
- Links the PR to the original issue with "Fixes #N"
- Posts a summary comment on the issue
- Applies the `agent:succeeded` label

For complex tasks, the agent may:
- Ask clarifying questions via comments
- Request approval before proceeding with destructive operations
- Break large tasks into smaller steps across multiple runs

#### Retry Behavior

- **To retry a failed task**: Remove the `agent:failed` label and re-add the `agent` label
- **To resume a waiting task**: Respond to the agent's question in a comment, then re-add the `agent` label
- **To cancel a running task**: The container will timeout after ~15 minutes, applying `agent:failed`

## Writing Effective Agent Tasks

### Issue Structure

Use the [agent task template](.github/ISSUE_TEMPLATE/agent_task.yml) for structured requests, or follow this format:

```markdown
## Problem Statement
Clear description of what needs to be done

## Acceptance Criteria
- [ ] Specific, testable requirements
- [ ] Expected behavior or outputs

## Context
- Relevant files: `path/to/file.ts`, `src/components/`
- Related issues/PRs: #123, #456
- Technical constraints or preferences

## Additional Requirements
Any constraints, coding standards, or special considerations
```

### Best Practices

#### ✅ Good Agent Tasks
- **Specific scope**: "Add dark mode toggle to the Settings component"
- **Clear acceptance criteria**: "Toggle should persist user preference and update all UI components"
- **Sufficient context**: "Use existing theme system in `src/theme.ts`"
- **Focused objectives**: One main goal per issue

#### ❌ Problematic Agent Tasks
- **Too vague**: "Make the app better"
- **Too broad**: "Rewrite the entire frontend"
- **Missing context**: "Fix the bug" (without specifying which bug)
- **Conflicting requirements**: Multiple unrelated changes in one task

#### Task Sizing Guidelines

| Size | Scope | Examples |
|------|-------|----------|
| **Small** | Single file, <50 lines changed | Bug fixes, small features, documentation updates |
| **Medium** | Multiple files, ~50-200 lines | New components, API endpoints, test suites |
| **Large** | Cross-cutting changes, >200 lines | Architecture changes, major features, refactoring |

**Recommendation**: Start with small-to-medium tasks to build confidence in the agent's capabilities.

## Configuration

### Environment Variables

The agent requires these SSM parameters:
- `/github-agent/GITHUB_TOKEN`: GitHub Personal Access Token with repo permissions
- `/github-agent/GITHUB_WEBHOOK_SECRET`: Secret for webhook authentication
- `/github-agent/OPENROUTER_API_KEY`: API key for the Claude model

### Custom Labels

You can customize trigger and status labels by modifying:
- `infra/lib/webhook-handler.ts`: Lambda environment variables
- `agent/entrypoint.sh`: Container environment variables

## Troubleshooting

### Common Issues

**Agent doesn't trigger**
- Verify the `agent` label exists in your repository
- Check webhook configuration and secret match
- Review AWS Lambda logs in CloudWatch

**Agent fails immediately**
- Check SSM parameters are set correctly
- Verify ECS task has necessary permissions
- Review container logs in CloudWatch

**Agent gets stuck**
- Tasks timeout after ~15 minutes
- Re-add the `agent` label to retry
- Check for permission prompts in tool usage

**Unexpected behavior**
- Agent operates within repository permissions
- Review the specific task description for clarity
- Check for competing changes in the same files

### Debugging Steps

1. **Check webhook delivery**: Go to repository Settings → Webhooks and verify recent deliveries
2. **Review Lambda logs**: Check CloudWatch logs for the webhook handler function
3. **Monitor ECS tasks**: Look for task failures in the ECS console
4. **Examine agent logs**: Check CloudWatch logs for the agent container
5. **Validate permissions**: Ensure GitHub token and AWS IAM roles have required access

### Getting Help

- **GitHub Issues**: Create an issue in this repository for bugs or feature requests
- **Task-specific questions**: Comment on the issue where the agent is working
- **Infrastructure problems**: Check AWS documentation for ECS/Lambda troubleshooting

## Development

### Local Development

```bash
# Install dependencies
cd infra && npm install
cd ../agent && npm install

# Deploy to AWS
./deploy.sh

# Test webhook locally (optional)
cd infra && npm run test
```

### Customizing the Agent

The agent behavior is defined in:
- `agent/entrypoint.sh`: Container orchestration and GitHub integration
- Webhook handler: Event processing and task triggering
- CDK infrastructure: AWS resources and permissions

### Contributing

1. Fork the repository
2. Create a feature branch
3. Test your changes with small agent tasks
4. Submit a pull request with clear description

---

**Need help?** Create an issue with the `agent` label, and the system will demonstrate itself! ✨