import { createHash } from "node:crypto";
import {
  Firestore,
  Pipelines,
} from "@google-cloud/firestore";
import type { AdminStatus, ArticleResult, SearchResponse } from "../shared/api.js";
import { decodeCursor, encodeCursor, normalizeSearchQuery } from "./search-query.js";
import type {
  ArticleDocument,
  ChannelCursorDocument,
  DiscordMessage,
  ExtractionJobDocument,
  JobPriority,
  LatestOccurrence,
} from "./types.js";
import { extractLinks, fallbackTitle } from "./urls.js";

const PAGE_SIZE = 20;
const BACKFILL_ENABLED = "backfill_enabled";

export interface ExtractionOutcome {
  title: string | null;
  body: string;
  excerpt: string;
  method: string;
  httpStatus: number;
  contentLength: number;
  hostname: string;
}

export interface ExtractionFailure {
  failureClass: string;
  message: string;
  httpStatus: number | null;
  contentLength: number | null;
  hostname: string;
}

export interface Repository {
  persistDiscordMessages(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<string[]>;
  search(query: string, cursor: string | null): Promise<SearchResponse>;
  getAdminStatus(): Promise<AdminStatus>;
  setBackfillEnabled(enabled: boolean): Promise<void>;
  isBackfillEnabled(): Promise<boolean>;
  upsertChannels(values: Array<{ channelId: string; guildId: string; parentId: string | null; channelName: string; isThread: boolean }>): Promise<void>;
  listChannels(limit: number): Promise<ChannelCursorDocument[]>;
  listActiveThreadIds(): Promise<string[]>;
  deleteChannels(channelIds: string[]): Promise<void>;
  updateCursor(channelId: string, values: Partial<ChannelCursorDocument>): Promise<void>;
  nextBackfillChannel(): Promise<ChannelCursorDocument | null>;
  claimExtraction(articleId: string): Promise<{ article: ArticleDocument; job: ExtractionJobDocument } | null>;
  completeExtraction(articleId: string, outcome: ExtractionOutcome): Promise<void>;
  failExtraction(articleId: string, failure: ExtractionFailure, terminal: boolean): Promise<void>;
}

export class FirestoreRepository implements Repository {
  constructor(readonly db: Firestore, private readonly guildId: string) {}

  async persistDiscordMessages(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<string[]> {
    const records = new Map<string, { normalizedUrl: string; domain: string; occurrences: LatestOccurrence[] }>();
    for (const message of messages) {
      for (const link of extractLinks(message.content)) {
        const record = records.get(link.normalizedUrl) || { ...link, occurrences: [] };
        record.occurrences.push({
          id: occurrenceId(articleId(link.normalizedUrl), message.id),
          channelId: message.channel_id,
          channelName,
          authorName: message.author.global_name || message.author.username,
          postedAt: message.timestamp,
          messageUrl: `https://discord.com/channels/${this.guildId}/${message.channel_id}/${message.id}`,
        });
        records.set(link.normalizedUrl, record);
      }
    }

    const enqueue: string[] = [];
    const pendingRecords = [...records.values()];
    for (let offset = 0; offset < pendingRecords.length; offset += 10) {
      await Promise.all(pendingRecords.slice(offset, offset + 10).map(async (record) => {
      const id = articleId(record.normalizedUrl);
      const articleRef = this.db.collection("articles").doc(id);
      const jobRef = this.db.collection("extractionJobs").doc(id);
      const newest = record.occurrences.reduce((left, right) => right.postedAt > left.postedAt ? right : left);
      await this.db.runTransaction(async (transaction) => {
        const [articleSnap, jobSnap] = await Promise.all([transaction.get(articleRef), transaction.get(jobRef)]);
        const now = new Date().toISOString();
        const existing = articleSnap.data() as ArticleDocument | undefined;
        const latest = !existing || newest.postedAt >= existing.latestOccurrence.postedAt
          ? newest : existing.latestOccurrence;
        const article: ArticleDocument = {
          normalizedUrl: record.normalizedUrl,
          domain: record.domain,
          title: existing?.extractionStatus === "indexed" ? existing.title : fallbackTitle(record.normalizedUrl).slice(0, 300),
          body: existing?.body || "",
          excerpt: existing?.excerpt || "",
          extractionStatus: existing?.extractionStatus || "pending",
          extractionMethod: existing?.extractionMethod || null,
          extractionFailureClass: existing?.extractionFailureClass || null,
          extractionHttpStatus: existing?.extractionHttpStatus || null,
          extractionContentLength: existing?.extractionContentLength || null,
          extractionHostname: record.domain,
          firstPostedAt: minString(existing?.firstPostedAt, ...record.occurrences.map((item) => item.postedAt)),
          lastPostedAt: maxString(existing?.lastPostedAt, ...record.occurrences.map((item) => item.postedAt)),
          latestOccurrence: latest,
          createdAt: existing?.createdAt || now,
          updatedAt: now,
        };
        transaction.set(articleRef, article);
        for (const occurrence of record.occurrences) {
          transaction.set(this.db.collection("occurrences").doc(occurrence.id), { ...occurrence, articleId: id }, { merge: true });
        }
        const job = jobSnap.data() as ExtractionJobDocument | undefined;
        if (article.extractionStatus === "pending" && job?.status !== "completed" && job?.status !== "failed") {
          transaction.set(jobRef, {
            articleId: id,
            priority: job?.priority === "live" || priority === "live" ? "live" : "history",
            status: job?.status || "pending",
            attempts: job?.attempts || 0,
            lastError: job?.lastError || null,
            processingStartedAt: job?.processingStartedAt || null,
            createdAt: job?.createdAt || now,
            updatedAt: now,
          } satisfies ExtractionJobDocument);
          enqueue.push(id);
        }
      });
      }));
    }
    return [...new Set(enqueue)];
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
      rows = snapshot.results.flatMap((result) => result.id
        ? [{ id: result.id, data: result.data() as ArticleDocument }] : []);
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
      backfillPausedReason: backfillEnabled ? null : "Backfill has not been started.",
      pendingLiveJobs: live.data().count,
      pendingBackfillJobs: history.data().count,
      failedJobs: failed.data().count,
      channelsComplete: complete.data().count,
      channelsTotal: channels.data().count,
    };
  }

