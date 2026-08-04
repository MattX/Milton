import { createHash } from "node:crypto";
import { Firestore, Pipelines } from "@google-cloud/firestore";
import type { AdminStatus, ArticleResult, SearchResponse } from "../shared/api.js";
import { mapConcurrent } from "./concurrency.js";
import { initialChannelCursor } from "./discord-cursors.js";
import { decodeCursor, encodeNextCursor, normalizeSearchQuery } from "./search-query.js";
import type {
  ArticleDocument,
  ChannelCursorDocument,
  DiscordMessage,
  ExtractedArticle,
  ExtractionFailure,
  ExtractionJobDocument,
  JobPriority,
  LatestOccurrence,
  RecentArticle,
} from "./types.js";
import { extractLinks, fallbackTitle, type NormalizedLink } from "./urls.js";

const PAGE_SIZE = 20;
const BACKFILL_ENABLED = "backfill_enabled";
const WRITE_CONCURRENCY = 10;

/** How long a claimed job stays off-limits to other deliveries before it is treated as abandoned. */
export const LEASE_MS = 2 * 60_000;

/**
 * A delivery may find a job already finished by an earlier delivery ("settled"), or still held
 * by an in-flight one ("leased"). Only "leased" is worth redelivering: the holder may have died.
 */
export type ExtractionClaim =
  | { status: "claimed"; article: ArticleDocument; job: ExtractionJobDocument }
  | { status: "leased" }
  | { status: "settled" };

export interface ChannelDiscovery {
  channelId: string;
  channelName: string;
  isThread: boolean;
  archived: boolean;
  lastMessageId: string | null;
}

/** An extraction job that needs a fresh Cloud Task. */
export interface QueuedJob {
  articleId: string;
  priority: JobPriority;
  generation: number;
}

export interface Repository {
  persistDiscordMessages(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<string[]>;
  search(query: string, cursor: string | null): Promise<SearchResponse>;
  listRecentArticles(since: string | null, limit: number): Promise<{ items: RecentArticle[]; total: number }>;
  claimCommandLock(lockId: string, ownerId: string, expiresAt: string): Promise<boolean>;
  releaseCommandLock(lockId: string, ownerId: string): Promise<void>;
  getAdminStatus(): Promise<AdminStatus>;
  setBackfillEnabled(enabled: boolean): Promise<void>;
  isBackfillEnabled(): Promise<boolean>;
  upsertChannels(values: ChannelDiscovery[]): Promise<void>;
  listLiveChannels(limit: number): Promise<ChannelCursorDocument[]>;
  listLiveThreadIds(): Promise<string[]>;
  archiveChannels(channelIds: string[]): Promise<void>;
  updateCursor(channelId: string, values: Partial<ChannelCursorDocument>): Promise<void>;
  nextBackfillChannel(): Promise<ChannelCursorDocument | null>;
  claimExtraction(articleId: string, generation?: number): Promise<ExtractionClaim>;
  completeExtraction(articleId: string, outcome: ExtractedArticle, generation?: number): Promise<void>;
  failExtraction(articleId: string, failure: ExtractionFailure, terminal: boolean, generation?: number): Promise<void>;
  requeueStalledExtractions(staleBefore: Date, limit: number): Promise<QueuedJob[]>;
  requeueFailedExtractions(limit: number): Promise<QueuedJob[]>;
  getDispatchableJob(articleId: string): Promise<QueuedJob | null>;
  markTaskDispatched(job: QueuedJob): Promise<void>;
  listRecoverableExtractions(staleBefore: Date, limit: number): Promise<ExtractionJobDocument[]>;
  reserveRecovery(job: ExtractionJobDocument): Promise<QueuedJob | null>;
}

interface LinkRecord extends NormalizedLink {
  occurrences: LatestOccurrence[];
}

export class FirestoreRepository implements Repository {
  constructor(readonly db: Firestore, private readonly guildId: string) {}

