import { mapConcurrent } from "./concurrency.js";
import { extremeSnowflake } from "./discord-cursors.js";
import { LEASE_MS, type ChannelDiscovery, type Repository } from "./repository.js";
import { retryToken, type TaskEnqueuer } from "./tasks.js";
import type { ChannelCursorDocument, Config, DiscordChannel, DiscordMessage, DiscordThreadList, JobPriority } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_PAGE_SIZE = 100;
const CHANNELS_PER_RUN = 12;
const CHANNEL_CONCURRENCY = 4;
const PAGES_PER_CHANNEL = 3;
const STALLED_JOBS_PER_RUN = 20;
const TEXT_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_TYPES = new Set([10, 11]);

/** Default wall-clock budget for one poll, kept under the Cloud Run request timeout. */
export const POLL_BUDGET_MS = 240_000;
/** Budget held back so the backfill still runs when live polling is slow. */
const BACKFILL_RESERVE_MS = 30_000;

export class DiscordIngestion {
  constructor(
    private readonly repository: Repository,
    private readonly tasks: TaskEnqueuer,
    private readonly config: Config,
  ) {}

  async run(budgetMs = POLL_BUDGET_MS): Promise<void> {
    const deadline = Date.now() + budgetMs;
    await this.step("channel discovery", () => this.discoverChannels());

    const channels = await this.repository.listLiveChannels(CHANNELS_PER_RUN);
    await mapConcurrent(channels, CHANNEL_CONCURRENCY, async (cursor) => {
      if (Date.now() > deadline - BACKFILL_RESERVE_MS) return;
      if (!cursor.isThread) {
        await this.step(`archived threads in #${cursor.channelName}`, () => this.discoverArchivedThreads(cursor));
      }
      await this.step(`channel #${cursor.channelName}`, () => this.pollLive(cursor));
    });

    await this.step("stalled extractions", () => this.requeueStalled());
    if (await this.repository.isBackfillEnabled()) {
      await this.step("backfill", () => this.backfillOnePage());
    }
  }

