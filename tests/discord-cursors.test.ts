import { describe, expect, it } from "vitest";
import { extremeSnowflake, initialChannelCursor } from "../server/discord-cursors";

describe("Discord channel initialization", () => {
  it("marks an empty channel complete while retaining a live time boundary", () => {
    expect(initialChannelCursor(null, 1_420_070_400_001)).toEqual({
      liveAfterId: String(1n << 22n),
      backfillBeforeId: null,
      backfillComplete: true,
    });
  });

  it("puts existing messages wholly behind the backfill boundary", () => {
    expect(initialChannelCursor("30", Date.now())).toEqual({
      liveAfterId: "30",
      backfillBeforeId: "31",
      backfillComplete: false,
    });
  });

  it("compares snowflakes numerically rather than lexicographically", () => {
    expect(extremeSnowflake(["9", "100", "20"], "max")).toBe("100");
    expect(extremeSnowflake(["9", "100", "20"], "min")).toBe("9");
    expect(extremeSnowflake([], "max")).toBeNull();
  });
});
