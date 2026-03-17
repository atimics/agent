import * as github from "./github.js";
import { chat, type Message, type ToolDefinition, type ToolCall } from "./llm.js";

const MAX_ITERATIONS = 10;

interface AgentConfig {
  githubToken: string;
  openrouterKey: string;
  owner: string;
  repo: string;
  issueNumber: number;
  isPR: boolean;
  action: string;
}

const TOOLS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read a file from the repository. Returns the file content as a string. For directories, returns a listing of entries.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path to the file or directory relative to the repo root. Use "" or "." for the root.',
          },
          ref: {
            type: "string",
            description: "Git ref (branch/tag/sha) to read from. Defaults to the default branch.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_files",
      description:
        "List files in a directory of the repository. Returns an array of file/directory entries.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description:
              'Path to the directory relative to the repo root. Use "" or "." for the root.',
          },
          ref: {
            type: "string",
            description: "Git ref to list from. Defaults to the default branch.",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "create_pr",
      description:
        "Create a pull request with one or more file changes. Provide the files to create or modify.",
      parameters: {
        type: "object",
        properties: {
          title: {
            type: "string",
            description: "Pull request title.",
          },
          body: {
            type: "string",
            description: "Pull request description in Markdown.",
          },
          branch_name: {
            type: "string",
            description:
              "Name for the new branch (no refs/heads/ prefix). e.g. 'fix/issue-42'.",
          },
          files: {
            type: "array",
            description: "Array of files to create or update.",
            items: {
              type: "object",
              properties: {
                path: {
                  type: "string",
                  description: "File path relative to repo root.",
                },
                content: {
                  type: "string",
                  description: "Full file content.",
                },
                commit_message: {
                  type: "string",
                  description: "Commit message for this file change.",
                },
              },
              required: ["path", "content", "commit_message"],
            },
          },
        },
        required: ["title", "body", "branch_name", "files"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "post_comment",
      description:
        "Post a comment on the issue or pull request. Use this to ask for clarification or provide updates.",
      parameters: {
        type: "object",
        properties: {
          body: {
            type: "string",
            description: "Comment body in Markdown.",
          },
        },
        required: ["body"],
      },
    },
  },
];

function buildSystemPrompt(config: AgentConfig): string {
  const type = config.isPR ? "pull request" : "issue";
  return `You are a GitHub agent. You have been triggered by the "agent" label on ${type} #${config.issueNumber} in ${config.owner}/${config.repo}.

Your capabilities:
- Read files from the repository using read_file or list_files
- Create pull requests with code changes using create_pr
- Post comments on the issue/PR using post_comment

Guidelines:
- If the issue/PR clearly describes a task you can complete (bug fix, feature, refactor), read the relevant files, understand the codebase, and create a PR with minimal, focused changes.
- If you need more information to proceed, post a single concise comment asking for clarification, then stop. The user will add the "agent" label again after responding.
- Be concise in comments. Include code snippets when relevant.
- When creating a PR, make minimal, focused changes. Don't refactor unrelated code.
- Reference the issue number in your PR body (e.g., "Fixes #${config.issueNumber}").
- Always read relevant files before making changes to understand the existing code style and structure.
- If this is a PR (not an issue), review the diff and provide feedback or make improvements.`;
}

async function executeToolCall(
  config: AgentConfig,
  toolCall: ToolCall
): Promise<string> {
  const name = toolCall.function.name;
  let args: Record<string, any>;
  try {
    args = JSON.parse(toolCall.function.arguments);
  } catch {
    return JSON.stringify({ error: "Invalid JSON in tool arguments" });
  }

  console.log(`  Tool call: ${name}(${JSON.stringify(args).slice(0, 200)})`);

  try {
    switch (name) {
      case "read_file": {
        const result = await github.getRepoContent(
          config.githubToken,
          config.owner,
          config.repo,
          args.path || "",
          args.ref
        );
        if ("entries" in result) {
          return JSON.stringify(result.entries, null, 2);
        }
        // Truncate very large files
        const content = result.content;
        if (content.length > 30000) {
          return content.slice(0, 30000) + "\n\n... [truncated, file too large]";
        }
        return content;
      }

      case "list_files": {
        const result = await github.getRepoContent(
          config.githubToken,
          config.owner,
          config.repo,
          args.path || "",
          args.ref
        );
        if ("entries" in result) {
          return JSON.stringify(result.entries, null, 2);
        }
        return JSON.stringify({ type: "file", message: "Path is a file, not a directory" });
      }

      case "create_pr": {
        const { title, body, branch_name, files } = args;
        const defaultBranch = await github.getDefaultBranch(
          config.githubToken,
          config.owner,
          config.repo
        );

        // Create branch
        await github.createBranch(
          config.githubToken,
          config.owner,
          config.repo,
          defaultBranch.sha,
          branch_name
        );
        console.log(`  Created branch: ${branch_name}`);

        // Commit files
        for (const file of files) {
          await github.createOrUpdateFile(
            config.githubToken,
            config.owner,
            config.repo,
            branch_name,
            file.path,
            file.content,
            file.commit_message
          );
          console.log(`  Committed: ${file.path}`);
        }

        // Create PR
        const pr = await github.createPullRequest(
          config.githubToken,
          config.owner,
          config.repo,
          title,
          body,
          branch_name,
          defaultBranch.name
        );
        console.log(`  Created PR: ${pr.html_url}`);

        return JSON.stringify({
          success: true,
          pr_number: pr.number,
          pr_url: pr.html_url,
        });
      }

      case "post_comment": {
        const result = await github.postComment(
          config.githubToken,
          config.owner,
          config.repo,
          config.issueNumber,
          args.body
        );
        console.log(`  Posted comment: ${result.html_url}`);
        return JSON.stringify({ success: true, comment_url: result.html_url });
      }

      default:
        return JSON.stringify({ error: `Unknown tool: ${name}` });
    }
  } catch (err: any) {
    console.error(`  Tool error: ${err.message}`);
    return JSON.stringify({ error: err.message });
  }
}

