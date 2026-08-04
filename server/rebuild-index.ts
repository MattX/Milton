import type { DocumentSnapshot, Firestore } from "@google-cloud/firestore";
import { backfillBoundary } from "./discord-cursors.js";
import type { ChannelCursorDocument, ExtractionJobDocument } from "./types.js";

export interface RebuildPlan {
  articles: number;
  extractionJobs: number;
  discordCursors: number;
  pendingJobs: number;
  processingJobs: number;
}

interface RebuildSnapshot {
  plan: RebuildPlan;
  articles: DocumentSnapshot[];
  jobs: DocumentSnapshot[];
  cursors: DocumentSnapshot[];
}

/** Reads the actual documents so dry-run counts and a subsequent execution target the same scope. */
async function snapshotRebuild(db: Firestore): Promise<RebuildSnapshot> {
  const [articles, jobs, cursors] = await Promise.all([
    db.collection("articles").get(),
    db.collection("extractionJobs").get(),
    db.collection("discordCursors").get(),
  ]);
  const jobData = jobs.docs.map((doc) => doc.data() as ExtractionJobDocument);
  return {
    plan: {
      articles: articles.size,
      extractionJobs: jobs.size,
      discordCursors: cursors.size,
      pendingJobs: jobData.filter((job) => job.status === "pending").length,
      processingJobs: jobData.filter((job) => job.status === "processing").length,
    },
    articles: articles.docs,
    jobs: jobs.docs,
    cursors: cursors.docs,
  };
}

export async function inspectRebuild(db: Firestore): Promise<RebuildPlan> {
  return (await snapshotRebuild(db)).plan;
}

/**
 * Deletes only the disposable article/job collections, rewinds every existing Discord cursor to
 * include its live boundary, and enables backfill. The caller must pause polling before execution.
 */
export async function executeRebuild(db: Firestore, projectId: string, confirmation: string): Promise<RebuildPlan> {
  if (!confirmation || confirmation !== projectId) {
    throw new Error(`Project confirmation must exactly match ${projectId}`);
  }
  const snapshot = await snapshotRebuild(db);
  if (snapshot.plan.pendingJobs || snapshot.plan.processingJobs) {
    throw new Error(
      `Refusing rebuild with ${snapshot.plan.pendingJobs} pending and ${snapshot.plan.processingJobs} processing extraction jobs`,
    );
  }

  // Validate every boundary before issuing the first write, preventing a malformed cursor from
  // producing a partially reset index.
  const cursorUpdates = snapshot.cursors.map((doc) => {
    const cursor = doc.data() as ChannelCursorDocument;
    return { ref: doc.ref, backfillBeforeId: backfillBoundary(cursor.liveAfterId) };
  });

  const writer = db.bulkWriter();
  for (const doc of snapshot.articles) writer.delete(doc.ref);
  for (const doc of snapshot.jobs) writer.delete(doc.ref);
  const now = new Date().toISOString();
  for (const cursor of cursorUpdates) {
    writer.update(cursor.ref, { backfillBeforeId: cursor.backfillBeforeId, backfillComplete: false, updatedAt: now });
  }
  await writer.close();
  await db.collection("systemState").doc("backfill_enabled").set({ value: true, updatedAt: now });
  return snapshot.plan;
}
