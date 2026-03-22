import {
  ECSClient,
  DescribeTasksCommand,
  StopTaskCommand,
  ListTasksCommand,
} from "@aws-sdk/client-ecs";
import {
  S3Client,
  GetObjectCommand,
  PutObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import type { TaskMetadata } from "./types";

const ecs = new ECSClient({});
const s3 = new S3Client({});

const CLUSTER_ARN = process.env.CLUSTER_ARN!;
const TASK_DEFINITION_ARN = process.env.TASK_DEFINITION_ARN!;
const ARTIFACTS_BUCKET = process.env.ARTIFACTS_BUCKET!;

// Tasks older than this are considered stale
const STALE_TASK_THRESHOLD_MINUTES = 60; // 1 hour

interface CleanupStats {
  tasksChecked: number;
  staleTasks: number;
  stoppedTasks: number;
  metadataUpdated: number;
  errors: string[];
}

async function getTaskMetadata(metadataKey: string): Promise<TaskMetadata | null> {
  try {
    const result = await s3.send(new GetObjectCommand({
      Bucket: ARTIFACTS_BUCKET,
      Key: metadataKey,
    }));

    if (!result.Body) return null;

    const content = await result.Body.transformToString();
    return JSON.parse(content) as TaskMetadata;
  } catch (error) {
    console.error(`Failed to get metadata ${metadataKey}:`, error);
    return null;
  }
}

async function updateTaskMetadata(metadata: TaskMetadata): Promise<void> {
  const metadataKey = `${metadata.artifact_prefix}/metadata.json`;

  await s3.send(new PutObjectCommand({
    Bucket: ARTIFACTS_BUCKET,
    Key: metadataKey,
    Body: JSON.stringify(metadata, null, 2),
    ContentType: "application/json",
    Metadata: {
      taskId: metadata.task_id,
      repoSlug: metadata.repo_slug,
      issueNumber: metadata.issue_number.toString(),
      status: metadata.status,
    },
  }));
}

async function findStaleTaskMetadata(): Promise<TaskMetadata[]> {
  const staleThreshold = new Date(Date.now() - STALE_TASK_THRESHOLD_MINUTES * 60 * 1000);
  const staleMetadata: TaskMetadata[] = [];

  try {
    let continuationToken: string | undefined;

    do {
      const listResult = await s3.send(new ListObjectsV2Command({
        Bucket: ARTIFACTS_BUCKET,
        Prefix: "tasks/",
        ContinuationToken: continuationToken,
        MaxKeys: 1000,
      }));

      if (listResult.Contents) {
        // Filter for metadata.json files
        const metadataKeys = listResult.Contents
          .filter((obj: any) => obj.Key?.endsWith('/metadata.json'))
          .map((obj: any) => obj.Key!);

        // Check each metadata file
        for (const metadataKey of metadataKeys) {
          const metadata = await getTaskMetadata(metadataKey);
          if (!metadata) continue;

          // Check if task is stale and still in a running state
          if (metadata.status === "running" &&
              metadata.created_at &&
              new Date(metadata.created_at) < staleThreshold) {
            staleMetadata.push(metadata);
          }
        }
      }

      continuationToken = listResult.NextContinuationToken;
    } while (continuationToken);

  } catch (error) {
    console.error("Failed to list task metadata:", error);
  }

  return staleMetadata;
}

async function isTaskStillRunning(taskArn: string): Promise<boolean> {
  try {
    const result = await ecs.send(new DescribeTasksCommand({
      cluster: CLUSTER_ARN,
      tasks: [taskArn],
    }));

    const task = result.tasks?.[0];
    if (!task) return false;

    return task.lastStatus === "RUNNING";
  } catch (error) {
    console.error(`Failed to describe task ${taskArn}:`, error);
    return false;
  }
}

async function stopTask(taskArn: string): Promise<boolean> {
  try {
    await ecs.send(new StopTaskCommand({
      cluster: CLUSTER_ARN,
      task: taskArn,
      reason: "Task exceeded time limit and was terminated by cleanup process",
    }));

    console.log(`Stopped stale task: ${taskArn}`);
    return true;
  } catch (error) {
    console.error(`Failed to stop task ${taskArn}:`, error);
    return false;
  }
}

export async function handler(): Promise<CleanupStats> {
  console.log("Starting cleanup process for stale agent tasks");

  const stats: CleanupStats = {
    tasksChecked: 0,
    staleTasks: 0,
    stoppedTasks: 0,
    metadataUpdated: 0,
    errors: [],
  };

  try {
    // Find stale task metadata
    const staleMetadata = await findStaleTaskMetadata();
    stats.tasksChecked = staleMetadata.length;
    stats.staleTasks = staleMetadata.length;

    console.log(`Found ${staleMetadata.length} potentially stale tasks`);

    for (const metadata of staleMetadata) {
      try {
        // Check if the ECS task is still running
        if (metadata.task_arn) {
          const stillRunning = await isTaskStillRunning(metadata.task_arn);

          if (stillRunning) {
            // Stop the running task
            const stopped = await stopTask(metadata.task_arn);
            if (stopped) {
              stats.stoppedTasks++;
            }
          }
        }

        // Update metadata to mark as timed out
        metadata.status = "timed_out";
        metadata.completed_at = new Date().toISOString();
        metadata.error_message = "Task exceeded time limit and was terminated by cleanup process";

        await updateTaskMetadata(metadata);
        stats.metadataUpdated++;

        console.log(`Cleaned up stale task: ${metadata.task_id}`);

      } catch (error) {
        const errorMsg = `Failed to clean up task ${metadata.task_id}: ${error}`;
        console.error(errorMsg);
        stats.errors.push(errorMsg);
      }
    }

    console.log(`Cleanup completed. Stats:`, JSON.stringify(stats, null, 2));
    return stats;

  } catch (error) {
    const errorMsg = `Cleanup process failed: ${error}`;
    console.error(errorMsg);
    stats.errors.push(errorMsg);
    throw error;
  }
}