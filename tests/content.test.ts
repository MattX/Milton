import { describe, expect, it } from "vitest";
import { makeExcerpt, markdownToPlainText, titleFromMarkdown } from "../worker/content";

describe("content extraction", () => {
  it("finds a heading and removes common Markdown syntax", () => {
    const markdown = "# A **useful** title\n\nRead [the story](https://example.com) with `code`.";
    expect(titleFromMarkdown(markdown)).toBe("A useful title");
    expect(markdownToPlainText(markdown)).toContain("Read the story with code.");
  });

  it("caps indexed text by UTF-8 bytes", () => {
    const result = markdownToPlainText("é".repeat(40_000));
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("creates excerpts on a word boundary", () => {
    expect(makeExcerpt("one two three four five", 13)).toBe("one two three…");
  });
});
