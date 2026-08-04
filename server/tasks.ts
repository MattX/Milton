import { CloudTasksClient, protos } from "@google-cloud/tasks";
import type { Config, DigestTaskPayload, JobPriority } from "./types.js";
import type { QueuedJob } from "./repository.js";

export interface TaskEnqueuer {
  enqueue(job: QueuedJob): Promise<void>;
  exists(job: QueuedJob): Promise<boolean>;
}

export function articleTaskId(articleId: string, generation: number): string {
  return `article-v2-${articleId}-g${generation}`;
}

export class CloudTaskEnqueuer implements TaskEnqueuer {
  constructor(private readonly client: CloudTasksClient, private readonly config: Config) {}

  async enqueue(job: QueuedJob): Promise<void> {
    const queue = this.queue(job.priority);
    const task: protos.google.cloud.tasks.v2.ITask = {
      name: this.taskName(job),
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.config.serviceUrl}/internal/extract`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify({ articleId: job.articleId, generation: job.generation })).toString("base64"),
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

  async exists(job: QueuedJob): Promise<boolean> {
    try {
      await this.client.getTask({ name: this.taskName(job) });
      return true;
    } catch (error) {
      if ((error as { code?: number }).code === 5) return false; // NOT_FOUND is the only absence signal.
      throw error;
    }
  }

  private queue(priority: JobPriority): string {
    return priority === "live" ? this.config.liveTaskQueue : this.config.historyTaskQueue;
  }

  private taskName(job: QueuedJob): string {
    return this.client.taskPath(
      this.config.projectId, this.config.location, this.queue(job.priority), articleTaskId(job.articleId, job.generation),
    );
  }
}

export interface CommandTaskEnqueuer {
  enqueueDigest(payload: DigestTaskPayload): Promise<void>;
}

export class CloudCommandTaskEnqueuer implements CommandTaskEnqueuer {
  constructor(private readonly client: CloudTasksClient, private readonly config: Config) {}

  async enqueueDigest(payload: DigestTaskPayload): Promise<void> {
    const taskId = `digest-${payload.interactionId}`;
    const task: protos.google.cloud.tasks.v2.ITask = {
      name: this.client.taskPath(this.config.projectId, this.config.location, this.config.commandTaskQueue, taskId),
      httpRequest: {
        httpMethod: protos.google.cloud.tasks.v2.HttpMethod.POST,
        url: `${this.config.serviceUrl}/internal/commands/digest`,
        headers: { "Content-Type": "application/json" },
        body: Buffer.from(JSON.stringify(payload)).toString("base64"),
        oidcToken: { serviceAccountEmail: this.config.taskServiceAccount, audience: this.config.serviceUrl },
      },
    };
    try {
      await this.client.createTask({
        parent: this.client.queuePath(this.config.projectId, this.config.location, this.config.commandTaskQueue),
        task,
      });
    } catch (error) {
      if ((error as { code?: number }).code !== 6) throw error;
    }
  }
}
