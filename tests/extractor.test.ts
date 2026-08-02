import { describe, expect, it } from "vitest";
import {
  bodyIsOversized,
  ExtractionError,
  fetchHtml,
  isHtmlContentType,
  isPublicAddress,
  looksLikeBotBlock,
  parseArticleHtml,
  resolveRedirect,
} from "../server/extractor";

describe("HTTP article extraction", () => {
  it("extracts substantial article text with Readability", () => {
    const result = parseArticleHtml(`<!doctype html><html><head><title>Readable story</title></head><body>
      <article><h1>Readable story</h1><p>${"A useful paragraph about distributed systems. ".repeat(8)}</p></article>
    </body></html>`);
    expect(result.method).toBe("readability");
    expect(result.title).toContain("Readable story");
    expect(result.body).toContain("distributed systems");
  });

  it("falls back to JSON-LD articleBody", () => {
    const result = parseArticleHtml(`<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Article", headline: "Structured title", articleBody: "Structured article body with enough useful words to index safely.",
    })}</script></head><body></body></html>`);
    expect(result).toMatchObject({ method: "json-ld", title: "Structured title" });
  });

  it("falls back to OpenGraph metadata and otherwise reports link-only content", () => {
    expect(parseArticleHtml('<meta property="og:title" content="Meta"><meta property="og:description" content="A useful metadata-only description.">').method).toBe("metadata");
    expect(() => parseArticleHtml("<html><body><div></div></body></html>")).toThrowError(ExtractionError);
  });

  it("resolves redirects and validates response constraints", () => {
    expect(resolveRedirect(new URL("https://example.com/a"), "../story").toString()).toBe("https://example.com/story");
    expect(bodyIsOversized(2 * 1024 * 1024)).toBe(false);
    expect(bodyIsOversized(2 * 1024 * 1024 + 1)).toBe(true);
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/pdf")).toBe(false);
    expect(looksLikeBotBlock("<title>Just a moment...</title><div class='cf-chl-widget'>")).toBe(true);
    expect(() => parseArticleHtml("<title>Just a moment...</title><div class='cf-chl-widget'>"))
      .toThrowError(expect.objectContaining({ failureClass: "bot_block" }));
  });

  it("decodes a page using its declared charset rather than assuming UTF-8", () => {
    const body = "Un café très chaud servi à la terrasse, avec des vues sur la vieille ville et le fleuve.";
    const html = Buffer.from(`<html><head><title>Café</title></head><body><meta property="og:description" content="${body}"></body></html>`, "latin1");
    const result = parseArticleHtml(html, new URL("https://example.com/"), 200, "text/html; charset=iso-8859-1");
    expect(result.body).toContain("café très chaud");
    expect(result.body).not.toContain("�");
    expect(result.contentLength).toBe(html.byteLength);
  });

  it("rejects private and non-routable address ranges", async () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    await expect(fetchHtml("http://127.0.0.1/admin")).rejects.toMatchObject({ failureClass: "private_address" });
  });
});
