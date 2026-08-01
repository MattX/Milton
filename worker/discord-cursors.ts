const DISCORD_EPOCH_MS = 1_420_070_400_000;

export interface InitialChannelCursor {
  liveAfterId: string;
  backfillBeforeId: string | null;
  backfillComplete: boolean;
}

export function initialChannelCursor(messageIds: string[], nowMs: number): InitialChannelCursor {
  const newest = extremeSnowflake(messageIds, "max") || snowflakeAt(nowMs);
  return {
    liveAfterId: newest,
    // Discord's `before` boundary is exclusive, so the successor includes the
    // newest existing message when historical backfill eventually begins.
    backfillBeforeId: messageIds.length ? String(BigInt(newest) + 1n) : null,
    backfillComplete: messageIds.length === 0,
  };
}

export function extremeSnowflake(values: string[], pick: "min" | "max"): string | null {
  return values.reduce<string | null>((chosen, value) => {
    if (chosen === null) return value;
    const isLower = BigInt(value) < BigInt(chosen);
    return isLower === (pick === "min") ? value : chosen;
  }, null);
}

/** Discord snowflakes sort chronologically and reserve 22 low bits per millisecond. */
function snowflakeAt(milliseconds: number): string {
  return ((BigInt(milliseconds - DISCORD_EPOCH_MS)) << 22n).toString();
}
