import { describe, expect, it, vi } from "vitest";
import type { CloudTasksClient } from "@google-cloud/tasks";
import { articleTaskId, CloudTaskEnqueuer } from "../server/tasks";
import type { Config } from "../server/types";

describe("extraction task names", () => {
  it("uses the v2 namespace and generation identity", () => {
    expect(articleTaskId("abc", 7)).toBe("article-v2-abc-g7");
  });

  it("uses a deterministic generation name and payload", async () => {
    const createTask = vi.fn().mockResolvedValue([{}]);
    const client = {
      taskPath: vi.fn((_project, _location, queue, task) => `${queue}/${task}`),
      queuePath: vi.fn((_project, _location, queue) => queue),
      createTask,
    } as unknown as CloudTasksClient;
    const enqueuer = new CloudTaskEnqueuer(client, {
      projectId: "p", location: "loc", liveTaskQueue: "live", historyTaskQueue: "history",
      serviceUrl: "https://service", taskServiceAccount: "tasks@example.com",
    } as Config);
    await enqueuer.enqueue({ articleId: "abc", priority: "live", generation: 4 });
    const task = createTask.mock.calls[0]![0].task;
    expect(task.name).toBe("live/article-v2-abc-g4");
    expect(JSON.parse(Buffer.from(task.httpRequest.body, "base64").toString())).toEqual({ articleId: "abc", generation: 4 });
  });

  it("treats ALREADY_EXISTS as dispatch success and only NOT_FOUND as absence", async () => {
    const client = {
      taskPath: vi.fn(() => "task"), queuePath: vi.fn(() => "queue"),
      createTask: vi.fn().mockRejectedValue({ code: 6 }),
      getTask: vi.fn().mockRejectedValueOnce({ code: 5 }).mockRejectedValueOnce({ code: 7 }),
    } as unknown as CloudTasksClient;
    const enqueuer = new CloudTaskEnqueuer(client, {
      projectId: "p", location: "loc", liveTaskQueue: "live", historyTaskQueue: "history",
      serviceUrl: "https://service", taskServiceAccount: "tasks@example.com",
    } as Config);
    const job = { articleId: "abc", priority: "history" as const, generation: 2 };
    await expect(enqueuer.enqueue(job)).resolves.toBeUndefined();
    await expect(enqueuer.exists(job)).resolves.toBe(false);
    await expect(enqueuer.exists(job)).rejects.toMatchObject({ code: 7 });
  });
});
