# GitHub Agent

Fargate container that runs Claude Code on GitHub issues/PRs.

## Agent Label System

**Operator Note**: The `agent` label is a trigger label that activates the GitHub agent. The agent's current state is shown separately through status labels:

- `agent:running` - Agent is currently processing the issue/PR
- `agent:waiting` - Agent is waiting for additional input or clarification
- `agent:failed` - Agent encountered an error and could not complete the task

To activate the agent on an issue or PR, simply add the `agent` label. To resume a waiting agent, re-add the `agent` label after providing the requested clarification.