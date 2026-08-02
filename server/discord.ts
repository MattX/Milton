import { extremeSnowflake, initialChannelCursor } from "./discord-cursors.js";
import type { Repository } from "./repository.js";
import type { TaskEnqueuer } from "./tasks.js";
import type { ChannelCursorDocument, Config, DiscordChannel, DiscordMessage, DiscordThreadList, JobPriority } from "./types.js";

const DISCORD_API = "https://discord.com/api/v10";
const MESSAGE_PAGE_SIZE = 100;
const CHANNELS_PER_RUN = 12;
const PAGES_PER_CHANNEL = 3;
const TEXT_CHANNEL_TYPES = new Set([0, 5]);
const THREAD_TYPES = new Set([10, 11]);

export class DiscordIngestion {
  constructor(private readonly repository: Repository, private readonly tasks: TaskEnqueuer, private readonly config: Config) {}

  async run(): Promise<void> {
    await this.step("channel discovery", () => this.discoverChannels());
    for (const cursor of await this.repository.listChannels(CHANNELS_PER_RUN)) {
      await this.step(`channel #${cursor.channelName}`, () => cursor.initialized ? this.pollLive(cursor) : this.initialize(cursor));
    }
    if (await this.repository.isBackfillEnabled()) await this.step("backfill", () => this.backfillOnePage());
  }

  private async discoverChannels(): Promise<void> {
    const [channels, active] = await Promise.all([
      this.discordFetch<DiscordChannel[]>(`/guilds/${this.config.discordGuildId}/channels`),
      this.discordFetch<DiscordThreadList>(`/guilds/${this.config.discordGuildId}/threads/active`),
    ]);
    const discovered = [
      ...channels.filter((channel) => TEXT_CHANNEL_TYPES.has(channel.type)).map((channel) => ({ channel, isThread: false })),
      ...active.threads.filter((channel) => THREAD_TYPES.has(channel.type)).map((channel) => ({ channel, isThread: true })),
    ];
    await this.repository.upsertChannels(discovered.map(({ channel, isThread }) => ({
      channelId: channel.id,
      guildId: this.config.discordGuildId,
      parentId: channel.parent_id || null,
      channelName: channel.name || channel.id,
      isThread,
    })));
    const activeIds = new Set(active.threads.map((thread) => thread.id));
    const retired = (await this.repository.listActiveThreadIds()).filter((id) => !activeIds.has(id));
    if (retired.length) await this.repository.deleteChannels(retired);
  }

  private async initialize(cursor: ChannelCursorDocument): Promise<void> {
    const messages = await this.discordFetch<DiscordMessage[]>(`/channels/${cursor.channelId}/messages?limit=${MESSAGE_PAGE_SIZE}`);
    const initial = initialChannelCursor(messages.map((message) => message.id), Date.now());
    await this.repository.updateCursor(cursor.channelId, { initialized: true, ...initial });
  }

  private async pollLive(cursor: ChannelCursorDocument): Promise<void> {
    let after = cursor.liveAfterId;
    try {
      for (let page = 0; after && page < PAGES_PER_CHANNEL; page += 1) {
        const messages = await this.discordFetch<DiscordMessage[]>(`/channels/${cursor.channelId}/messages?after=${after}&limit=${MESSAGE_PAGE_SIZE}`);
        if (!messages.length) break;
        await this.persistAndEnqueue(messages, cursor.channelName, "live");
        const newest = extremeSnowflake(messages.map((message) => message.id), "max");
        if (!newest || newest === after) break;
        after = newest;
        if (messages.length < MESSAGE_PAGE_SIZE) break;
      }
    } finally {
      await this.repository.updateCursor(cursor.channelId, after ? { liveAfterId: after } : {});
    }
  }

  private async backfillOnePage(): Promise<void> {
    const cursor = await this.repository.nextBackfillChannel();
    if (!cursor?.backfillBeforeId) return;
    const messages = await this.discordFetch<DiscordMessage[]>(`/channels/${cursor.channelId}/messages?before=${cursor.backfillBeforeId}&limit=${MESSAGE_PAGE_SIZE}`);
    if (messages.length) await this.persistAndEnqueue(messages, cursor.channelName, "history");
    await this.repository.updateCursor(cursor.channelId, {
      backfillBeforeId: extremeSnowflake(messages.map((message) => message.id), "min") || cursor.backfillBeforeId,
      backfillComplete: messages.length < MESSAGE_PAGE_SIZE,
    });
  }

  private async persistAndEnqueue(messages: DiscordMessage[], channelName: string, priority: JobPriority): Promise<void> {
    const articleIds = await this.repository.persistDiscordMessages(messages, channelName, priority);
    await Promise.all(articleIds.map((articleId) => this.tasks.enqueue(articleId, priority)));
  }

  private async discordFetch<T>(path: string): Promise<T> {
    const response = await fetch(`${DISCORD_API}${path}`, {
      headers: { authorization: `Bot ${this.config.discordBotToken}`, "user-agent": "DiscordBot (https://github.com/MattX/milton, 3.0)" },
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 429) throw new Error(`Discord rate limited ${path}; retry after ${response.headers.get("retry-after") || "unknown"}s`);
    if (!response.ok) throw new Error(`Discord ${response.status} for ${path}: ${(await response.text()).slice(0, 500)}`);
    return response.json() as Promise<T>;
  }

  private async step(label: string, run: () => Promise<void>): Promise<void> {
    try { await run(); } catch (error) { console.error(`Milton ingestion step failed (${label})`, error); }
  }
}
