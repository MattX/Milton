import { describe, expect, it } from "vitest";
import { decodeCursor, encodeCursor, toFtsQuery } from "../worker/search-query";

describe("search query handling", () => {
  it("builds an escaped AND-prefix query", () => {
    expect(toFtsQuery("  Distributed systems!  ")).toBe('"Distributed"* AND "systems"*');
  });

  it("rejects punctuation-only queries", () => {
    expect(toFtsQuery("---")).toBeNull();
  });

  it("round-trips pagination offsets and rejects invalid cursors", () => {
    expect(decodeCursor(encodeCursor(40))).toBe(40);
    expect(decodeCursor("not-a-valid-cursor!")).toBe(0);
  });
});
