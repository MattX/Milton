import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import { FirestoreRepository } from "../server/repository";
import type { ExtractionJobDocument } from "../server/types";

describe("extraction job recovery", () => {
  it("keeps an undispatched generation stable across repeated polls", async () => {
    const selected = job({ taskGeneration: 4, taskPriority: "history", taskDispatchState: "needs_dispatch" });
    const { db, update } = transactionalDb(selected);
    const result = await new FirestoreRepository(db, "guild").reserveRecovery(selected);
    expect(result).toEqual({ articleId: "article", priority: "history", generation: 4 });
    expect(update).not.toHaveBeenCalled();
  });

  it("reserves one new generation for an observed missing task", async () => {
    const selected = job({ taskGeneration: 4, taskPriority: "live", taskDispatchState: "dispatched" });
    const { db, update } = transactionalDb(selected);
    const result = await new FirestoreRepository(db, "guild").reserveRecovery(selected);
    expect(result).toEqual({ articleId: "article", priority: "live", generation: 5 });
    expect(update).toHaveBeenCalledWith(expect.objectContaining({ collection: "extractionJobs" }), expect.objectContaining({
      taskGeneration: 5, taskDispatchState: "needs_dispatch", status: "pending",
    }));
  });
});

describe("generation-aware extraction claims", () => {
  it("acknowledges an obsolete generation without touching the job", async () => {
    const { db, update } = transactionalDb(job({ taskGeneration: 2, taskDispatchState: "dispatched" }));
    await expect(new FirestoreRepository(db, "guild").claimExtraction("article", 1)).resolves.toEqual({ status: "settled" });
    expect(update).not.toHaveBeenCalled();
  });

  it("allows the third claim and terminalizes the following unreported crash", async () => {
    const third = transactionalDb(job({ attempts: 2, taskGeneration: 3, taskDispatchState: "dispatched" }));
    const claim = await new FirestoreRepository(third.db, "guild").claimExtraction("article", 3);
    expect(claim).toMatchObject({ status: "claimed", job: { attempts: 3 } });

    const exhausted = transactionalDb(job({ attempts: 3, status: "processing", taskGeneration: 3, taskDispatchState: "dispatched" }));
    await expect(new FirestoreRepository(exhausted.db, "guild").claimExtraction("article", 3)).resolves.toEqual({ status: "settled" });
    expect(exhausted.update).toHaveBeenCalledWith(expect.objectContaining({ collection: "articles" }), expect.objectContaining({
      extractionStatus: "failed", extractionFailureClass: "retry_exhausted",
    }));
  });
});

describe("recent articles", () => {
  it("counts the rolling window and returns newest articles first", async () => {
    const where = vi.fn().mockReturnThis();
    const orderBy = vi.fn().mockReturnThis();
    const limit = vi.fn().mockReturnThis();
    const get = vi.fn().mockResolvedValue({
      docs: [{ id: "newest", data: () => ({ title: "Newest" }) }],
    });
    const countGet = vi.fn().mockResolvedValue({ data: () => ({ count: 4 }) });
    const query = { where, orderBy, limit, get, count: vi.fn(() => ({ get: countGet })) };
    const db = { collection: vi.fn(() => query) } as unknown as Firestore;

    const result = await new FirestoreRepository(db, "guild")
      .listRecentArticles("2026-07-27T12:00:00.000Z", 25);

    expect(where).toHaveBeenCalledWith("lastPostedAt", ">=", "2026-07-27T12:00:00.000Z");
    expect(orderBy).toHaveBeenCalledWith("lastPostedAt", "desc");
    expect(limit).toHaveBeenCalledWith(25);
    expect(result).toEqual({ items: [{ id: "newest", data: { title: "Newest" } }], total: 4 });
  });
});

describe("completed extraction persistence", () => {
  it("stores description separately from body and keeps the description-first excerpt", async () => {
    const { db, update } = transactionalDb(job({ status: "processing", taskGeneration: 2 }));

    await new FirestoreRepository(db, "guild").completeExtraction("article", {
      title: "Title", description: "Metadata description", body: "Readable body", excerpt: "Metadata description",
      method: "readability", httpStatus: 200, contentLength: 100, hostname: "example.com",
    }, 2);

    expect(update).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "articles", id: "article" }),
      expect.objectContaining({ description: "Metadata description", body: "Readable body", excerpt: "Metadata description" }),
    );
  });
});

function job(values: Partial<ExtractionJobDocument>): ExtractionJobDocument {
  return {
    articleId: "article", priority: "live", status: "pending", attempts: 1,
    taskGeneration: 1, taskPriority: "live", taskDispatchState: "dispatched",
    lastError: null, processingStartedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...values,
  };
}

function transactionalDb(current: ExtractionJobDocument) {
  const update = vi.fn();
  const set = vi.fn();
  const db = {
    collection: vi.fn((collection: string) => ({ doc: (id: string) => ({ collection, id }) })),
    runTransaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
      get: vi.fn(async (ref: { collection: string }) => ref.collection === "extractionJobs"
        ? { exists: true, data: () => current }
        : { exists: true, data: () => ({ domain: "example.com", extractionStatus: "pending" }) }),
      update,
      set,
    })),
  } as unknown as Firestore;
  return { db, update, set };
}
