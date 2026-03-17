import { runAgent } from "./agent.js";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return value;
}

async function main() {
  const githubToken = requireEnv("GITHUB_TOKEN");
  const openrouterKey = requireEnv("OPENROUTER_API_KEY");
  const owner = requireEnv("REPO_OWNER");
  const repo = requireEnv("REPO_NAME");
  const issueNumber = parseInt(requireEnv("ISSUE_NUMBER"), 10);
  const isPR = process.env.IS_PR === "true";
  const action = process.env.ACTION || "labeled";

  if (isNaN(issueNumber)) {
    console.error("ISSUE_NUMBER must be a valid integer");
    process.exit(1);
  }

  console.log(`GitHub Agent starting...`);
  console.log(`  Repo: ${owner}/${repo}`);
  console.log(`  Issue/PR: #${issueNumber} (isPR=${isPR})`);
  console.log(`  Action: ${action}`);

  try {
    await runAgent({
      githubToken,
      openrouterKey,
      owner,
      repo,
      issueNumber,
      isPR,
      action,
    });
    console.log("Agent completed successfully.");
    process.exit(0);
  } catch (err: any) {
    console.error(`Agent failed: ${err.message}`);
    console.error(err.stack);
    process.exit(1);
  }
}

main();
