import type {
  AdminStatus,
  ArticleResult,
  OccurrenceResult,
  SearchResponse,
} from "../shared/api";
import { chunk, runBatched } from "./d1";
import { decodeCursor, encodeCursor, toFtsQuery } from "./search-query";
import { MAX_BACKFILL_BACKLOG, runtimeLimits, type RuntimeLimits } from "./limits";
import { BACKFILL_ENABLED, setState } from "./state";
import type { DiscordMessage, Env } from "./types";
import { extractLinks, fallbackTitle } from "./urls";

const PAGE_SIZE = 20;
interface ArticleRow {
  id: number;
  normalized_url: string;
  domain: string;
  title: string;
  excerpt: string;
  extraction_status: "pending" | "indexed" | "failed";
  first_posted_at: string;
  last_posted_at: string;
  occurrence_count: number;
}

interface OccurrenceRow {
  id: number;
  article_id: number;
  channel_name: string;
  author_name: string;
  posted_at: string;
  message_url: string;
}

export async function persistDiscordMessages(
  env: Env,
  messages: DiscordMessage[],
  channelName: string,
  priority: 0 | 10,
): Promise<void> {
  const now = new Date().toISOString();
  const linkRecords: Array<{
    normalizedUrl: string;
    originalUrl: string;
    domain: string;
    title: string;
    message: DiscordMessage;
  }> = [];
  const articles = new Map<string, {
    normalizedUrl: string;
    originalUrl: string;
    domain: string;
    title: string;
    firstPostedAt: string;
    lastPostedAt: string;
  }>();

  for (const message of messages) {
    const links = extractLinks(message.content);
    for (const link of links) {
      const embedTitle = message.embeds?.find((embed) => {
        if (!embed.url) return false;
        try {
          return new URL(embed.url).hostname === link.domain;
        } catch {
          return false;
        }
      })?.title;
      const title = (embedTitle || fallbackTitle(link.normalizedUrl)).slice(0, 300);
      linkRecords.push({ ...link, title, message });
      const existing = articles.get(link.normalizedUrl);
      articles.set(link.normalizedUrl, {
        normalizedUrl: link.normalizedUrl,
        originalUrl: link.originalUrl,
        domain: link.domain,
        title: existing?.title || title,
        firstPostedAt: existing && existing.firstPostedAt < message.timestamp
          ? existing.firstPostedAt
          : message.timestamp,
        lastPostedAt: existing && existing.lastPostedAt > message.timestamp
          ? existing.lastPostedAt
          : message.timestamp,
      });
    }
  }

  if (!linkRecords.length) return;

  await runBatched(env.DB, [...articles.values()].map((article) => env.DB.prepare(
    `INSERT INTO articles (
       normalized_url, original_url, domain, title,
       first_posted_at, last_posted_at, created_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(normalized_url) DO UPDATE SET
       original_url = excluded.original_url,
       title = CASE WHEN articles.title = '' THEN excluded.title ELSE articles.title END,
       first_posted_at = min(articles.first_posted_at, excluded.first_posted_at),
       last_posted_at = max(articles.last_posted_at, excluded.last_posted_at),
       updated_at = excluded.updated_at`,
  ).bind(
    article.normalizedUrl,
    article.originalUrl,
    article.domain,
    article.title,
    article.firstPostedAt,
    article.lastPostedAt,
    now,
    now,
  )));

  const storedArticles = new Map<string, { id: number; extractionStatus: string }>();
  for (const urlChunk of chunk([...articles.keys()], 90)) {
    const placeholders = urlChunk.map(() => "?").join(",");
    const result = await env.DB.prepare(
      `SELECT id, normalized_url, extraction_status FROM articles
       WHERE normalized_url IN (${placeholders})`,
    ).bind(...urlChunk).all<{ id: number; normalized_url: string; extraction_status: string }>();
    for (const row of result.results) {
      storedArticles.set(row.normalized_url, { id: row.id, extractionStatus: row.extraction_status });
    }
  }

  const occurrences: D1PreparedStatement[] = [];
  const seen = new Set<string>();
  for (const record of linkRecords) {
    const article = storedArticles.get(record.normalizedUrl);
    if (!article) throw new Error(`Could not find stored article ${record.normalizedUrl}`);
    const key = `${article.id}:${record.message.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    occurrences.push(env.DB.prepare(
      `INSERT OR IGNORE INTO occurrences (
         article_id, guild_id, channel_id, channel_name, message_id,
         author_id, author_name, posted_at, message_url
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      article.id,
      env.DISCORD_GUILD_ID,
      record.message.channel_id,
      channelName,
      record.message.id,
      record.message.author.id,
      record.message.author.global_name || record.message.author.username,
      record.message.timestamp,
      `https://discord.com/channels/${env.DISCORD_GUILD_ID}/${record.message.channel_id}/${record.message.id}`,
    ));
  }
  await runBatched(env.DB, occurrences);

  await runBatched(env.DB, [...storedArticles.values()]
    .filter((article) => article.extractionStatus === "pending")
    .map((article) => env.DB.prepare(
      `INSERT INTO extraction_jobs (
         article_id, priority, status, attempts, created_at, updated_at
       ) VALUES (?, ?, 'pending', 0, ?, ?)
       ON CONFLICT(article_id) DO UPDATE SET
         priority = min(extraction_jobs.priority, excluded.priority),
         updated_at = excluded.updated_at`,
    ).bind(article.id, priority, now, now)));
}

