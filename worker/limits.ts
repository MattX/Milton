import type { Env } from "./types";

export const FREE_DATABASE_LIMIT_BYTES = 500_000_000;

export interface RuntimeLimits {
  browserDailyLimitMs: number;
  backfillDailyBudgetMs: number;
  databaseWarningBytes: number;
}

export function runtimeLimits(env: Env): RuntimeLimits {
  return {
    browserDailyLimitMs: positiveNumber(env.BROWSER_DAILY_LIMIT_MS, 10 * 60 * 1000),
    backfillDailyBudgetMs: positiveNumber(env.BACKFILL_DAILY_BUDGET_MS, 8 * 60 * 1000),
    databaseWarningBytes: positiveNumber(env.DATABASE_WARNING_BYTES, 400_000_000),
  };
}

function positiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
