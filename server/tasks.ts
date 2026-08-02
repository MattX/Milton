import { CloudTasksClient, protos } from "@google-cloud/tasks";
import type { Config } from "./types.js";

export interface TaskEnqueuer { enqueue(articleId: string, priority: "live" | "history"): Promise<void> }

export class CloudTaskEnqueuer implements TaskEnqueuer {
  constructor(private readonly client: CloudTasksClient, private readonly config: Config) {}

  async enqueue(articleId: string, priority: "live" | "history"): Promise<void> {
    const queue = priority === "live" ? this.config.liveTaskQueue : this.config.historyTaskQueue;
    const parent = this.client.queuePath(this.config.projectId, this.config.location, queue);
    const name = this.client.taskPath(this.config.projectId, this.config.location, queue, `article-${articleId}`);
    const task: protos.google.cloud.tasks.v2.ITask = {
      name,
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.config.serviceUrl}/internal/extract`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ articleId })).toString("base64"),
        oidcToken: { serviceAccountEmail: this.config.taskServiceAccount, audience: this.config.serviceUrl },
      },
    };
    try { await this.client.createTask({ parent, task }); }
    catch (error) {
      if ((error as { code?: number }).code !== 6) throw error; // ALREADY_EXISTS is idempotent success.
    }
  }
}

export class RecordingTaskEnqueuer implements TaskEnqueuer {
  readonly tasks: Array<{ articleId: string; priority: "live" | "history" }> = [];
  async enqueue(articleId: string, priority: "live" | "history"): Promise<void> { this.tasks.push({ articleId, priority }); }
}
