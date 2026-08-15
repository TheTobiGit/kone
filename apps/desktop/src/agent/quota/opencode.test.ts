import { beforeAll, describe, expect, mock, test } from "bun:test";

import { Database } from "bun:sqlite";

// opencode.ts imports node:sqlite (an Electron-runtime built-in this bun can't
// load) — stand it in for bun:sqlite. The functions under test never open a
// database, so the stand-in only needs to exist for the import to resolve.
mock.module("node:sqlite", () => ({
  DatabaseSync: Database,
}));

type OpenCodeQuota = typeof import("./opencode.js");

let quota: OpenCodeQuota;
beforeAll(async () => {
  quota = await import("./opencode.js");
});

// These tests pin the local calendar-day arithmetic to a DST-observing zone.
// America/New_York springs forward on 2024-03-10 (a 23-hour day) and falls
// back on 2024-11-03 (a 25-hour day). A fixed 86_400_000ms stride drifts one
// hour on those days; the assertions below hold only when boundaries are
// stepped by date fields.
function withTz(tz: string, fn: () => void): void {
  const previous = process.env.TZ;
  process.env.TZ = tz;
  try {
    fn();
  } finally {
    if (previous === undefined) delete process.env.TZ;
    else process.env.TZ = previous;
  }
}

function usageRow(timeCreated: number, cost = 1, tokens = 10) {
  return { timeCreated, cost, tokens };
}

describe("computeSpendTiles day boundaries", () => {
  test("spring-forward doesn't pull the hour before midnight into Yesterday", () => {
    withTz("America/New_York", () => {
      // 2024-03-11 12:00 EDT. The previous day (Mar 10) is the 23-hour
      // spring-forward day, so its true midnight is 25h before today's.
      const nowMs = new Date(2024, 2, 11, 12, 0, 0).getTime();
      // 23:30 on Mar 9 — genuinely "the day before yesterday", but a fixed
      // 24h stride starts "Yesterday" at Mar 9 23:00 and would claim it.
      const mar9Late = new Date(2024, 2, 9, 23, 30, 0).getTime();
      const [today, yesterday, last30] = quota.computeSpendTiles([usageRow(mar9Late)], nowMs);
      expect(today.dollars).toBe(0);
      expect(yesterday.dollars).toBe(0);
      expect(last30.dollars).toBe(1);
    });
  });

  test("fall-back doesn't shrink Yesterday below its 25 hours", () => {
    withTz("America/New_York", () => {
      // 2024-11-04 12:00 EST. The previous day (Nov 3) is the 25-hour
      // fall-back day, so its true midnight is 25h before today's midnight.
      const nowMs = new Date(2024, 10, 4, 12, 0, 0).getTime();
      // 00:30 on Nov 3 — the first hour of a 25-hour yesterday. A fixed 24h
      // stride starts "Yesterday" at Nov 3 01:00 and would drop this hour.
      const nov3Early = new Date(2024, 10, 3, 0, 30, 0).getTime();
      const [today, yesterday] = quota.computeSpendTiles([usageRow(nov3Early)], nowMs);
      expect(today.dollars).toBe(0);
      expect(yesterday.dollars).toBe(1);
    });
  });
});

describe("computeTrend day labels", () => {
  test("the day after a spring-forward transition keeps its own label", () => {
    withTz("America/New_York", () => {
      const nowMs = new Date(2024, 2, 11, 12, 0, 0).getTime();
      const points = quota.computeTrend([], nowMs);
      expect(points).toHaveLength(30);
      // Second-to-last point is "yesterday" (Mar 10), never Mar 9.
      expect(points[points.length - 2].date).toBe("2024-03-10");
      expect(points[points.length - 1].date).toBe("2024-03-11");
    });
  });

  test("labels are unique across a transition inside the 30-day window", () => {
    withTz("America/New_York", () => {
      const nowMs = new Date(2024, 2, 11, 12, 0, 0).getTime();
      const points = quota.computeTrend([], nowMs);
      const labels = points.map((p) => p.date);
      expect(new Set(labels).size).toBe(labels.length);
    });
  });
});
