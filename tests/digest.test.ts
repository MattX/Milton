import { describe, expect, it, vi } from "vitest";
import { cutoff, DigestService, renderDigest, type DiscordResponder } from "../server/digest";
import type { ArticleSummarizer } from "../server/openrouter";
import type { Repository } from "../server/repository";
import type { ArticleDocument, Config, DigestTaskPayload, RecentArticle } from "../server/types";

const payload: DigestTaskPayload = {
  interactionId: "100", interactionToken: "token", userId: "200", days: 7, invokedAt: "2026-08-03T12:00:00.000Z",
};

function recent(index: number, status: ArticleDocument["extractionStatus"] = "indexed"): RecentArticle {
  return {
    id: `article-${index}`,
    data: {
      normalizedUrl: `https://example.com/story-${index}`,
      domain: "example.com",
      title: `Story ${index}`,
      body: `Body ${index}`,
      excerpt: `Excerpt ${index}`,
      extractionStatus: status,
      extractionMethod: status === "indexed" ? "readability" : null,
      extractionFailureClass: null,
      extractionHttpStatus: null,
      extractionContentLength: null,
      extractionHostname: "example.com",
      lastPostedAt: "2026-08-02T12:00:00.000Z",
      latestOccurrence: {
        channelId: "channel", channelName: "links", authorName: "author",
        postedAt: "2026-08-02T12:00:00.000Z", messageUrl: `https://discord.com/channels/1/2/${index}`,
      },
      createdAt: "2026-08-02T12:00:00.000Z",
      updatedAt: "2026-08-02T12:00:00.000Z",
    },
  };
}

describe("digest rendering", () => {
  it("renders 25 links into three bounded public messages and reports omissions", () => {
    const articles = Array.from({ length: 25 }, (_, index) => recent(index));
    const summaries = new Map(articles.map(({ id }) => [id, "A concise generated summary."]));
    const messages = renderDigest(7, articles, 31, summaries);

    expect(messages).toHaveLength(3);
    expect(messages.map((item) => item.embeds?.length)).toEqual([10, 10, 5]);
    expect(messages[0]?.content).toContain("6 omitted");
    for (const message of messages) {
      expect(message.allowed_mentions).toEqual({ parse: [] });
      const characters = message.embeds!.reduce((sum, embed) => (
        sum + embed.title.length + embed.description.length + embed.footer.text.length
      ), 0);
      expect(characters).toBeLessThanOrEqual(6_000);
    }
  });

  it("uses extraction-state fallbacks and computes rolling or all-history cutoffs", () => {
    const messages = renderDigest(1, [recent(1, "pending"), recent(2, "failed")], 2, new Map());
    expect(messages[0]?.embeds?.[0]?.description).toContain("still pending");
    expect(messages[0]?.embeds?.[1]?.description).toContain("could not extract");
    expect(cutoff("2026-08-03T12:00:00.000Z", 7)).toBe("2026-07-27T12:00:00.000Z");
    expect(cutoff("2026-08-03T12:00:00.000Z", Number.MAX_SAFE_INTEGER)).toBeNull();
  });
});

describe("digest execution", () => {
  it("enforces one active digest per user", async () => {
    const repository = { claimCommandLock: vi.fn().mockResolvedValue(false) } as unknown as Repository;
    const responder = { editOriginal: vi.fn().mockResolvedValue(undefined), createFollowup: vi.fn() } as DiscordResponder;
    await new DigestService(repository, { summarize: vi.fn() } as ArticleSummarizer, responder, {
      discordGuildId: "guild",
    } as Config).run(payload);
    expect(responder.editOriginal).toHaveBeenCalledWith("token", expect.objectContaining({
      content: expect.stringContaining("already have a digest running"),
    }));
  });

  it("queries the rolling period, falls back after an LLM failure, and releases the lock", async () => {
    const articles = [recent(1)];
    const repository = {
      claimCommandLock: vi.fn().mockResolvedValue(true),
      listRecentArticles: vi.fn().mockResolvedValue({ items: articles, total: 1 }),
      releaseCommandLock: vi.fn().mockResolvedValue(undefined),
    } as unknown as Repository;
    const summarizer = { summarize: vi.fn().mockRejectedValue(new Error("provider down")) } as ArticleSummarizer;
    const responder = { editOriginal: vi.fn().mockResolvedValue(undefined), createFollowup: vi.fn() } as DiscordResponder;
    await new DigestService(repository, summarizer, responder, { discordGuildId: "guild" } as Config).run(payload);

    expect(repository.listRecentArticles).toHaveBeenCalledWith("2026-07-27T12:00:00.000Z", 25);
    expect(responder.editOriginal).toHaveBeenCalledWith("token", expect.objectContaining({
      embeds: [expect.objectContaining({ description: expect.stringContaining("Excerpt 1") })],
    }));
    expect(repository.releaseCommandLock).toHaveBeenCalledWith("digest-guild-200", "100");
  });
});