export async function searchArticles(
  db: D1Database,
  query: string,
  cursor: string | null,
): Promise<SearchResponse> {
  const offset = decodeCursor(cursor);
  const ftsQuery = toFtsQuery(query);
  let rows: ArticleRow[];

  if (ftsQuery) {
    const result = await db.prepare(
      `SELECT
        a.id, a.normalized_url, a.domain, a.title, a.excerpt,
        a.extraction_status, a.first_posted_at, a.last_posted_at,
        (SELECT count(*) FROM occurrences o WHERE o.article_id = a.id) AS occurrence_count
      FROM articles_fts
      JOIN articles a ON a.id = articles_fts.rowid
      WHERE articles_fts MATCH ?
      ORDER BY bm25(articles_fts, 7.0, 2.0, 1.0), a.last_posted_at DESC
      LIMIT ? OFFSET ?`,
    ).bind(ftsQuery, PAGE_SIZE + 1, offset).all<ArticleRow>();
    rows = result.results;
  } else {
    const result = await db.prepare(
      `SELECT
        a.id, a.normalized_url, a.domain, a.title, a.excerpt,
        a.extraction_status, a.first_posted_at, a.last_posted_at,
        (SELECT count(*) FROM occurrences o WHERE o.article_id = a.id) AS occurrence_count
      FROM articles a
      ORDER BY a.last_posted_at DESC, a.id DESC
      LIMIT ? OFFSET ?`,
    ).bind(PAGE_SIZE + 1, offset).all<ArticleRow>();
    rows = result.results;
  }

  const hasMore = rows.length > PAGE_SIZE;
  const pageRows = rows.slice(0, PAGE_SIZE);
  const latest = await latestOccurrences(db, pageRows.map((row) => row.id));
  const items = pageRows.flatMap((row): ArticleResult[] => {
    const occurrence = latest.get(row.id);
    if (!occurrence) return [];
    return [{
      id: row.id,
      title: row.title || row.domain,
      url: row.normalized_url,
      domain: row.domain,
      excerpt: row.excerpt,
      extractionStatus: row.extraction_status,
      firstPostedAt: row.first_posted_at,
      lastPostedAt: row.last_posted_at,
      occurrenceCount: row.occurrence_count,
      latestOccurrence: mapOccurrence(occurrence),
    }];
  });

  return {
    items,
    nextCursor: hasMore ? encodeCursor(offset + PAGE_SIZE) : null,
  };
}

export async function listOccurrences(
  db: D1Database,
  articleId: number,
  cursor: string | null,
): Promise<{ items: OccurrenceResult[]; nextCursor: string | null }> {
  const offset = decodeCursor(cursor);
  const result = await db.prepare(
    `SELECT id, article_id, channel_name, author_name, posted_at, message_url
     FROM occurrences
     WHERE article_id = ?
     ORDER BY posted_at DESC, id DESC
     LIMIT ? OFFSET ?`,
  ).bind(articleId, PAGE_SIZE + 1, offset).all<OccurrenceRow>();
  const hasMore = result.results.length > PAGE_SIZE;
  return {
    items: result.results.slice(0, PAGE_SIZE).map(mapOccurrence),
    nextCursor: hasMore ? encodeCursor(offset + PAGE_SIZE) : null,
  };
}

/** The inputs that decide whether historical backfill may run right now. */
export interface BackfillGate {
  enabled: boolean;
  browserMillisecondsToday: number;
  pendingBackfillJobs: number;
}

