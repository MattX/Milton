import { runBatched } from "./d1";
import { backfillPolicy } from "./backfill-policy";
import { extremeSnowflake, initialChannelCursor } from "./discord-cursors";
import {
  loadBackfillGate,
  persistDiscordMessages,
} from "./database";
import { runtimeLimits } from "./limits";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordThreadList,
  Env,
  ExtractionMessage,
} from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_PAGE_SIZE = 100;

/**
 * Workers Free allows 50 subrequests per invocation, and every Discord fetch and D1
 * call counts. The cron runs each minute, so capping the channels polled per run
 * keeps a guild with many threads within budget; cursors round-robin by updated_at.
 */
const CHANNELS_PER_RUN = 12;
const PAGES_PER_CHANNEL = 3;

const TEXT_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_TYPES = new Set([10, 11]);

/** Live links are indexed ahead of history; see extraction_jobs.priority. */
const LIVE_PRIORITY = 0;
const HISTORY_PRIORITY = 10;

interface CursorRow {
  channel_id: string;
  channel_name: string;
  live_after_id: string | null;
  backfill_before_id: string | null;
  initialized: number;
}

export async function runScheduledIngestion(env: Env): Promise<void> {
  assertDiscordConfiguration(env);
  await resetStaleJobs(env.DB);
  await step("channel discovery", () => discoverChannels(env));

  const cursors = await env.DB.prepare(
    `SELECT channel_id, channel_name, live_after_id, backfill_before_id, initialized
     FROM channel_cursors
     ORDER BY updated_at
     LIMIT ?`,
  ).bind(CHANNELS_PER_RUN).all<CursorRow>();

  for (const cursor of cursors.results) {
    await step(`channel #${cursor.channel_name}`, () => (
      cursor.initialized ? pollLiveMessages(env, cursor) : initializeChannel(env, cursor)
    ));
  }

  const policy = backfillPolicy(await loadBackfillGate(env.DB), runtimeLimits(env));
  if (policy.mayFetchHistory) await step("backfill", () => runOneBackfillPage(env));
  await step("dispatch", () => dispatchPendingJobs(env, policy.mayDispatchHistory));
}

/** One failing channel must not cost us the rest of the run. */
async function step(label: string, run: () => Promise<void>): Promise<void> {
  try {
    await run();
  } catch (error) {
    console.error(`Milton ingestion step failed (${label})`, error);
  }
}

async function discoverChannels(env: Env): Promise<void> {
  // Both endpoints are guild-scoped, so a mistaken channel ID cannot cross the
  // guild's authorization boundary. Discord omits threads from the channel list.
  const [channels, active] = await Promise.all([
    discordFetch<DiscordChannel[]>(env, `/guilds/${env.DISCORD_GUILD_ID}/channels`),
    discordFetch<DiscordThreadList>(env, `/guilds/${env.DISCORD_GUILD_ID}/threads/active`),
  ]);
  const discovered = [
    ...channels.filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type))
      .map((channel) => ({ channel, isThread: false })),
    ...active.threads.filter((thread) => THREAD_TYPES.has(thread.type))
      .map((channel) => ({ channel, isThread: true })),
  ];

  await upsertChannels(env.DB, discovered, env.DISCORD_GUILD_ID);
  await retireInactiveThreads(env.DB, new Set(active.threads.map((thread) => thread.id)));
}

/**
 * Establish the live/history boundary without indexing existing messages. Backfill
 * begins just above the newest snowflake, while subsequent messages are live.
 */
async function initializeChannel(env: Env, cursor: CursorRow): Promise<void> {
  const startedAt = Date.now();
  const messages = await discordFetch<DiscordMessage[]>(
    env,
    `/channels/${cursor.channel_id}/messages?limit=${MESSAGE_PAGE_SIZE}`,
  );
  const initial = initialChannelCursor(messages.map((message) => message.id), startedAt);
  await env.DB.prepare(
    `UPDATE channel_cursors
     SET initialized = ?, live_after_id = ?, backfill_before_id = ?,
         backfill_complete = ?, updated_at = ?
     WHERE channel_id = ?`,
  ).bind(
    1,
    initial.liveAfterId,
    initial.backfillBeforeId,
    initial.backfillComplete ? 1 : 0,
    new Date().toISOString(),
    cursor.channel_id,
  ).run();
}

async function pollLiveMessages(env: Env, cursor: CursorRow): Promise<void> {
  let after = cursor.live_after_id;
  try {
    for (let page = 0; after && page < PAGES_PER_CHANNEL; page += 1) {
      const messages = await discordFetch<DiscordMessage[]>(
        env,
        `/channels/${cursor.channel_id}/messages?after=${after}&limit=${MESSAGE_PAGE_SIZE}`,
      );
      if (!messages.length) break;
      await persistDiscordMessages(env, messages, cursor.channel_name, LIVE_PRIORITY);
      const newest = extremeSnowflake(messages.map((message) => message.id), "max");
      if (!newest || newest === after) break;
      after = newest;
      if (messages.length < MESSAGE_PAGE_SIZE) break;
    }
  } finally {
    // Always runs, so a mid-catch-up failure keeps the progress already made and
    // the round-robin ordering still advances past this channel.
    await env.DB.prepare(
      `UPDATE channel_cursors SET live_after_id = coalesce(?, live_after_id), updated_at = ?
       WHERE channel_id = ?`,
    ).bind(after, new Date().toISOString(), cursor.channel_id).run();
  }
}