  /** Discovers text channels and active threads, and archives threads that are no longer active. */
  private async discoverChannels(): Promise<void> {
    const [channels, active] = await Promise.all([
      this.discordFetch<DiscordChannel[]>(`/guilds/${this.config.discordGuildId}/channels`),
      this.discordFetch<DiscordThreadList>(`/guilds/${this.config.discordGuildId}/threads/active`),
    ]);
    await this.repository.upsertChannels([
      ...channels.filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type)).map((channel) => discovered(channel, false, false)),
      ...active.threads.filter((thread) => THREAD_TYPES.has(thread.type)).map((thread) => discovered(thread, true, false)),
    ]);

    const activeIds = new Set(active.threads.map((thread) => thread.id));
    const retired = (await this.repository.listLiveThreadIds()).filter((id) => !activeIds.has(id));
    await this.repository.archiveChannels(retired);
  }

  /**
   * Archived threads are invisible to the active-thread listing but still hold indexable history,
   * so each polled channel also contributes its archived threads to the backfill.
   */
  private async discoverArchivedThreads(cursor: ChannelCursorDocument): Promise<void> {
    const endpoint = `/channels/${cursor.channelId}/threads/archived/public?limit=${MESSAGE_PAGE_SIZE}`;
    const newest = await this.discordFetch<DiscordThreadList>(endpoint);
    await this.persistArchivedThreads(newest);

    if (cursor.archivedThreadScanComplete) return;
    const historical = cursor.archivedThreadScanBefore
      ? await this.discordFetch<DiscordThreadList>(`${endpoint}&before=${encodeURIComponent(cursor.archivedThreadScanBefore)}`)
      : newest;
    if (historical !== newest) await this.persistArchivedThreads(historical);

    const oldest = historical.threads.at(-1)?.thread_metadata?.archive_timestamp;
    if (historical.has_more && !oldest) throw new Error("Discord omitted an archived thread pagination timestamp");
    await this.repository.updateCursor(cursor.channelId, {
      archivedThreadScanBefore: historical.has_more ? oldest : cursor.archivedThreadScanBefore,
      archivedThreadScanComplete: historical.has_more !== true,
    });
  }

  private async persistArchivedThreads(page: DiscordThreadList): Promise<void> {
    await this.repository.upsertChannels(page.threads.map((thread) => discovered(thread, true, true)));
  }

  private async pollLive(cursor: ChannelCursorDocument): Promise<void> {
    let after = cursor.liveAfterId;
    try {
      for (let page = 0; page < PAGES_PER_CHANNEL; page += 1) {
        const messages = await this.discordFetch<DiscordMessage[]>(`/channels/${cursor.channelId}/messages?after=${after}&limit=${MESSAGE_PAGE_SIZE}`);
        if (!messages.length) break;
        // The cursor advances only after persistence succeeds, so a failure replays the page.
        await this.persistAndEnqueue(messages, cursor.channelName, "live");
        const newest = extremeSnowflake(messages.map((message) => message.id), "max");
        if (!newest || newest === after) break;
        after = newest;
        if (messages.length < MESSAGE_PAGE_SIZE) break;
      }
    } finally {
      await this.repository.updateCursor(cursor.channelId, { liveAfterId: after });
    }
  }

  private async backfillOnePage(): Promise<void> {
    const cursor = await this.repository.nextBackfillChannel();
    if (!cursor) return;
    if (!cursor.backfillBeforeId) {
      await this.repository.updateCursor(cursor.channelId, { backfillComplete: true });
      return;
    }
    try {
      const messages = await this.discordFetch<DiscordMessage[]>(`/channels/${cursor.channelId}/messages?before=${cursor.backfillBeforeId}&limit=${MESSAGE_PAGE_SIZE}`);
      if (messages.length) await this.persistAndEnqueue(messages, cursor.channelName, "history");
      await this.repository.updateCursor(cursor.channelId, {
        backfillBeforeId: extremeSnowflake(messages.map((message) => message.id), "min") || cursor.backfillBeforeId,
        backfillComplete: messages.length < MESSAGE_PAGE_SIZE,
      });
    } catch (error) {
      // Channels are chosen oldest-touched-first, so a channel that always fails would otherwise
      // be re-selected forever and stall every other channel's backfill behind it.
      await this.repository.updateCursor(cursor.channelId, {});
      throw error;
    }
  }

  private async requeueStalled(): Promise<void> {
    const stale = new Date(Date.now() - LEASE_MS);
    const jobs = await this.repository.requeueStalledExtractions(stale, STALLED_JOBS_PER_RUN);
    await mapConcurrent(jobs, CHANNEL_CONCURRENCY, (job) => this.tasks.enqueue(job.articleId, job.priority, retryToken()));
  }

  private async persistAndEnqueue(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<void> {
    const articleIds = await this.repository.persistDiscordMessages(messages, channelName, priority);
    await Promise.all(articleIds.map((articleId) => this.tasks.enqueue(articleId, priority)));
  }

  private async discordFetch<T>(path: string): Promise<T> {
    const response = await fetch(`${DISCORD_API}${path}`, {
      headers: {
        authorization: `Bot ${this.config.discordBotToken}`,
        "user-agent": "DiscordBot (https://github.com/MattX/milton, 3.0)",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) {
      throw new DiscordApiError(429, `Discord rate limited ${path}; retry after ${response.headers.get("retry-after") || "unknown"}s`);
    }
    if (!response.ok) {
      throw new DiscordApiError(response.status, `Discord ${response.status} for ${path}: ${(await response.text()).slice(0, 500)}`);
    }
    return response.json() as Promise<T>;
  }

  /** One failing channel or endpoint must never abort the rest of the poll. */
  private async step(label: string, run: () => Promise<void>): Promise<void> {
    try {
      await run();
    } catch (error) {
      // Denied access is how a guild scopes Milton to part of its channels, so it is an expected
      // steady state rather than a fault: note it without the five-minute stack trace.
      if (error instanceof DiscordApiError && error.status === 403) {
        console.info(`Milton has no access to ${label}; skipping`);
        return;
      }
      console.error(`Milton ingestion step failed (${label})`, error);
    }
  }
}

class DiscordApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

function discovered(channel: DiscordChannel, isThread: boolean, archived: boolean): ChannelDiscovery {
  return {
    channelId: channel.id,
    channelName: channel.name || channel.id,
    isThread,
    archived,
    lastMessageId: channel.last_message_id ?? null,
  };
}