export function utcDay(at: Date = new Date()): string {
  return at.toISOString().slice(0, 10);
}

export async function browserUsageToday(db: D1Database): Promise<number> {
  const row = await db.prepare("SELECT milliseconds FROM browser_usage WHERE usage_date = ?")
    .bind(utcDay()).first<{ milliseconds: number }>();
  return row?.milliseconds ?? 0;
}

/**
 * One round trip, so the scheduled handler can cheaply ask "may I backfill?"
 * without assembling the whole admin payload.
 */
export async function loadBackfillGate(db: D1Database): Promise<BackfillGate> {
  const row = await db.prepare(
    `SELECT
      (SELECT value FROM system_state WHERE key = ?) enabled,
      (SELECT milliseconds FROM browser_usage WHERE usage_date = ?) browser_ms,
      (SELECT count(*) FROM extraction_jobs
        WHERE status IN ('pending', 'enqueued', 'processing') AND priority > 0) pending_backfill`,
  ).bind(BACKFILL_ENABLED, utcDay())
    .first<{ enabled: string | null; browser_ms: number | null; pending_backfill: number }>();

  return {
    enabled: row?.enabled === "1",
    browserMillisecondsToday: row?.browser_ms ?? 0,
    pendingBackfillJobs: row?.pending_backfill ?? 0,
  };
}

export function backfillPausedReason(gate: BackfillGate, limits: RuntimeLimits): string | null {
  if (!gate.enabled) return "Backfill has not been started.";
  if (gate.browserMillisecondsToday >= limits.backfillDailyBudgetMs) {
    return "The historical Browser Run budget is exhausted for today.";
  }
  if (gate.pendingBackfillJobs >= MAX_BACKFILL_BACKLOG) {
    return `The historical extraction backlog has reached ${MAX_BACKFILL_BACKLOG} articles.`;
  }
  return null;
}

export async function getAdminStatus(env: Env): Promise<AdminStatus> {
  const limits = runtimeLimits(env);
  const [gate, jobs, channels] = await Promise.all([
    loadBackfillGate(env.DB),
    env.DB.prepare(
      `SELECT
        sum(CASE WHEN status IN ('pending', 'enqueued', 'processing') AND priority = 0 THEN 1 ELSE 0 END) pending_live,
        sum(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) failed
       FROM extraction_jobs`,
    ).first<{ pending_live: number | null; failed: number | null }>(),
    env.DB.prepare(
      `SELECT count(*) total, sum(CASE WHEN backfill_complete = 1 THEN 1 ELSE 0 END) complete
       FROM channel_cursors`,
    ).first<{ total: number; complete: number | null }>(),
  ]);

  return {
    browserMillisecondsToday: gate.browserMillisecondsToday,
    browserDailyLimitMilliseconds: limits.browserDailyLimitMs,
    backfillEnabled: gate.enabled,
    backfillPausedReason: backfillPausedReason(gate, limits),
    pendingLiveJobs: jobs?.pending_live ?? 0,
    pendingBackfillJobs: gate.pendingBackfillJobs,
    failedJobs: jobs?.failed ?? 0,
    channelsComplete: channels?.complete ?? 0,
    channelsTotal: channels?.total ?? 0,
  };
}

export function setBackfillEnabled(db: D1Database, enabled: boolean): Promise<void> {
  return setState(db, BACKFILL_ENABLED, enabled ? "1" : "0");
}


async function latestOccurrences(
  db: D1Database,
  articleIds: number[],
): Promise<Map<number, OccurrenceRow>> {
  const output = new Map<number, OccurrenceRow>();
  if (!articleIds.length) return output;
  const placeholders = articleIds.map(() => "?").join(",");
  const result = await db.prepare(
    `SELECT id, article_id, channel_name, author_name, posted_at, message_url
     FROM occurrences
     WHERE article_id IN (${placeholders})
     ORDER BY posted_at DESC, id DESC`,
  ).bind(...articleIds).all<OccurrenceRow>();
  for (const row of result.results) {
    if (!output.has(row.article_id)) output.set(row.article_id, row);
  }
  return output;
}

function mapOccurrence(row: OccurrenceRow): OccurrenceResult {
  return {
    id: row.id,
    channelName: row.channel_name,
    authorName: row.author_name,
    postedAt: row.posted_at,
    messageUrl: row.message_url,
  };
}

