import { afterEach, describe, expect, it, vi } from "vitest";
import { DiscordIngestion, isMiltonMessage } from "../server/discord";
import type { Repository } from "../server/repository";
import type { ChannelCursorDocument, Config, DiscordMessage } from "../server/types";

afterEach(() => vi.unstubAllGlobals());

describe("Discord message filtering", () => {
  const message = {
    id: "200", channel_id: "channel", content: "https://example.com", timestamp: "2026-08-01T00:00:00.000Z",
    author: { id: "user", username: "person" },
  } satisfies DiscordMessage;

  it("recognizes Milton interaction webhooks and bot-authored messages", () => {
    expect(isMiltonMessage({ ...message, webhook_id: "application" }, "application")).toBe(true);
    expect(isMiltonMessage({ ...message, author: { id: "application", username: "Milton" } }, "application")).toBe(true);
    expect(isMiltonMessage(message, "application")).toBe(false);
  });

  it("does not persist Milton's digest messages while still advancing the cursor", async () => {
    const cursor = {
      channelId: "channel", channelName: "general", isThread: true, archived: false,
      liveAfterId: "100", backfillBeforeId: "101", backfillComplete: true,
      archivedThreadScanBefore: null, archivedThreadScanComplete: true,
      updatedAt: "2026-08-01T00:00:00.000Z",
    } satisfies ChannelCursorDocument;
    const persistDiscordMessages = vi.fn().mockResolvedValue([]);
    const updateCursor = vi.fn().mockResolvedValue(undefined);
    const repository = {
      upsertChannels: vi.fn().mockResolvedValue(undefined),
      listLiveThreadIds: vi.fn().mockResolvedValue(["channel"]),
      archiveChannels: vi.fn().mockResolvedValue(undefined),
      listLiveChannels: vi.fn().mockResolvedValue([cursor]),
      persistDiscordMessages,
      updateCursor,
      listRecoverableExtractions: vi.fn().mockResolvedValue([]),
      isBackfillEnabled: vi.fn().mockResolvedValue(false),
    } as unknown as Repository;
    const digest = { ...message, id: "201", author: { id: "application", username: "Milton" }, webhook_id: "application" };
    const userPost = { ...message, id: "202" };
    const responses = new Map<string, unknown>([
      ["/guilds/guild/channels", []],
      ["/guilds/guild/threads/active", { threads: [{ id: "channel", name: "general", type: 11, last_message_id: "202" }] }],
      ["/channels/channel/messages?after=100&limit=100", [digest, userPost]],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input));
      const path = requested.pathname.replace(/^\/api\/v10/, "") + requested.search;
      return new Response(JSON.stringify(responses.get(path)), {
        status: responses.has(path) ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    }));

    const config = { discordGuildId: "guild", discordBotToken: "token", discordApplicationId: "application" } as Config;
    const tasks = { enqueue: vi.fn().mockResolvedValue(undefined), exists: vi.fn().mockResolvedValue(false) };
    await new DiscordIngestion(repository, tasks, config).run(60_000);

    expect(persistDiscordMessages).toHaveBeenCalledOnce();
    expect(persistDiscordMessages).toHaveBeenCalledWith([userPost], "general", "live");
    expect(updateCursor).toHaveBeenCalledWith("channel", { liveAfterId: "202" });
  });
});

describe("Discord archived-thread discovery", () => {
  it("keeps checking the newest page while advancing the historical cursor", async () => {
    const cursor = {
      channelId: "parent", channelName: "general", isThread: false, archived: false,
      liveAfterId: "100", backfillBeforeId: "101", backfillComplete: false,
      archivedThreadScanBefore: "2026-01-02T00:00:00.000Z", archivedThreadScanComplete: false,
      updatedAt: "2026-01-01T00:00:00.000Z",
    } satisfies ChannelCursorDocument;
    const upsertChannels = vi.fn().mockResolvedValue(undefined);
    const updateCursor = vi.fn().mockResolvedValue(undefined);
    const repository = {
      upsertChannels,
      listLiveThreadIds: vi.fn().mockResolvedValue([]),
      archiveChannels: vi.fn().mockResolvedValue(undefined),
      listLiveChannels: vi.fn().mockResolvedValue([cursor]),
      updateCursor,
      isBackfillEnabled: vi.fn().mockResolvedValue(false),
    } as unknown as Repository;
    const responses = new Map<string, unknown>([
      ["/guilds/guild/channels", [{ id: "parent", name: "general", type: 0, last_message_id: "100" }]],
      ["/guilds/guild/threads/active", { threads: [] }],
      ["/channels/parent/threads/archived/public?limit=100", {
        threads: [{ id: "new", name: "new", type: 11, last_message_id: "90", thread_metadata: { archive_timestamp: "2026-02-01T00:00:00.000Z" } }],
        has_more: true,
      }],
      ["/channels/parent/threads/archived/public?limit=100&before=2026-01-02T00%3A00%3A00.000Z", {
        threads: [{ id: "old", name: "old", type: 11, last_message_id: "10", thread_metadata: { archive_timestamp: "2025-12-01T00:00:00.000Z" } }],
        has_more: false,
      }],
      ["/channels/parent/messages?after=100&limit=100", []],
    ]);
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const requested = new URL(String(input));
      const path = requested.pathname.replace(/^\/api\/v10/, "") + requested.search;
      return new Response(JSON.stringify(responses.get(path)), {
        status: responses.has(path) ? 200 : 404,
        headers: { "content-type": "application/json" },
      });
    }));

    const config = { discordGuildId: "guild", discordBotToken: "token" } as Config;
    const tasks = { enqueue: vi.fn().mockResolvedValue(undefined), exists: vi.fn().mockResolvedValue(false) };
    await new DiscordIngestion(repository, tasks, config).run(60_000);

    expect(upsertChannels).toHaveBeenCalledWith([expect.objectContaining({ channelId: "new", archived: true })]);
    expect(upsertChannels).toHaveBeenCalledWith([expect.objectContaining({ channelId: "old", archived: true })]);
    expect(updateCursor).toHaveBeenCalledWith("parent", expect.objectContaining({
      archivedThreadScanBefore: "2026-01-02T00:00:00.000Z",
      archivedThreadScanComplete: true,
    }));
  });
});
