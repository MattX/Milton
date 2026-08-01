import { describe, expect, it } from "vitest";
import { backfillPolicy, type BackfillGate } from "../worker/backfill-policy";

const limits = { backfillDailyBudgetMs: 480_000 };

function policy(overrides: Partial<BackfillGate> = {}) {
  return backfillPolicy({
    enabled: true,
    browserMillisecondsToday: 0,
    pendingBackfillJobs: 0,
    ...overrides,
  }, limits);
}

describe("backfill policy", () => {
  it("stops fetching but keeps draining a full backlog", () => {
    expect(policy({ pendingBackfillJobs: 100 })).toMatchObject({
      mayFetchHistory: false,
      mayDispatchHistory: true,
    });
  });

  it("does not fetch or dispatch before start or after the daily budget", () => {
    expect(policy({ enabled: false })).toMatchObject({
      mayFetchHistory: false,
      mayDispatchHistory: false,
    });
    expect(policy({ browserMillisecondsToday: 480_000 })).toMatchObject({
      mayFetchHistory: false,
      mayDispatchHistory: false,
    });
  });
});
