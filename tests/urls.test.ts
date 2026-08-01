import { describe, expect, it } from "vitest";
import { extractLinks, fallbackTitle, normalizeUrl } from "../worker/urls";

describe("URL ingestion", () => {
  it("extracts, normalizes, and deduplicates external links", () => {
    const links = extractLinks(
      "Read <https://Example.com/story?utm_source=discord&id=4#comments> " +
      "and again https://example.com/story?utm_source=discord&id=4).",
    );
    expect(links).toEqual([{
      normalizedUrl: "https://example.com/story?utm_source=discord&id=4",
      domain: "example.com",
    }]);
  });

  it("preserves query parameters because they may affect page identity", () => {
    expect(normalizeUrl("https://example.com/story?utm_source=discord&id=4")?.normalizedUrl)
      .toBe("https://example.com/story?utm_source=discord&id=4");
  });

  it("rejects Discord, credentialed, and private-network URLs", () => {
    expect(normalizeUrl("https://discord.com/channels/1/2/3")).toBeNull();
    expect(normalizeUrl("http://localhost/admin")).toBeNull();
    expect(normalizeUrl("https://user:password@example.com/")).toBeNull();
    expect(normalizeUrl("http://192.168.1.10/")).toBeNull();
  });

  it("drops trailing prose punctuation but keeps balanced parentheses", () => {
    expect(normalizeUrl("https://en.wikipedia.org/wiki/Foo_(bar)")?.normalizedUrl)
      .toBe("https://en.wikipedia.org/wiki/Foo_(bar)");
    expect(normalizeUrl("https://example.com/a).")?.normalizedUrl)
      .toBe("https://example.com/a");
    expect(normalizeUrl("https://example.com/Foo_(bar),")?.normalizedUrl)
      .toBe("https://example.com/Foo_(bar)");
  });

  it("creates a readable fallback title", () => {
    expect(fallbackTitle("https://example.com/a/useful-article_title")).toBe("useful article title");
    expect(fallbackTitle("https://example.com/")).toBe("example.com");
  });
});