  async persistDiscordMessages(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<string[]> {
    const records = new Map<string, LinkRecord>();
    for (const message of messages) {
      for (const link of extractLinks(message.content)) {
        const record = records.get(link.normalizedUrl) ?? { ...link, occurrences: [] };
        record.occurrences.push({
          channelId: message.channel_id,
          channelName,
          authorName: message.author.global_name || message.author.username,
          postedAt: message.timestamp,
          messageUrl: `https://discord.com/channels/${this.guildId}/${message.channel_id}/${message.id}`,
        });
        records.set(link.normalizedUrl, record);
      }
    }

    // A transaction may run its callback more than once under contention, so collect into a set.
    const enqueue = new Set<string>();
    await mapConcurrent([...records.values()], WRITE_CONCURRENCY, async (record) => {
      if (await this.persistArticle(record, priority)) enqueue.add(articleId(record.normalizedUrl));
    });
    return [...enqueue];
  }

  /** Upserts one article and its extraction job. Returns true when the job still needs extracting. */
  private async persistArticle(record: LinkRecord, priority: JobPriority): Promise<boolean> {
    const id = articleId(record.normalizedUrl);
    const articleRef = this.db.collection("articles").doc(id);
    const jobRef = this.db.collection("extractionJobs").doc(id);
    const newest = record.occurrences.reduce((left, right) => (right.postedAt > left.postedAt ? right : left));

    return this.db.runTransaction(async (transaction) => {
      const [articleSnap, jobSnap] = await Promise.all([transaction.get(articleRef), transaction.get(jobRef)]);
      const now = new Date().toISOString();
      const existing = articleSnap.data() as ArticleDocument | undefined;
      const article: ArticleDocument = {
        normalizedUrl: record.normalizedUrl,
        domain: record.domain,
        // A successful extraction owns the title; anything else keeps the URL-derived placeholder.
        title: existing?.extractionStatus === "indexed" ? existing.title : fallbackTitle(record.normalizedUrl).slice(0, 300),
        body: existing?.body || "",
        excerpt: existing?.excerpt || "",
        extractionStatus: existing?.extractionStatus || "pending",
        extractionMethod: existing?.extractionMethod ?? null,
        extractionFailureClass: existing?.extractionFailureClass ?? null,
        extractionHttpStatus: existing?.extractionHttpStatus ?? null,
        extractionContentLength: existing?.extractionContentLength ?? null,
        // The extractor records the host it actually reached, which redirects may have changed.
        extractionHostname: existing?.extractionHostname || record.domain,
        lastPostedAt: maxString(existing?.lastPostedAt, ...record.occurrences.map((item) => item.postedAt)),
        latestOccurrence: !existing || newest.postedAt >= existing.latestOccurrence.postedAt ? newest : existing.latestOccurrence,
        createdAt: existing?.createdAt || now,
        updatedAt: now,
      };
      transaction.set(articleRef, article);

      const job = jobSnap.data() as ExtractionJobDocument | undefined;
      if (article.extractionStatus !== "pending" || job?.status === "completed" || job?.status === "failed") return false;
      const effectivePriority = job?.priority === "live" || priority === "live" ? "live" : "history";
      const promotePending = job?.status === "pending" && job.priority === "history" && priority === "live";
      // A legacy processing holder remains valid until its lease goes stale; only pending legacy
      // work is migrated immediately.
      const reserveGeneration = !job || (job.status === "pending" && job.taskGeneration === undefined) || promotePending;
      const nextGeneration = reserveGeneration ? (job?.taskGeneration ?? 0) + 1 : job?.taskGeneration;
      transaction.set(jobRef, {
        articleId: id,
        // A live repost promotes a queued historical job.
        priority: effectivePriority,
        status: job?.status || "pending",
        attempts: job?.attempts || 0,
        lastError: job?.lastError ?? null,
        processingStartedAt: job?.processingStartedAt ?? null,
        createdAt: job?.createdAt || now,
        updatedAt: now,
        ...(nextGeneration === undefined ? {} : { taskGeneration: nextGeneration }),
        taskPriority: reserveGeneration ? effectivePriority : (job.taskPriority ?? job.priority),
        taskDispatchState: reserveGeneration ? "needs_dispatch" : (job.taskDispatchState ?? "dispatched"),
      } satisfies ExtractionJobDocument);
      // A processing promotion changes only the priority used by a later recovery; its holder stays valid.
      return (job?.status ?? "pending") === "pending"
        && (reserveGeneration || job?.taskDispatchState === "needs_dispatch");
    });
  }

  async search(rawQuery: string, cursor: string | null): Promise<SearchResponse> {
    const offset = decodeCursor(cursor);
    const query = normalizeSearchQuery(rawQuery);
    let rows: Array<{ id: string; data: ArticleDocument }>;
    if (query) {
      const snapshot = await this.db.pipeline().collection("articles").search({
        query: Pipelines.documentMatches(query),
        sort: Pipelines.score().descending(),
        offset,
        limit: PAGE_SIZE + 1,
      }).execute();
      rows = snapshot.results.flatMap((result) => (result.id
        ? [{ id: result.id, data: result.data() as ArticleDocument }]
        : []));
    } else {
      const snapshot = await this.db.collection("articles").orderBy("lastPostedAt", "desc")
        .offset(offset).limit(PAGE_SIZE + 1).get();
      rows = snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() as ArticleDocument }));
    }
    return mapSearchPage(rows, offset);
  }

  async listRecentArticles(since: string | null, limit: number): Promise<{ items: RecentArticle[]; total: number }> {
    const base = since
      ? this.db.collection("articles").where("lastPostedAt", ">=", since)
      : this.db.collection("articles");
    const [snapshot, count] = await Promise.all([
      base.orderBy("lastPostedAt", "desc").limit(limit).get(),
      base.count().get(),
    ]);
    return {
      items: snapshot.docs.map((doc) => ({ id: doc.id, data: doc.data() as ArticleDocument })),
      total: count.data().count,
    };
  }

  async claimCommandLock(lockId: string, ownerId: string, expiresAt: string): Promise<boolean> {
    const ref = this.db.collection("commandLocks").doc(lockId);
    return this.db.runTransaction(async (transaction) => {
      const current = (await transaction.get(ref)).data() as { ownerId?: string; expiresAt?: string } | undefined;
      if (current?.ownerId !== ownerId && current?.expiresAt && current.expiresAt > new Date().toISOString()) return false;
      transaction.set(ref, { ownerId, expiresAt, updatedAt: new Date().toISOString() });
      return true;
    });
  }

  async releaseCommandLock(lockId: string, ownerId: string): Promise<void> {
    const ref = this.db.collection("commandLocks").doc(lockId);
    await this.db.runTransaction(async (transaction) => {
      const current = (await transaction.get(ref)).data() as { ownerId?: string } | undefined;
      if (current?.ownerId === ownerId) transaction.delete(ref);
    });
  }

  async getAdminStatus(): Promise<AdminStatus> {
    const [backfillEnabled, live, history, failed, channels, complete] = await Promise.all([
      this.isBackfillEnabled(),
      this.db.collection("extractionJobs").where("priority", "==", "live").where("status", "in", ["pending", "processing"]).count().get(),
      this.db.collection("extractionJobs").where("priority", "==", "history").where("status", "in", ["pending", "processing"]).count().get(),
      this.db.collection("extractionJobs").where("status", "==", "failed").count().get(),
      this.db.collection("discordCursors").count().get(),
      this.db.collection("discordCursors").where("backfillComplete", "==", true).count().get(),
    ]);
    return {
      backfillEnabled,
      pendingLiveJobs: live.data().count,
      pendingBackfillJobs: history.data().count,
      failedJobs: failed.data().count,
      channelsComplete: complete.data().count,
      channelsTotal: channels.data().count,
    };
  }

  async setBackfillEnabled(enabled: boolean): Promise<void> {
    await this.db.collection("systemState").doc(BACKFILL_ENABLED)
      .set({ value: enabled, updatedAt: new Date().toISOString() });
  }

  async isBackfillEnabled(): Promise<boolean> {
    return (await this.db.collection("systemState").doc(BACKFILL_ENABLED).get()).data()?.value === true;
  }

  /**
   * Creates cursors for newly discovered channels, seeded from Discord's own `last_message_id` so
   * live polling starts at the present and backfill owns everything behind it.
   */
  async upsertChannels(values: ChannelDiscovery[]): Promise<void> {
    if (!values.length) return;
    const refs = values.map((value) => this.db.collection("discordCursors").doc(value.channelId));
    const snapshots = await this.db.getAll(...refs);
    const writer = this.db.bulkWriter();
    const now = new Date().toISOString();
    for (const [index, value] of values.entries()) {
      const ref = refs[index]!;
      const existing = snapshots[index]!.data() as ChannelCursorDocument | undefined;
      if (existing) {
        // A cursor with no live boundary was never seeded — it predates seeding at creation, or its
        // channel was unreachable at the time. Repair it rather than polling from a missing cursor.
        const repair = existing.liveAfterId ? null : initialChannelCursor(value.lastMessageId, Date.now());
        const archiveRepair = existing.archivedThreadScanComplete === undefined
          ? initialArchivedThreadScan(value.isThread)
          : null;
        const renamed = existing.channelName !== value.channelName || existing.archived !== value.archived;
        // Only write when something actually changed; discovery runs every five minutes.
        if (!renamed && !repair && !archiveRepair) continue;
        writer.update(ref, {
          channelName: value.channelName, archived: value.archived, ...repair, ...archiveRepair, updatedAt: now,
        });
      } else {
        writer.create(ref, {
          channelId: value.channelId,
          channelName: value.channelName,
          isThread: value.isThread,
          archived: value.archived,
          ...initialChannelCursor(value.lastMessageId, Date.now()),
          ...initialArchivedThreadScan(value.isThread),
          updatedAt: now,
        } satisfies ChannelCursorDocument);
      }
    }
    await writer.close();
  }

  async listLiveChannels(limit: number): Promise<ChannelCursorDocument[]> {
    const snapshot = await this.db.collection("discordCursors")
      .where("archived", "==", false).orderBy("updatedAt").limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as ChannelCursorDocument);
  }

  async listLiveThreadIds(): Promise<string[]> {
    const snapshot = await this.db.collection("discordCursors")
      .where("isThread", "==", true).where("archived", "==", false).get();
    return snapshot.docs.map((doc) => doc.id);
  }

  /** Archived channels stop being polled for new messages but keep their history and backfill progress. */
  async archiveChannels(channelIds: string[]): Promise<void> {
    if (!channelIds.length) return;
    const writer = this.db.bulkWriter();
    const now = new Date().toISOString();
    for (const id of channelIds) {
      writer.update(this.db.collection("discordCursors").doc(id), { archived: true, updatedAt: now });
    }
    await writer.close();
  }

  async updateCursor(channelId: string, values: Partial<ChannelCursorDocument>): Promise<void> {
    await this.db.collection("discordCursors").doc(channelId)
      .update({ ...values, updatedAt: new Date().toISOString() });
  }

  async nextBackfillChannel(): Promise<ChannelCursorDocument | null> {
    const snapshot = await this.db.collection("discordCursors")
      .where("backfillComplete", "==", false).orderBy("updatedAt").limit(1).get();
    return snapshot.empty ? null : (snapshot.docs[0]!.data() as ChannelCursorDocument);
  }

  async claimExtraction(articleIdValue: string, generation?: number): Promise<ExtractionClaim> {
    const articleRef = this.db.collection("articles").doc(articleIdValue);
    const jobRef = this.db.collection("extractionJobs").doc(articleIdValue);
    return this.db.runTransaction<ExtractionClaim>(async (transaction) => {
      const [articleSnap, jobSnap] = await Promise.all([transaction.get(articleRef), transaction.get(jobRef)]);
      if (!articleSnap.exists || !jobSnap.exists) return { status: "settled" };
      const article = articleSnap.data() as ArticleDocument;
      const job = jobSnap.data() as ExtractionJobDocument;
      // Legacy deliveries are accepted only while the job itself is still legacy.
      if (generation !== job.taskGeneration || (generation === undefined) !== (job.taskGeneration === undefined)) {
        return { status: "settled" };
      }
      if (article.extractionStatus === "indexed") {
        if (job.status !== "completed") {
          transaction.update(jobRef, {
            status: "completed", lastError: null, processingStartedAt: null, updatedAt: new Date().toISOString(),
          });
        }
        return { status: "settled" };
      }
      if (job.status === "completed" || job.status === "failed") {
        return { status: "settled" };
      }
      const leaseHeldSince = job.processingStartedAt ? Date.parse(job.processingStartedAt) : 0;
      if (job.status === "processing" && leaseHeldSince > Date.now() - LEASE_MS) return { status: "leased" };

      if (job.attempts >= 3) {
        const now = new Date().toISOString();
        transaction.update(jobRef, {
          status: "failed", lastError: "Extraction attempt limit reached", processingStartedAt: null, updatedAt: now,
        });
        transaction.update(articleRef, {
          extractionStatus: "failed", extractionMethod: "link-only", extractionFailureClass: "retry_exhausted",
          extractionHttpStatus: null, extractionContentLength: null, extractionHostname: article.domain, updatedAt: now,
        });
        return { status: "settled" };
      }

      const now = new Date().toISOString();
      const claimed: ExtractionJobDocument = {
        ...job, status: "processing", attempts: job.attempts + 1, processingStartedAt: now, updatedAt: now,
      };
      transaction.set(jobRef, claimed);
      return { status: "claimed", article, job: claimed };
    });
  }

  async completeExtraction(articleIdValue: string, outcome: ExtractedArticle, generation?: number): Promise<void> {
    const now = new Date().toISOString();
    const articleRef = this.db.collection("articles").doc(articleIdValue);
    const jobRef = this.db.collection("extractionJobs").doc(articleIdValue);
    await this.db.runTransaction(async (transaction) => {
      const job = (await transaction.get(jobRef)).data() as ExtractionJobDocument | undefined;
      if (!job || job.status !== "processing" || job.taskGeneration !== generation) return;
      transaction.update(articleRef, {
        ...(outcome.title ? { title: outcome.title } : {}), body: outcome.body, excerpt: outcome.excerpt,
        extractionStatus: "indexed", extractionMethod: outcome.method, extractionFailureClass: null,
        extractionHttpStatus: outcome.httpStatus, extractionContentLength: outcome.contentLength,
        extractionHostname: outcome.hostname, updatedAt: now,
      });
      transaction.update(jobRef, { status: "completed", lastError: null, processingStartedAt: null, updatedAt: now });
    });
  }

  async failExtraction(articleIdValue: string, failure: ExtractionFailure, terminal: boolean, generation?: number): Promise<void> {
    const now = new Date().toISOString();
    const articleRef = this.db.collection("articles").doc(articleIdValue);
    const jobRef = this.db.collection("extractionJobs").doc(articleIdValue);
    await this.db.runTransaction(async (transaction) => {
      const job = (await transaction.get(jobRef)).data() as ExtractionJobDocument | undefined;
      if (!job || job.status !== "processing" || job.taskGeneration !== generation) return;
      transaction.update(jobRef, {
        status: terminal ? "failed" : "pending", lastError: failure.message.slice(0, 1000),
        processingStartedAt: null, updatedAt: now,
      });
      if (terminal) {
        transaction.update(articleRef, {
          extractionStatus: "failed", extractionMethod: "link-only", extractionFailureClass: failure.failureClass,
          extractionHttpStatus: failure.httpStatus, extractionContentLength: failure.contentLength,
          extractionHostname: failure.hostname, updatedAt: now,
        });
      }
    });
  }

  async getDispatchableJob(articleIdValue: string): Promise<QueuedJob | null> {
    const snapshot = await this.db.collection("extractionJobs").doc(articleIdValue).get();
    const job = snapshot.data() as ExtractionJobDocument | undefined;
    if (!job || job.status !== "pending" || job.taskDispatchState !== "needs_dispatch" || job.taskGeneration === undefined) return null;
    return { articleId: job.articleId, priority: job.taskPriority ?? job.priority, generation: job.taskGeneration };
  }

  async markTaskDispatched(job: QueuedJob): Promise<void> {
    const ref = this.db.collection("extractionJobs").doc(job.articleId);
    await this.db.runTransaction(async (transaction) => {
      const snapshot = await transaction.get(ref);
      const current = snapshot.data() as ExtractionJobDocument | undefined;
      if (current?.taskGeneration !== job.generation || current.taskPriority !== job.priority
        || current.taskDispatchState !== "needs_dispatch") return;
      transaction.update(ref, { taskDispatchState: "dispatched", updatedAt: new Date().toISOString() });
    });
  }

  async listRecoverableExtractions(staleBefore: Date, limit: number): Promise<ExtractionJobDocument[]> {
    const [pending, processing] = await Promise.all([
      this.db.collection("extractionJobs").where("status", "==", "pending").limit(limit).get(),
      this.db.collection("extractionJobs").where("status", "==", "processing")
        .where("processingStartedAt", "<", staleBefore.toISOString()).limit(limit).get(),
    ]);
    const jobs = new Map<string, ExtractionJobDocument>();
    for (const doc of [...pending.docs, ...processing.docs]) {
      const job = doc.data() as ExtractionJobDocument;
      jobs.set(job.articleId, job);
    }
    return [...jobs.values()].slice(0, limit);
  }

  /** Reserves the next deterministic generation after an exact observed task is found missing. */
  async reserveRecovery(observed: ExtractionJobDocument): Promise<QueuedJob | null> {
    const jobRef = this.db.collection("extractionJobs").doc(observed.articleId);
    const articleRef = this.db.collection("articles").doc(observed.articleId);
    return this.db.runTransaction(async (transaction) => {
      const [jobSnap, articleSnap] = await Promise.all([transaction.get(jobRef), transaction.get(articleRef)]);
      const current = jobSnap.data() as ExtractionJobDocument | undefined;
      if (!current || !articleSnap.exists || current.status !== observed.status
        || current.taskGeneration !== observed.taskGeneration
        || current.taskDispatchState !== observed.taskDispatchState
        || current.processingStartedAt !== observed.processingStartedAt) return null;

      const priority = current.priority;
      const alreadyReserved = current.taskGeneration !== undefined && current.taskDispatchState === "needs_dispatch";
      const generation = alreadyReserved ? current.taskGeneration! : (current.taskGeneration ?? 0) + 1;
      const now = new Date().toISOString();
      if (current.attempts >= 3) {
        const article = articleSnap.data() as ArticleDocument;
        transaction.update(jobRef, {
          status: "failed", lastError: "Extraction attempt limit reached", processingStartedAt: null, updatedAt: now,
        });
        transaction.update(articleRef, {
          extractionStatus: "failed", extractionMethod: "link-only", extractionFailureClass: "retry_exhausted",
          extractionHttpStatus: null, extractionContentLength: null, extractionHostname: article.domain, updatedAt: now,
        });
        return null;
      }
      if (alreadyReserved) {
        return { articleId: current.articleId, priority: current.taskPriority ?? priority, generation };
      }
      transaction.update(jobRef, {
        status: "pending", processingStartedAt: null, taskGeneration: generation,
        taskPriority: priority, taskDispatchState: "needs_dispatch", updatedAt: now,
      });
      return { articleId: current.articleId, priority, generation };
    });
  }

  /**
   * Recovers jobs whose worker died holding the lease. Cloud Tasks eventually gives up on a task,
   * so without this sweep those articles would stay pending with nothing left to drive them.
   */
  async requeueStalledExtractions(staleBefore: Date, limit: number): Promise<QueuedJob[]> {
    const snapshot = await this.db.collection("extractionJobs")
      .where("status", "==", "processing")
      .where("processingStartedAt", "<", staleBefore.toISOString())
      .limit(limit).get();
    const jobs = await Promise.all(snapshot.docs.map((doc) => this.reserveRecovery(doc.data() as ExtractionJobDocument)));
    return jobs.filter((job): job is QueuedJob => job !== null);
  }

  async requeueFailedExtractions(limit: number): Promise<QueuedJob[]> {
    const snapshot = await this.db.collection("extractionJobs")
      .where("status", "==", "failed").limit(limit).get();
    return this.resetJobs(snapshot.docs.map((doc) => doc.data() as ExtractionJobDocument), true);
  }

  /** Returns the jobs to re-enqueue. `clearHistory` also clears the link-only record on the article. */
  private async resetJobs(jobs: ExtractionJobDocument[], clearHistory: boolean): Promise<QueuedJob[]> {
    if (!jobs.length) return [];
    const reset: QueuedJob[] = [];
    await mapConcurrent(jobs, WRITE_CONCURRENCY, async (job) => {
      const queued = await this.resetJob(job, clearHistory);
      if (queued) reset.push(queued);
    });
    return reset;
  }

  private async resetJob(job: ExtractionJobDocument, clearHistory: boolean): Promise<QueuedJob | null> {
    const jobRef = this.db.collection("extractionJobs").doc(job.articleId);
    const articleRef = this.db.collection("articles").doc(job.articleId);
    return this.db.runTransaction(async (transaction) => {
      const currentSnap = await transaction.get(jobRef);
      const current = currentSnap.data() as ExtractionJobDocument | undefined;
      if (!current) return null;
      const stillSelected = clearHistory
        ? current.status === "failed"
        : current.status === "processing" && current.processingStartedAt === job.processingStartedAt;
      if (!stillSelected) return null;

      // Firestore transactions require all reads before writes.
      const articleSnap = clearHistory ? await transaction.get(articleRef) : null;
      const now = new Date().toISOString();
      const generation = (current.taskGeneration ?? 0) + 1;
      transaction.update(jobRef, {
        status: "pending", processingStartedAt: null, updatedAt: now,
        taskGeneration: generation, taskPriority: current.priority, taskDispatchState: "needs_dispatch",
        ...(clearHistory ? { attempts: 0, lastError: null } : {}),
      });
      if (articleSnap?.exists) {
        transaction.update(articleRef, {
          extractionStatus: "pending", extractionFailureClass: null, updatedAt: now,
        });
      }
      return { articleId: current.articleId, priority: current.priority, generation };
    });
  }
}

function initialArchivedThreadScan(isThread: boolean) {
  return { archivedThreadScanBefore: null, archivedThreadScanComplete: isThread };
}

function articleId(url: string): string {
  return createHash("sha256").update(url).digest("hex");
}

function maxString(...values: Array<string | undefined>): string {
  return values.filter((value): value is string => Boolean(value)).sort().at(-1)!;
}

function mapSearchPage(rows: Array<{ id: string; data: ArticleDocument }>, offset: number): SearchResponse {
  const items = rows.slice(0, PAGE_SIZE).map(({ id, data }): ArticleResult => ({
    id,
    title: data.title || data.domain,
    url: data.normalizedUrl,
    domain: data.domain,
    excerpt: data.excerpt,
    extractionStatus: data.extractionStatus,
    latestOccurrence: data.latestOccurrence,
  }));
  return { items, nextCursor: encodeNextCursor(offset, PAGE_SIZE, rows.length > PAGE_SIZE) };
}
