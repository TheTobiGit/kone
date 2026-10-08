import { describe, expect, test } from "bun:test";

import { exhaustedWindowReset, limitResetFromCachedReport } from "./index.js";
import { emptyReport, type QuotaWindow } from "./types.js";

// The cached-quota fallback for a limit failure: it may supply a reset only
// when a window is actually exhausted, the reset is in the future, and the
// report is fresh. Otherwise null — a reset is never invented.

const NOW = 1_800_000_000_000;
const LATER = NOW + 3_600_000;
const MAX_AGE = 15 * 60_000;

function window(percent: number | null, resetsAt: string | null): QuotaWindow {
  return {
    id: "w",
    label: "weekly",
    used: { number: percent, kind: "percent" },
    limit: { number: 1, kind: "percent" },
    percent,
    state: "active",
    resetsAt,
  };
}

function report(windows: QuotaWindow[]) {
  return { ...emptyReport("codex", "connected"), windows };
}

describe("exhaustedWindowReset", () => {
  test("an exhausted window with a future reset supplies it", () => {
    expect(exhaustedWindowReset(report([window(1, new Date(LATER).toISOString())]), NOW)).toBe(LATER);
  });

  test("a non-exhausted window supplies nothing", () => {
    expect(exhaustedWindowReset(report([window(0.5, new Date(LATER).toISOString())]), NOW)).toBeNull();
  });

  test("an exhausted window without a reset supplies nothing", () => {
    expect(exhaustedWindowReset(report([window(1, null)]), NOW)).toBeNull();
  });

  test("an exhausted window whose reset is already past supplies nothing", () => {
    expect(
      exhaustedWindowReset(report([window(1, new Date(NOW - 1).toISOString())]), NOW),
    ).toBeNull();
  });

  test("the latest reset wins when several windows are exhausted", () => {
    const sooner = NOW + 60_000;
    expect(
      exhaustedWindowReset(
        report([
          window(1, new Date(sooner).toISOString()),
          window(1, new Date(LATER).toISOString()),
        ]),
        NOW,
      ),
    ).toBe(LATER);
  });
});

describe("limitResetFromCachedReport", () => {
  test("a fresh report with an exhausted window supplies the reset", () => {
    expect(
      limitResetFromCachedReport(report([window(1, new Date(LATER).toISOString())]), NOW, NOW, MAX_AGE),
    ).toBe(LATER);
  });

  test("a stale report supplies nothing, even with an exhausted window", () => {
    expect(
      limitResetFromCachedReport(
        report([window(1, new Date(LATER).toISOString())]),
        NOW - MAX_AGE - 1,
        NOW,
        MAX_AGE,
      ),
    ).toBeNull();
  });

  test("no report supplies nothing", () => {
    expect(limitResetFromCachedReport(null, NOW, NOW, MAX_AGE)).toBeNull();
  });
});