  async setBackfillEnabled(enabled: boolean): Promise<void> {
    await this.db.collection("systemState").doc(BACKFILL_ENABLED).set({ value: enabled, updatedAt: new Date().toISOString() });
  }

  async isBackfillEnabled(): Promise<boolean> {
    return (await this.db.collection("systemState").doc(BACKFILL_ENABLED).get()).data()?.value === true;
  }

  async upsertChannels(values: Array<{ channelId: string; guildId: string; parentId: string | null; channelName: string; isThread: boolean }>): Promise<void> {
    if (!values.length) return;
    const refs = values.map((value) => this.db.collection("discordCursors").doc(value.channelId));
    const snapshots = await this.db.getAll(...refs);
    const writer = this.db.bulkWriter();
    const now = new Date().toISOString();
    for (let index = 0; index < values.length; index += 1) {
      const value = values[index]!;
      const ref = refs[index]!;
      if (snapshots[index]!.exists) {
        writer.update(ref, { parentId: value.parentId, channelName: value.channelName, isThread: value.isThread });
      } else {
        writer.create(ref, {
          ...value, liveAfterId: null, backfillBeforeId: null, backfillComplete: false,
          initialized: false, updatedAt: now,
        } satisfies ChannelCursorDocument);
      }
    }
    await writer.close();
  }

  async listChannels(limit: number): Promise<ChannelCursorDocument[]> {
    const snapshot = await this.db.collection("discordCursors").orderBy("updatedAt").limit(limit).get();
    return snapshot.docs.map((doc) => doc.data() as ChannelCursorDocument);
  }

  async listActiveThreadIds(): Promise<string[]> {
    const snapshot = await this.db.collection("discordCursors").where("isThread", "==", true).get();
    return snapshot.docs.map((doc) => doc.id);
  }

  async deleteChannels(channelIds: string[]): Promise<void> {
    const writer = this.db.bulkWriter();
    for (const id of channelIds) writer.delete(this.db.collection("discordCursors").doc(id));
    await writer.close();
  }

  async updateCursor(channelId: string, values: Partial<ChannelCursorDocument>): Promise<void> {
    await this.db.collection("discordCursors").doc(channelId).update({ ...values, updatedAt: new Date().toISOString() });
  }

  async nextBackfillChannel(): Promise<ChannelCursorDocument | null> {
    const snapshot = await this.db.collection("discordCursors")
      .where("initialized", "==", true).where("backfillComplete", "==", false)
      .orderBy("updatedAt").limit(1).get();
    return snapshot.empty ? null : snapshot.docs[0]!.data() as ChannelCursorDocument;
  }

  async claimExtraction(articleIdValue: string): Promise<{ article: ArticleDocument; job: ExtractionJobDocument } | null> {
    const articleRef = this.db.collection("articles").doc(articleIdValue);
    const jobRef = this.db.collection("extractionJobs").doc(articleIdValue);
    return this.db.runTransaction(async (transaction) => {
      const [articleSnap, jobSnap] = await Promise.all([transaction.get(articleRef), transaction.get(jobRef)]);
      if (!articleSnap.exists || !jobSnap.exists) return null;
      const article = articleSnap.data() as ArticleDocument;
      const job = jobSnap.data() as ExtractionJobDocument;
      if (article.extractionStatus === "indexed" || job.status === "completed" || job.status === "failed") return null;
      const started = job.processingStartedAt ? Date.parse(job.processingStartedAt) : 0;
      if (job.status === "processing" && started > Date.now() - 5 * 60_000) return null;
      const claimed = { ...job, status: "processing" as const, attempts: job.attempts + 1, processingStartedAt: new Date().toISOString(), updatedAt: new Date().toISOString() };
      transaction.set(jobRef, claimed);
      return { article, job: claimed };
    });
  }

  async completeExtraction(articleIdValue: string, outcome: ExtractionOutcome): Promise<void> {
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
      lastError: failure.message.slice(0, 1000), processingStartedAt: null, updatedAt: now,
    });
    if (terminal) batch.update(this.db.collection("articles").doc(articleIdValue), {
      extractionStatus: "failed",
      extractionMethod: "link-only",
      extractionFailureClass: failure.failureClass,
      extractionHttpStatus: failure.httpStatus,
      extractionContentLength: failure.contentLength,
      extractionHostname: failure.hostname,
      updatedAt: now,
    });
    await batch.commit();
  }
}

function articleId(url: string): string { return createHash("sha256").update(url).digest("hex"); }
function occurrenceId(articleIdValue: string, messageId: string): string {
  return createHash("sha256").update(`${articleIdValue}\0${messageId}`).digest("hex");
}
function minString(...values: Array<string | undefined>): string { return values.filter((value): value is string => Boolean(value)).sort()[0]!; }
function maxString(...values: Array<string | undefined>): string { return values.filter((value): value is string => Boolean(value)).sort().at(-1)!; }

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
