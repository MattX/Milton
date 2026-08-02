const DISCORD_EPOCH_MS = 1_420_070_400_000;

export interface InitialChannelCursor {
  liveAfterId: string;
  backfillBeforeId: string | null;
  backfillComplete: boolean;
}

/**
 * Seeds a newly discovered channel from Discord's own `last_message_id`, so live polling starts at
 * the present and everything behind that boundary belongs to the backfill.
 */
export function initialChannelCursor(lastMessageId: string | null | undefined, nowMs: number): InitialChannelCursor {
  if (!lastMessageId) {
    return { liveAfterId: snowflakeAt(nowMs), backfillBeforeId: null, backfillComplete: true };
  }
  return {
    liveAfterId: lastMessageId,
    // `before` is exclusive, so start one past the newest message to include it in the backfill.
    backfillBeforeId: String(BigInt(lastMessageId) + 1n),
    backfillComplete: false,
  };
}

export function extremeSnowflake(values: string[], pick: "min" | "max"): string | null {
  return values.reduce<string | null>((chosen, value) => {
    if (chosen === null) return value;
    const isLower = BigInt(value) < BigInt(chosen);
    return isLower === (pick === "min") ? value : chosen;
  }, null);
}

function snowflakeAt(milliseconds: number): string {
  return (BigInt(milliseconds - DISCORD_EPOCH_MS) << 22n).toString();
}
