import { describe, expect, it } from "vitest";
import { limitBody, makeExcerpt } from "../server/content";

describe("content extraction", () => {
  it("normalizes article whitespace", () => {
    expect(limitBody("First line.  \n\n\n\nSecond line.")).toBe("First line.\n\nSecond line.");
  });

  it("caps indexed text by UTF-8 bytes", () => {
    const result = limitBody("é".repeat(40_000));
    expect(new TextEncoder().encode(result).byteLength).toBeLessThanOrEqual(32 * 1024);
  });

  it("creates excerpts on a word boundary", () => {
    expect(makeExcerpt("one two three four five", 13)).toBe("one two three…");
  });
});
