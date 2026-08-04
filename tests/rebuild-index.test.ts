import type { Firestore } from "@google-cloud/firestore";
import { describe, expect, it, vi } from "vitest";
import { executeRebuild, inspectRebuild } from "../server/rebuild-index";

interface Row { id: string; data: Record<string, unknown> }

function fakeFirestore(values: Record<string, Row[]>) {
  const remove = vi.fn();
  const update = vi.fn();
  const set = vi.fn();
  const collection = vi.fn((name: string) => ({
    get: vi.fn().mockResolvedValue({
      size: values[name]?.length || 0,
      docs: (values[name] || []).map((row) => ({
        ref: { collection: name, id: row.id },
        data: () => row.data,
      })),
    }),
    doc: (id: string) => ({ collection: name, id, set: (data: unknown) => { set({ collection: name, id }, data); } }),
  }));
  const db = {
    collection,
    bulkWriter: vi.fn(() => ({
      delete: (ref: unknown) => { remove(ref); },
      update: (ref: unknown, data: unknown) => { update(ref, data); },
      close: vi.fn().mockResolvedValue(undefined),
    })),
  } as unknown as Firestore;
  return { db, collection, remove, update, set };
}

describe("clean index rebuild", () => {
  it("dry-runs with exact counts and performs no writes", async () => {
    const fake = fakeFirestore({
      articles: [{ id: "a", data: {} }, { id: "b", data: {} }],
      extractionJobs: [{ id: "a", data: { status: "failed" } }],
      discordCursors: [{ id: "c", data: { liveAfterId: "100" } }],
    });
    await expect(inspectRebuild(fake.db)).resolves.toEqual({
      articles: 2, extractionJobs: 1, discordCursors: 1, pendingJobs: 0, processingJobs: 0,
    });
    expect(fake.db.bulkWriter).not.toHaveBeenCalled();
  });

  it("requires exact project confirmation and refuses active jobs", async () => {
    const inactive = fakeFirestore({ articles: [], extractionJobs: [], discordCursors: [] });
    await expect(executeRebuild(inactive.db, "real-project", "wrong-project")).rejects.toThrow("exactly match");
    expect(inactive.db.bulkWriter).not.toHaveBeenCalled();

    const active = fakeFirestore({
      articles: [],
      extractionJobs: [
        { id: "p", data: { status: "pending" } },
        { id: "r", data: { status: "processing" } },
      ],
      discordCursors: [],
    });
    await expect(executeRebuild(active.db, "project", "project")).rejects.toThrow("1 pending and 1 processing");
    expect(active.db.bulkWriter).not.toHaveBeenCalled();
  });

  it("deletes only articles and jobs, includes cursor boundaries, and enables backfill", async () => {
    const fake = fakeFirestore({
      articles: [{ id: "article", data: {} }],
      extractionJobs: [{ id: "job", data: { status: "failed" } }],
      discordCursors: [{ id: "cursor", data: { liveAfterId: "999", backfillComplete: true } }],
    });
    await executeRebuild(fake.db, "project", "project");

    expect(fake.remove.mock.calls.map(([ref]) => ref.collection)).toEqual(["articles", "extractionJobs"]);
    expect(fake.update).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "discordCursors", id: "cursor" }),
      expect.objectContaining({ backfillBeforeId: "1000", backfillComplete: false }),
    );
    expect(fake.set).toHaveBeenCalledWith(
      expect.objectContaining({ collection: "systemState", id: "backfill_enabled" }),
      expect.objectContaining({ value: true }),
    );
  });
});