async function runOneBackfillPage(env: Env): Promise<void> {
  const cursor = await env.DB.prepare(
    `SELECT channel_id, channel_name, live_after_id, backfill_before_id, initialized
     FROM channel_cursors
     WHERE initialized = 1 AND backfill_complete = 0 AND backfill_before_id IS NOT NULL
     ORDER BY updated_at
     LIMIT 1`,
  ).first<CursorRow>();
  if (!cursor?.backfill_before_id) return;

  const messages = await discordFetch<DiscordMessage[]>(
    env,
    `/channels/${cursor.channel_id}/messages?before=${cursor.backfill_before_id}&limit=${MESSAGE_PAGE_SIZE}`,
  );
  if (messages.length) {
    await persistDiscordMessages(env, messages, cursor.channel_name, HISTORY_PRIORITY);
  }

  await env.DB.prepare(
    `UPDATE channel_cursors
     SET backfill_before_id = coalesce(?, backfill_before_id),
         backfill_complete = ?, updated_at = ?
     WHERE channel_id = ?`,
  ).bind(
    extremeSnowflake(messages.map((message) => message.id), "min"),
    messages.length < MESSAGE_PAGE_SIZE ? 1 : 0,
    new Date().toISOString(),
    cursor.channel_id,
  ).run();
}

async function dispatchPendingJobs(env: Env, includeBackfill: boolean): Promise<void> {
  const now = new Date().toISOString();
  const ready = async (priority: "= 0" | "> 0", limit: number) => {
    const result = await env.DB.prepare(
      `SELECT article_id FROM extraction_jobs
       WHERE status = 'pending' AND priority ${priority}
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT ?`,
    ).bind(now, limit).all<{ article_id: number }>();
    return result.results;
  };

  const jobs = await ready("= 0", 5);
  if (includeBackfill && jobs.length < 5) jobs.push(...await ready("> 0", 1));

  for (const job of jobs) {
    try {
      const message: ExtractionMessage = { articleId: job.article_id };
      await env.EXTRACTION_QUEUE.send(message);
      await env.DB.prepare(
        "UPDATE extraction_jobs SET status = 'enqueued', updated_at = ? WHERE article_id = ?",
      ).bind(new Date().toISOString(), job.article_id).run();
    } catch (error) {
      console.error("Could not enqueue extraction job", job.article_id, error);
    }
  }
}

/** Recovers jobs whose queue message was lost or whose consumer died mid-flight. */
async function resetStaleJobs(db: D1Database): Promise<void> {
  const cutoff = new Date(Date.now() - 15 * 60 * 1000).toISOString();
  await db.prepare(
    `UPDATE extraction_jobs SET status = 'pending', updated_at = ?
     WHERE status IN ('enqueued', 'processing') AND updated_at < ?`,
  ).bind(new Date().toISOString(), cutoff).run();
}

async function upsertChannels(
  db: D1Database,
  values: Array<{ channel: DiscordChannel; isThread: boolean }>,
  guildId: string,
): Promise<void> {
  const now = new Date().toISOString();
  await runBatched(db, values.map(({ channel, isThread }) => db.prepare(
    `INSERT INTO channel_cursors (
      channel_id, guild_id, parent_id, channel_name, is_thread, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      parent_id = excluded.parent_id,
      channel_name = excluded.channel_name,
      is_thread = excluded.is_thread`,
    // updated_at is deliberately not refreshed here: it orders the polling
    // round-robin, so rediscovery must not push a channel back to the front.
  ).bind(
    channel.id,
    guildId,
    channel.parent_id || null,
    channel.name || channel.id,
    isThread ? 1 : 0,
    now,
  )));
}

async function retireInactiveThreads(db: D1Database, activeIds: Set<string>): Promise<void> {
  const existing = await db.prepare("SELECT channel_id FROM channel_cursors WHERE is_thread = 1")
    .all<{ channel_id: string }>();
  await runBatched(db, existing.results
    .filter((row) => !activeIds.has(row.channel_id))
    .map((row) => db.prepare("DELETE FROM channel_cursors WHERE channel_id = ?").bind(row.channel_id)));
}

async function discordFetch<T>(env: Env, path: string): Promise<T> {
  const response = await fetch(`${DISCORD_API}${path}`, {
    headers: {
      authorization: `Bot ${env.DISCORD_BOT_TOKEN}`,
      "user-agent": "DiscordBot (https://github.com/MattX/milton, 2.0)",
    },
  });
  if (response.status === 429) {
    const retryAfter = response.headers.get("retry-after") || "unknown";
    throw new Error(`Discord rate limited ${path}; retry after ${retryAfter}s`);
  }
  if (!response.ok) {
    const body = (await response.text()).slice(0, 500);
    throw new Error(`Discord ${response.status} for ${path}: ${body}`);
  }
  return response.json<T>();
}

function assertDiscordConfiguration(env: Env): void {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
    throw new Error("Discord polling is not configured");
  }
}
