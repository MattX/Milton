import { describe, expect, it, vi } from "vitest";
import { OpenRouterSummarizer } from "../server/openrouter";
import type { Config, RecentArticle } from "../server/types";

const article = {
  id: "article-1",
  data: {
    title: "A story", domain: "example.com", body: "Untrusted article text", excerpt: "Excerpt", extractionStatus: "indexed",
  },
} as RecentArticle;

const config = {
  openRouterApiKey: "secret",
  openRouterModel: "openai/gpt-5.6-luna",
  openRouterReasoningEffort: "medium",
  serviceUrl: "https://milton.example",
} as Config;

describe("OpenRouter summaries", () => {
  it("requests structured Luna summaries at medium effort and validates returned IDs", async () => {
    const fetchFn = vi.fn()
      .mockResolvedValueOnce(new Response("rate limited", { status: 429, headers: { "retry-after": "1" } }))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: JSON.stringify({ summaries: [
          { articleId: "article-1", summary: "A factual summary." },
          { articleId: "invented", summary: "Ignore me." },
        ] }) } }],
        usage: { prompt_tokens: 100, completion_tokens: 10 },
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await new OpenRouterSummarizer(config, fetchFn as typeof fetch, sleep).summarize([article]);

    expect(result).toEqual(new Map([["article-1", "A factual summary."]]));
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
    const request = JSON.parse(String(fetchFn.mock.calls[0]![1].body));
    expect(request).toMatchObject({
      model: "openai/gpt-5.6-luna",
      reasoning: { effort: "medium", exclude: true },
      response_format: { type: "json_schema", json_schema: { strict: true } },
    });
    expect(request.messages[0].content).toContain("untrusted data");
  });

  it("does not call the model when no extracted content exists", async () => {
    const fetchFn = vi.fn();
    const result = await new OpenRouterSummarizer(config, fetchFn as typeof fetch).summarize([
      { ...article, data: { ...article.data, body: "", excerpt: "", extractionStatus: "failed" } },
    ]);
    expect(result.size).toBe(0);
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("retries a transient transport failure", async () => {
    const fetchFn = vi.fn()
      .mockRejectedValueOnce(new TypeError("network unavailable"))
      .mockResolvedValueOnce(Response.json({
        choices: [{ message: { content: JSON.stringify({ summaries: [{ articleId: "article-1", summary: "Recovered." }] }) } }],
      }));
    const sleep = vi.fn().mockResolvedValue(undefined);
    const result = await new OpenRouterSummarizer(config, fetchFn as typeof fetch, sleep).summarize([article]);
    expect(result.get("article-1")).toBe("Recovered.");
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledWith(1_000);
  });
});
