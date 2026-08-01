import { splitConfig } from "./config";
import { runBatched } from "./d1";
import {
  backfillPausedReason,
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
     ORDER BY is_thread, updated_at
     LIMIT ?`,
  ).bind(CHANNELS_PER_RUN).all<CursorRow>();

  for (const cursor of cursors.results) {
    await step(`channel #${cursor.channel_name}`, () => (
      cursor.initialized ? pollLiveMessages(env, cursor) : initializeChannel(env, cursor)
    ));
  }

  const paused = backfillPausedReason(await loadBackfillGate(env.DB), runtimeLimits(env));
  if (!paused) await step("backfill", () => runOneBackfillPage(env));
  await step("dispatch", () => dispatchPendingJobs(env, paused === null));
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
  const configured = splitConfig(env.DISCORD_CHANNEL_IDS);
  if (!configured.length) throw new Error("DISCORD_CHANNEL_IDS is empty");

  const discovered: Array<{ channel: DiscordChannel; isThread: boolean }> = [];
  for (const channelId of configured) {
    try {
      const channel = await discordFetch<DiscordChannel>(env, `/channels/${channelId}`);
      if (TEXT_CHANNEL_TYPES.has(channel.type)) discovered.push({ channel, isThread: false });
    } catch (error) {
      console.error(`Milton could not read channel ${channelId}`, error);
    }
  }

  // Active threads only. Archived threads stop receiving messages, so polling them
  // forever would grow channel_cursors without bound for no new content.
  const active = await discordFetch<DiscordThreadList>(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/threads/active`,
  );
  const parents = new Set(configured);
  for (const thread of active.threads) {
    if (thread.parent_id && parents.has(thread.parent_id) && THREAD_TYPES.has(thread.type)) {
      discovered.push({ channel: thread, isThread: true });
    }
  }

  await upsertChannels(env.DB, discovered);
}

/**
 * The first page of an existing channel is history, not news, so it is indexed at
 * backfill priority and stays behind the daily budget gate. Only messages that
 * arrive after this point count as live.
 */
async function initializeChannel(env: Env, cursor: CursorRow): Promise<void> {
  const messages = await discordFetch<DiscordMessage[]>(
    env,
    `/channels/${cursor.channel_id}/messages?limit=${MESSAGE_PAGE_SIZE}`,
  );
  if (messages.length) {
    await persistDiscordMessages(env, messages, cursor.channel_name, HISTORY_PRIORITY);
  }

  const ids = messages.map((message) => message.id);
  await env.DB.prepare(
    `UPDATE channel_cursors
     SET initialized = ?, live_after_id = ?, backfill_before_id = ?,
         backfill_complete = ?, updated_at = ?
     WHERE channel_id = ?`,
  ).bind(
    // An empty channel has no snowflake to poll after. Leaving it uninitialized
    // means we retry later instead of stranding it with a null cursor forever.
    messages.length ? 1 : 0,
    extremeSnowflake(ids, "max"),
    extremeSnowflake(ids, "min"),
    messages.length < MESSAGE_PAGE_SIZE ? 1 : 0,
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
    channel.guild_id || "",
    channel.parent_id || null,
    channel.name || channel.id,
    isThread ? 1 : 0,
    now,
  )));
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

function extremeSnowflake(values: string[], pick: "min" | "max"): string | null {
  return values.reduce<string | null>((chosen, value) => {
    if (chosen === null) return value;
    const isLower = BigInt(value) < BigInt(chosen);
    return isLower === (pick === "min") ? value : chosen;
  }, null);
}

function assertDiscordConfiguration(env: Env): void {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
    throw new Error("Discord polling is not configured");
  }
}
