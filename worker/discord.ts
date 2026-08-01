import { splitConfig } from "./auth";
import { getAdminStatus, persistDiscordMessages } from "./database";
import type {
  DiscordChannel,
  DiscordMessage,
  DiscordThreadList,
  Env,
  ExtractionMessage,
} from "./types";

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_PAGE_SIZE = 100;

interface CursorRow {
  channel_id: string;
  channel_name: string;
  live_after_id: string | null;
  backfill_before_id: string | null;
  backfill_complete: number;
  initialized: number;
}

interface PendingJobRow {
  article_id: number;
  priority: number;
}

export async function runScheduledIngestion(env: Env): Promise<void> {
  assertDiscordConfiguration(env);
  await resetStaleJobs(env.DB);
  await discoverChannels(env);

  const cursors = await env.DB.prepare(
    `SELECT channel_id, channel_name, live_after_id, backfill_before_id,
            backfill_complete, initialized
     FROM channel_cursors
     ORDER BY is_thread, channel_name`,
  ).all<CursorRow>();

  for (const cursor of cursors.results) {
    if (!cursor.initialized) await initializeChannel(env, cursor);
    else await pollLiveMessages(env, cursor);
  }

  await runOneBackfillPage(env);
  await dispatchPendingJobs(env);
}

async function discoverChannels(env: Env): Promise<void> {
  const configured = splitConfig(env.DISCORD_CHANNEL_IDS);
  if (!configured.length) throw new Error("DISCORD_CHANNEL_IDS is empty");

  const discovered: Array<{ channel: DiscordChannel; isThread: boolean }> = [];
  const threadParentIds: string[] = [];
  for (const channelId of configured) {
    const channel = await discordFetch<DiscordChannel>(env, `/channels/${channelId}`);
    if ([0, 5].includes(channel.type)) discovered.push({ channel, isThread: false });
    if ([0, 5, 15, 16].includes(channel.type)) threadParentIds.push(channel.id);
  }

  const active = await discordFetch<DiscordThreadList>(
    env,
    `/guilds/${env.DISCORD_GUILD_ID}/threads/active`,
  );
  const parents = new Set(configured);
  for (const thread of active.threads) {
    if (thread.parent_id && parents.has(thread.parent_id) && [10, 11].includes(thread.type)) {
      discovered.push({ channel: thread, isThread: true });
    }
  }
  await upsertChannels(env.DB, discovered);

  const state = await env.DB.prepare(
    "SELECT value FROM system_state WHERE key = 'backfill_enabled'",
  ).first<{ value: string }>();
  if (state?.value === "1") await discoverOneArchivedThreadPage(env, threadParentIds);
}

async function discoverOneArchivedThreadPage(env: Env, channelIds: string[]): Promise<void> {
  for (const channelId of channelIds) {
    const stateKey = `archived_threads_before:${channelId}`;
    const state = await env.DB.prepare("SELECT value FROM system_state WHERE key = ?")
      .bind(stateKey).first<{ value: string }>();
    if (state?.value === "complete") continue;

    const suffix = state?.value ? `&before=${encodeURIComponent(state.value)}` : "";
    const result = await discordFetch<DiscordThreadList>(
      env,
      `/channels/${channelId}/threads/archived/public?limit=100${suffix}`,
    );
    await upsertChannels(
      env.DB,
      result.threads.map((thread) => ({ channel: thread, isThread: true })),
    );

    const oldest = result.threads.at(-1)?.thread_metadata?.archive_timestamp;
    const nextValue = result.has_more && oldest ? oldest : "complete";
    await setSystemState(env.DB, stateKey, nextValue);
    break;
  }
}

async function initializeChannel(env: Env, cursor: CursorRow): Promise<void> {
  const messages = await discordFetch<DiscordMessage[]>(
    env,
    `/channels/${cursor.channel_id}/messages?limit=${MESSAGE_PAGE_SIZE}`,
  );
  if (messages.length) {
    await persistDiscordMessages(env, messages, cursor.channel_name, 0);
  }
  const newest = maximumSnowflake(messages.map((message) => message.id));
  const oldest = minimumSnowflake(messages.map((message) => message.id));
  const now = new Date().toISOString();
  await env.DB.prepare(
    `UPDATE channel_cursors
     SET initialized = 1, live_after_id = ?, backfill_before_id = ?,
         backfill_complete = ?, updated_at = ?
     WHERE channel_id = ?`,
  ).bind(newest, oldest, messages.length < MESSAGE_PAGE_SIZE ? 1 : 0, now, cursor.channel_id).run();
}

