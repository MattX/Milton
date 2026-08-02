import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, normalizeSearchQuery } from "../server/search-query";

describe("search query handling", () => {
  it("normalizes words while preserving phrases and exclusions", () => {
    expect(normalizeSearchQuery('  Distributed systems -legacy "exact phrase"!  '))
      .toBe('Distributed systems -legacy "exact phrase"');
    expect(normalizeSearchQuery("café 東京")).toBe("café 東京");
  });

  it("rejects punctuation-only queries", () => {
    expect(normalizeSearchQuery("---")).toBeNull();
  });

  it("round-trips pagination offsets and rejects out-of-range cursors", () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor("not-a-valid-cursor!")).toBe(0);
    expect(decodeCursor("-20")).toBe(0);
    expect(decodeCursor("999999999")).toBe(0);
    expect(decodeCursor(null)).toBe(0);
  });
});