export async function runAgent(config: AgentConfig): Promise<void> {
  console.log(
    `Agent starting for ${config.owner}/${config.repo}#${config.issueNumber} (isPR=${config.isPR})`
  );

  // Fetch issue/PR context
  let contextText: string;
  if (config.isPR) {
    const pr = await github.getPullRequest(
      config.githubToken,
      config.owner,
      config.repo,
      config.issueNumber
    );
    contextText = [
      `## Pull Request #${pr.number}: ${pr.title}`,
      `State: ${pr.state}`,
      `Labels: ${pr.labels.join(", ") || "none"}`,
      `Base: ${pr.base.ref} <- Head: ${pr.head.ref}`,
      "",
      "### Description",
      pr.body || "(no description)",
      "",
      "### Diff",
      pr.diff.length > 20000
        ? pr.diff.slice(0, 20000) + "\n... [diff truncated]"
        : pr.diff,
      "",
      "### Comments",
      ...pr.comments.map(
        (c) => `**${c.user}** (${c.created_at}):\n${c.body}\n`
      ),
    ].join("\n");
  } else {
    const issue = await github.getIssue(
      config.githubToken,
      config.owner,
      config.repo,
      config.issueNumber
    );
    contextText = [
      `## Issue #${issue.number}: ${issue.title}`,
      `State: ${issue.state}`,
      `Labels: ${issue.labels.join(", ") || "none"}`,
      "",
      "### Description",
      issue.body || "(no description)",
      "",
      "### Comments",
      ...issue.comments.map(
        (c) => `**${c.user}** (${c.created_at}):\n${c.body}\n`
      ),
    ].join("\n");
  }

  console.log("Context loaded. Starting agentic loop...");

  const messages: Message[] = [
    { role: "system", content: buildSystemPrompt(config) },
    { role: "user", content: contextText },
  ];

  let commentPosted = false;
  let prCreated = false;

  for (let i = 0; i < MAX_ITERATIONS; i++) {
    console.log(`\nIteration ${i + 1}/${MAX_ITERATIONS}`);

    const response = await chat(config.openrouterKey, messages, { tools: TOOLS });

    // If no tool calls, we're done
    if (response.tool_calls.length === 0) {
      console.log("LLM returned text response, finishing.");
      // If there's a final text and we haven't posted a comment or PR, post it
      if (response.content && !commentPosted && !prCreated) {
        console.log("Posting final response as comment...");
        await github.postComment(
          config.githubToken,
          config.owner,
          config.repo,
          config.issueNumber,
          response.content
        );
        commentPosted = true;
      }
      break;
    }

    // Add assistant message with tool calls
    messages.push({
      role: "assistant",
      content: response.content ?? "",
      tool_calls: response.tool_calls,
    });

    // Execute each tool call
    for (const toolCall of response.tool_calls) {
      const result = await executeToolCall(config, toolCall);

      if (toolCall.function.name === "post_comment") {
        commentPosted = true;
      }
      if (toolCall.function.name === "create_pr") {
        prCreated = true;
      }

      messages.push({
        role: "tool",
        content: result,
        tool_call_id: toolCall.id,
      });
    }
  }

  // Remove the "agent" label so it can be re-triggered
  try {
    await github.removeLabel(
      config.githubToken,
      config.owner,
      config.repo,
      config.issueNumber,
      "agent"
    );
    console.log('Removed "agent" label.');
  } catch {
    console.log('Could not remove "agent" label (may not exist).');
  }

  console.log("Agent finished.");
}
