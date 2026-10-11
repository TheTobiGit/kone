import { describe, expect, test } from "bun:test";

import { nextContinuationDeferral } from "./continuationDeferral.js";

describe("restore continuation deferral", () => {
  test("backs off to 30 seconds and warns only once after five minutes", () => {
    const base = 10_000;
    const expectedIntervals = [250, 500, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000];
    let now = base;
    let state: ReturnType<typeof nextContinuationDeferral>["deferral"] | undefined;
    for (const intervalMs of expectedIntervals) {
      const update = nextContinuationDeferral(state, now);
      expect(update.deferral.intervalMs).toBe(intervalMs);
      expect(update.deferral.retryAt).toBe(now + intervalMs);
      expect(update.shouldWarn).toBe(false);
      state = update.deferral;
      now = state.retryAt;
    }

    while (now - base < 5 * 60_000) {
      const update = nextContinuationDeferral(state, now);
      expect(update.deferral.intervalMs).toBeLessThanOrEqual(30_000);
      state = update.deferral;
      now = state.retryAt;
    }
    const warning = nextContinuationDeferral(state, now);
    expect(warning.shouldWarn).toBe(true);
    const afterWarning = nextContinuationDeferral(warning.deferral, warning.deferral.retryAt);
    expect(afterWarning.shouldWarn).toBe(false);
  });
});
