import type { Env } from "./types";

/** Historical extraction stops once this many backfill jobs are waiting. */
export const MAX_BACKFILL_BACKLOG = 100;

export interface RuntimeLimits {
  browserDailyLimitMs: number;
  backfillDailyBudgetMs: number;
}

export function runtimeLimits(env: Env): RuntimeLimits {
  return {
    browserDailyLimitMs: positiveNumber(env.BROWSER_DAILY_LIMIT_MS, 10 * 60 * 1000),
    backfillDailyBudgetMs: positiveNumber(env.BACKFILL_DAILY_BUDGET_MS, 8 * 60 * 1000),
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
