import { createHash } from "node:crypto";
import { Firestore, Pipelines } from "@google-cloud/firestore";
import type { AdminStatus, ArticleResult, SearchResponse } from "../shared/api.js";
import { mapConcurrent } from "./concurrency.js";
import { initialChannelCursor } from "./discord-cursors.js";
import { decodeCursor, encodeCursor, normalizeSearchQuery } from "./search-query.js";
import type {
  ArticleDocument,
  ChannelCursorDocument,
  DiscordMessage,
  ExtractedArticle,
  ExtractionFailure,
  ExtractionJobDocument,
  JobPriority,
  LatestOccurrence,
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
}

export interface Repository {
  persistDiscordMessages(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<string[]>;
  search(query: string, cursor: string | null): Promise<SearchResponse>;
  getAdminStatus(): Promise<AdminStatus>;
  setBackfillEnabled(enabled: boolean): Promise<void>;
  isBackfillEnabled(): Promise<boolean>;
  upsertChannels(values: ChannelDiscovery[]): Promise<void>;
  listLiveChannels(limit: number): Promise<ChannelCursorDocument[]>;
  listLiveThreadIds(): Promise<string[]>;
  archiveChannels(channelIds: string[]): Promise<void>;
  updateCursor(channelId: string, values: Partial<ChannelCursorDocument>): Promise<void>;
  nextBackfillChannel(): Promise<ChannelCursorDocument | null>;
  claimExtraction(articleId: string): Promise<ExtractionClaim>;
  completeExtraction(articleId: string, outcome: ExtractedArticle): Promise<void>;
  failExtraction(articleId: string, failure: ExtractionFailure, terminal: boolean): Promise<void>;
  requeueStalledExtractions(staleBefore: Date, limit: number): Promise<QueuedJob[]>;
  requeueFailedExtractions(limit: number): Promise<QueuedJob[]>;
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
      transaction.set(jobRef, {
        articleId: id,
        // A live repost promotes a queued historical job.
        priority: job?.priority === "live" || priority === "live" ? "live" : "history",
        status: job?.status || "pending",
        attempts: job?.attempts || 0,
        lastError: job?.lastError ?? null,
        processingStartedAt: job?.processingStartedAt ?? null,
        createdAt: job?.createdAt || now,
        updatedAt: now,
      } satisfies ExtractionJobDocument);
      return true;
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
        // Only write when something actually changed; discovery runs every five minutes.
        if (existing.channelName === value.channelName && existing.archived === value.archived) continue;
        writer.update(ref, { channelName: value.channelName, archived: value.archived, updatedAt: now });
      } else {
        writer.create(ref, {
          channelId: value.channelId,
          channelName: value.channelName,
          isThread: value.isThread,
          archived: value.archived,
          ...initialChannelCursor(value.lastMessageId, Date.now()),
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

  async claimExtraction(articleIdValue: string): Promise<ExtractionClaim> {
    const articleRef = this.db.collection("articles").doc(articleIdValue);
    const jobRef = this.db.collection("extractionJobs").doc(articleIdValue);
    return this.db.runTransaction<ExtractionClaim>(async (transaction) => {
      const [articleSnap, jobSnap] = await Promise.all([transaction.get(articleRef), transaction.get(jobRef)]);
      if (!articleSnap.exists || !jobSnap.exists) return { status: "settled" };
      const article = articleSnap.data() as ArticleDocument;
      const job = jobSnap.data() as ExtractionJobDocument;
      if (article.extractionStatus === "indexed" || job.status === "completed" || job.status === "failed") {
        return { status: "settled" };
      }
      const leaseHeldSince = job.processingStartedAt ? Date.parse(job.processingStartedAt) : 0;
      if (job.status === "processing" && leaseHeldSince > Date.now() - LEASE_MS) return { status: "leased" };

      const now = new Date().toISOString();
      const claimed: ExtractionJobDocument = {
        ...job, status: "processing", attempts: job.attempts + 1, processingStartedAt: now, updatedAt: now,
      };
      transaction.set(jobRef, claimed);
      return { status: "claimed", article, job: claimed };
    });
  }

  async completeExtraction(articleIdValue: string, outcome: ExtractedArticle): Promise<void> {
    const now = new Date().toISOString();
    const batch = this.db.batch();
    batch.update(this.db.collection("articles").doc(articleIdValue), {
      ...(outcome.title ? { title: outcome.title } : {}),
      body: outcome.body,
      excerpt: outcome.excerpt,
      extractionStatus: "indexed",
      extractionMethod: outcome.method,
      extractionFailureClass: null,
      extractionHttpStatus: outcome.httpStatus,
      extractionContentLength: outcome.contentLength,
      extractionHostname: outcome.hostname,
      updatedAt: now,
    });
    batch.update(this.db.collection("extractionJobs").doc(articleIdValue), {
      status: "completed", lastError: null, processingStartedAt: null, updatedAt: now,
    });
    await batch.commit();
  }

  async failExtraction(articleIdValue: string, failure: ExtractionFailure, terminal: boolean): Promise<void> {
    const now = new Date().toISOString();
    const batch = this.db.batch();
    batch.update(this.db.collection("extractionJobs").doc(articleIdValue), {
      status: terminal ? "failed" : "pending",
      lastError: failure.message.slice(0, 1000),
      processingStartedAt: null,
      updatedAt: now,
    });
    if (terminal) {
      batch.update(this.db.collection("articles").doc(articleIdValue), {
        extractionStatus: "failed",
        extractionMethod: "link-only",
        extractionFailureClass: failure.failureClass,
        extractionHttpStatus: failure.httpStatus,
        extractionContentLength: failure.contentLength,
        extractionHostname: failure.hostname,
        updatedAt: now,
      });
    }
    await batch.commit();
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
    return this.resetJobs(snapshot.docs.map((doc) => doc.data() as ExtractionJobDocument), false);
  }

  async requeueFailedExtractions(limit: number): Promise<QueuedJob[]> {
    const snapshot = await this.db.collection("extractionJobs")
      .where("status", "==", "failed").limit(limit).get();
    return this.resetJobs(snapshot.docs.map((doc) => doc.data() as ExtractionJobDocument), true);
  }

  /** Returns the jobs to re-enqueue. `clearHistory` also clears the link-only record on the article. */
  private async resetJobs(jobs: ExtractionJobDocument[], clearHistory: boolean): Promise<QueuedJob[]> {
    if (!jobs.length) return [];
    const now = new Date().toISOString();
    const writer = this.db.bulkWriter();
    for (const job of jobs) {
      writer.update(this.db.collection("extractionJobs").doc(job.articleId), {
        status: "pending",
        processingStartedAt: null,
        updatedAt: now,
        ...(clearHistory ? { attempts: 0, lastError: null } : {}),
      });
      if (clearHistory) {
        writer.update(this.db.collection("articles").doc(job.articleId), {
          extractionStatus: "pending", extractionFailureClass: null, updatedAt: now,
        });
      }
    }
    await writer.close();
    return jobs.map((job) => ({ articleId: job.articleId, priority: job.priority }));
  }
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
  return { items, nextCursor: rows.length > PAGE_SIZE ? encodeCursor(offset + PAGE_SIZE) : null };
}
