import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { ExtractionError, parseArticleIsolated } from "../server/extractor";
import type { ExtractedArticle } from "../server/types";

class FakeWorker extends EventEmitter {
  terminate = vi.fn().mockResolvedValue(0);
  postMessage = vi.fn();
}

const metadata = { hostname: "example.com", httpStatus: 200, contentLength: 3 };
const article: ExtractedArticle = {
  title: "Story", description: "description", body: "body", excerpt: "description", method: "readability",
  httpStatus: 200, contentLength: 3, hostname: "example.com",
};

function run(worker: FakeWorker, timeoutMs = 100) {
  return parseArticleIsolated(Buffer.from("abc"), new URL("https://example.com/story"), 200, "text/html", {
    timeoutMs,
    workerFactory: (() => worker as never),
  });
}

describe("isolated article parsing", () => {
  it("returns a worker result and transfers only the exact response bytes", async () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementation((request: {
      source: Uint8Array;
      oversized: boolean;
      contentLength: number;
    }, transfer: ArrayBuffer[]) => {
      expect(request.source.byteLength).toBe(3);
      expect(request.oversized).toBe(false);
      expect(request.contentLength).toBe(3);
      expect(transfer[0]?.byteLength).toBe(3);
      queueMicrotask(() => worker.emit("message", { ok: true, article }));
    });
    await expect(run(worker)).resolves.toEqual(article);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it("rehydrates structured parser failures", async () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementation(() => queueMicrotask(() => worker.emit("message", {
      ok: false,
      error: { failureClass: "malformed_html", message: "bad markup", metadata, permanent: true },
    })));
    await expect(run(worker)).rejects.toMatchObject({ failureClass: "malformed_html", permanent: true });
  });

  it("maps OOM to permanent resource exhaustion and unexpected failures to transient errors", async () => {
    const oom = new FakeWorker();
    oom.postMessage.mockImplementation(() => queueMicrotask(() => {
      const error = Object.assign(new Error("heap"), { code: "ERR_WORKER_OUT_OF_MEMORY" });
      oom.emit("error", error);
    }));
    await expect(run(oom)).rejects.toMatchObject({ failureClass: "parse_resource_limit", permanent: true });

    const broken = new FakeWorker();
    broken.postMessage.mockImplementation(() => queueMicrotask(() => broken.emit("exit", 1)));
    await expect(run(broken)).rejects.toMatchObject({ failureClass: "network_error", permanent: false });
  });

  it("terminates a timed-out worker and settles only once", async () => {
    vi.useFakeTimers();
    const worker = new FakeWorker();
    const promise = run(worker, 20);
    const assertion = expect(promise).rejects.toMatchObject({ failureClass: "parse_resource_limit", permanent: true });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    worker.emit("message", { ok: true, article });
    expect(worker.terminate).toHaveBeenCalledOnce();
    vi.useRealTimers();
  });

  it("maps a synchronous worker protocol startup failure", async () => {
    const worker = new FakeWorker();
    worker.postMessage.mockImplementation(() => { throw new Error("cannot post"); });
    await expect(run(worker)).rejects.toBeInstanceOf(ExtractionError);
    await expect(run(worker)).rejects.toMatchObject({ failureClass: "network_error" });

    await expect(parseArticleIsolated(Buffer.from("abc"), new URL("https://example.com"), 200, "text/html", {
      workerFactory: (() => { throw new Error("cannot spawn"); }),
    })).rejects.toMatchObject({ failureClass: "network_error", permanent: false });
  });
});
