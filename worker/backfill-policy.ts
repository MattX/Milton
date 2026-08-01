/** Historical fetching pauses once this many extraction jobs are waiting. */
const MAX_BACKFILL_BACKLOG = 100;

export interface BackfillGate {
  enabled: boolean;
  browserMillisecondsToday: number;
  pendingBackfillJobs: number;
}

export interface BackfillLimits {
  backfillDailyBudgetMs: number;
}

export interface BackfillPolicy {
  mayFetchHistory: boolean;
  mayDispatchHistory: boolean;
  pausedReason: string | null;
}

export function backfillPolicy(gate: BackfillGate, limits: BackfillLimits): BackfillPolicy {
  if (!gate.enabled) {
    return { mayFetchHistory: false, mayDispatchHistory: false, pausedReason: "Backfill has not been started." };
  }
  if (gate.browserMillisecondsToday >= limits.backfillDailyBudgetMs) {
    return {
      mayFetchHistory: false,
      mayDispatchHistory: false,
      pausedReason: "The historical Browser Run budget is exhausted for today.",
    };
  }
  if (gate.pendingBackfillJobs >= MAX_BACKFILL_BACKLOG) {
    return {
      mayFetchHistory: false,
      mayDispatchHistory: true,
      pausedReason: `The historical extraction backlog has reached ${MAX_BACKFILL_BACKLOG} articles.`,
    };
  }
  return { mayFetchHistory: true, mayDispatchHistory: true, pausedReason: null };
}
