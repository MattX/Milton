import { CloudTasksClient, protos } from "@google-cloud/tasks";
import type { Config, JobPriority } from "./types.js";

export interface TaskEnqueuer {
  /**
   * Task names are deterministic so redelivered Discord messages cannot double-queue an article.
   * `uniqueSuffix` deliberately opts out of that dedupe when requeueing a job on purpose.
   */
  enqueue(articleId: string, priority: JobPriority, uniqueSuffix?: string): Promise<void>;
}

/** Cloud Tasks dedupes by task name for about an hour after completion, so requeues need a fresh one. */
export function retryToken(): string {
  return Date.now().toString(36);
}

export class CloudTaskEnqueuer implements TaskEnqueuer {
  constructor(private readonly client: CloudTasksClient, private readonly config: Config) {}

  async enqueue(articleId: string, priority: JobPriority, uniqueSuffix?: string): Promise<void> {
    const queue = priority === "live" ? this.config.liveTaskQueue : this.config.historyTaskQueue;
    const taskId = `article-${articleId}${uniqueSuffix ? `-${uniqueSuffix}` : ""}`;
    const task: protos.google.cloud.tasks.v2.ITask = {
      name: this.client.taskPath(this.config.projectId, this.config.location, queue, taskId),
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.config.serviceUrl}/internal/extract`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ articleId })).toString("base64"),
        oidcToken: { serviceAccountEmail: this.config.taskServiceAccount, audience: this.config.serviceUrl },
      },
    };
    try {
      await this.client.createTask({
        parent: this.client.queuePath(this.config.projectId, this.config.location, queue),
        task,
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error; // ALREADY_EXISTS is idempotent success.
    }
  }
}
