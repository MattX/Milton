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
  it("extracts metadata and substantial article text independently", async () => {
    const result = await parseArticleHtml(`<!doctype html><html><head><title>Readable story</title>
      <meta name="description" content="Metadata summary wins the excerpt."></head><body>
      <article><h1>Readable story</h1><p>${"A useful paragraph about distributed systems. ".repeat(8)}</p></article>
    </body></html>`);
    expect(result.method).toBe("readability");
    expect(result.title).toContain("Readable story");
    expect(result.description).toBe("Metadata summary wins the excerpt.");
    expect(result.excerpt).toBe("Metadata summary wins the excerpt.");
    expect(result.body).toContain("distributed systems");
  });

  it("falls back to JSON-LD articleBody while Metascraper reads JSON-LD metadata", async () => {
    const result = await parseArticleHtml(`<html><head><script type="application/ld+json">${JSON.stringify({
      "@type": "Article", headline: "Structured title", description: "Structured description",
      articleBody: "Structured article body with enough useful words to index safely.",
    })}</script></head><body></body></html>`);
    expect(result).toMatchObject({ method: "json-ld", title: "Structured title", description: "Structured description" });
    expect(result.body).toContain("Structured article body");
  });

  it("indexes OpenGraph, Twitter, standard metadata, and title-only pages without putting descriptions in body", async () => {
    const openGraph = await parseArticleHtml('<meta property="og:title" content="Meta"><meta property="og:description" content="A useful metadata-only description.">');
    expect(openGraph).toMatchObject({ method: "metadata", title: "Meta", description: "A useful metadata-only description.", body: "" });
    expect((await parseArticleHtml('<meta name="twitter:title" content="Tweet"><meta name="twitter:description" content="Twitter summary">')))
      .toMatchObject({ title: "Tweet", description: "Twitter summary", body: "" });
    expect((await parseArticleHtml('<title>Standard title</title><meta name="description" content="Standard summary">')))
      .toMatchObject({ title: "Standard title", description: "Standard summary", body: "" });
    expect(await parseArticleHtml("<title>Title alone</title>")).toMatchObject({ title: "Title alone", description: "", body: "" });
    await expect(parseArticleHtml("<html><body><div></div></body></html>")).rejects.toMatchObject({ failureClass: "insufficient_content" });
  });

  it("caps extracted titles and descriptions", async () => {
    const result = await parseArticleHtml(
      `<title>${"t".repeat(400)}</title><meta name="description" content="${"d".repeat(2_100)}">`,
    );
    expect(result.title).toHaveLength(300);
    expect(result.description).toHaveLength(2_000);
  });

  it("resolves redirects and validates response constraints", async () => {
    expect(resolveRedirect(new URL("https://example.com/a"), "../story").toString()).toBe("https://example.com/story");
    expect(bodyIsOversized(2 * 1024 * 1024)).toBe(false);
    expect(bodyIsOversized(2 * 1024 * 1024 + 1)).toBe(true);
    expect(isHtmlContentType("text/html; charset=utf-8")).toBe(true);
    expect(isHtmlContentType("application/pdf")).toBe(false);
    expect(looksLikeBotBlock("<title>Just a moment...</title><div class='cf-chl-widget'>")).toBe(true);
    await expect(parseArticleHtml("<title>Just a moment...</title><div class='cf-chl-widget'>"))
      .rejects.toMatchObject({ failureClass: "bot_block" });
  });

  it("decodes a page using its declared charset rather than assuming UTF-8", async () => {
    const body = "Un café très chaud servi à la terrasse, avec des vues sur la vieille ville et le fleuve.";
    const html = Buffer.from(`<html><head><title>Café</title></head><body><meta property="og:description" content="${body}"></body></html>`, "latin1");
    const result = await parseArticleHtml(html, new URL("https://example.com/"), 200, "text/html; charset=iso-8859-1");
    expect(result.description).toContain("café très chaud");
    expect(result.description).not.toContain("�");
    expect(result.contentLength).toBe(html.byteLength);
  });

  it("indexes metadata from an oversized prefix but skips all full-text extraction", async () => {
    const withMetadata = `<head><title>Large page</title><meta name="description" content="Useful head metadata"></head><body>${"article text ".repeat(200_000)}</body>`;
    await expect(parseArticleHtml(withMetadata)).resolves.toMatchObject({
      title: "Large page", description: "Useful head metadata", body: "", method: "metadata",
    });
    await expect(parseArticleHtml(`<html><body>${"x".repeat(2 * 1024 * 1024 + 10)}</body></html>`))
      .rejects.toMatchObject({ failureClass: "body_too_large" });
  });

  it("rejects private and non-routable address ranges", async () => {
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("127.0.0.1")).toBe(false);
    expect(isPublicAddress("10.0.0.1")).toBe(false);
    expect(isPublicAddress("::1")).toBe(false);
    await expect(fetchHtml("http://127.0.0.1/admin")).rejects.toMatchObject({ failureClass: "private_address" });
  });
});