async function pollLiveMessages(env: Env, cursor: CursorRow): Promise<void> {
  if (!cursor.live_after_id) return;
  let after = cursor.live_after_id;
  for (let page = 0; page < 10; page += 1) {
    const messages = await discordFetch<DiscordMessage[]>(
      env,
      `/channels/${cursor.channel_id}/messages?after=${after}&limit=${MESSAGE_PAGE_SIZE}`,
    );
    if (!messages.length) return;
    await persistDiscordMessages(env, messages, cursor.channel_name, 0);
    const newest = maximumSnowflake(messages.map((message) => message.id));
    if (!newest || newest === after) return;
    after = newest;
    await env.DB.prepare(
      "UPDATE channel_cursors SET live_after_id = ?, updated_at = ? WHERE channel_id = ?",
    ).bind(after, new Date().toISOString(), cursor.channel_id).run();
    if (messages.length < MESSAGE_PAGE_SIZE) return;
  }
}

async function runOneBackfillPage(env: Env): Promise<void> {
  const status = await getAdminStatus(env);
  if (status.backfillPausedReason) return;

  const cursor = await env.DB.prepare(
    `SELECT channel_id, channel_name, live_after_id, backfill_before_id,
            backfill_complete, initialized
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
  if (messages.length) await persistDiscordMessages(env, messages, cursor.channel_name, 10);
  const oldest = minimumSnowflake(messages.map((message) => message.id));
  await env.DB.prepare(
    `UPDATE channel_cursors
     SET backfill_before_id = coalesce(?, backfill_before_id),
         backfill_complete = ?, updated_at = ?
     WHERE channel_id = ?`,
  ).bind(oldest, messages.length < MESSAGE_PAGE_SIZE ? 1 : 0, new Date().toISOString(), cursor.channel_id).run();
}

async function dispatchPendingJobs(env: Env): Promise<void> {
  const status = await getAdminStatus(env);
  const live = await env.DB.prepare(
    `SELECT article_id, priority FROM extraction_jobs
     WHERE status = 'pending' AND priority = 0
       AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
     ORDER BY created_at LIMIT 5`,
  ).bind(new Date().toISOString()).all<PendingJobRow>();

  const jobs = [...live.results];
  if (!status.backfillPausedReason && jobs.length < 5) {
    const historical = await env.DB.prepare(
      `SELECT article_id, priority FROM extraction_jobs
       WHERE status = 'pending' AND priority > 0
         AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
       ORDER BY created_at LIMIT 1`,
    ).bind(new Date().toISOString()).all<PendingJobRow>();
    jobs.push(...historical.results);
  }

  for (const job of jobs) {
    const message: ExtractionMessage = { articleId: job.article_id };
    try {
      await env.EXTRACTION_QUEUE.send(message);
      await env.DB.prepare(
        "UPDATE extraction_jobs SET status = 'enqueued', updated_at = ? WHERE article_id = ?",
      ).bind(new Date().toISOString(), job.article_id).run();
    } catch (error) {
      console.error("Could not enqueue extraction job", job.article_id, error);
    }
  }
}

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
  if (!values.length) return;
  const now = new Date().toISOString();
  const statements = values.map(({ channel, isThread }) => db.prepare(
    `INSERT INTO channel_cursors (
      channel_id, guild_id, parent_id, channel_name, is_thread, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(channel_id) DO UPDATE SET
      parent_id = excluded.parent_id,
      channel_name = excluded.channel_name,
      is_thread = excluded.is_thread,
      updated_at = excluded.updated_at`,
  ).bind(
    channel.id,
    channel.guild_id || "",
    channel.parent_id || null,
    channel.name || channel.id,
    isThread ? 1 : 0,
    now,
  ));
  for (let index = 0; index < statements.length; index += 50) {
    await db.batch(statements.slice(index, index + 50));
  }
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

async function setSystemState(db: D1Database, key: string, value: string): Promise<void> {
  await db.prepare(
    `INSERT INTO system_state(key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).bind(key, value, new Date().toISOString()).run();
}

function minimumSnowflake(values: string[]): string | null {
  return values.reduce<string | null>(
    (minimum, value) => minimum === null || BigInt(value) < BigInt(minimum) ? value : minimum,
    null,
  );
}

function maximumSnowflake(values: string[]): string | null {
  return values.reduce<string | null>(
    (maximum, value) => maximum === null || BigInt(value) > BigInt(maximum) ? value : maximum,
    null,
  );
}

function assertDiscordConfiguration(env: Env): void {
  if (!env.DISCORD_BOT_TOKEN || !env.DISCORD_GUILD_ID) {
    throw new Error("Discord polling is not configured");
  }
}
