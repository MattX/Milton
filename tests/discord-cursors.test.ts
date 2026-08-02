import { describe, expect, it } from "vitest";
import { initialChannelCursor } from "../server/discord-cursors";

describe("Discord channel initialization", () => {
  it("marks an empty channel complete while retaining a live time boundary", () => {
    const cursor = initialChannelCursor([], 1_420_070_400_001);
    expect(cursor).toEqual({
      liveAfterId: String(1n << 22n),
      backfillBeforeId: null,
      backfillComplete: true,
    });
  });

  it("puts existing messages wholly behind the backfill boundary", () => {
    expect(initialChannelCursor(["20", "10", "30"], Date.now())).toEqual({
      liveAfterId: "30",
      backfillBeforeId: "31",
      backfillComplete: false,
    });
  });
});
