import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import { FirestoreRepository } from "../server/repository";
import type { ExtractionJobDocument } from "../server/types";

describe("extraction job recovery", () => {
  it("does not reset a job that completed after the stale-job query", async () => {
    const selected = job({ status: "processing", processingStartedAt: "2026-01-01T00:00:00.000Z" });
    const completed = job({ status: "completed", processingStartedAt: null });
    const update = vi.fn();
    const query = {
      where: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      get: vi.fn().mockResolvedValue({ docs: [{ data: () => selected }] }),
    };
    const db = {
      collection: vi.fn(() => ({ ...query, doc: (id: string) => ({ id }) })),
      runTransaction: vi.fn(async (callback: (transaction: unknown) => Promise<unknown>) => callback({
        get: vi.fn().mockResolvedValue({ data: () => completed }),
        update,
      })),
    } as unknown as Firestore;

    const result = await new FirestoreRepository(db, "guild")
      .requeueStalledExtractions(new Date("2026-02-01T00:00:00.000Z"), 20);

    expect(result).toEqual([]);
    expect(update).not.toHaveBeenCalled();
  });
});

function job(values: Partial<ExtractionJobDocument>): ExtractionJobDocument {
  return {
    articleId: "article", priority: "live", status: "pending", attempts: 1,
    lastError: null, processingStartedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z",
    ...values,
  };
}
