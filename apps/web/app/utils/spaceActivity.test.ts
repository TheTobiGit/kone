import { describe, expect, test } from "bun:test";
import type { UsageDay } from "~/types/desktop";
import {
  activityStats,
  buildGrid,
  dateKey,
  dayAgents,
  quartileLevels,
  shiftDay,
  versusAverage,
} from "./spaceActivity";
import { PROVIDER_COLORS } from "./usageProviders";

function day(date: string, tokens: number, byProvider: UsageDay["byProvider"] = []): UsageDay {
  return {
    date,
    tokens,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    prompts: 0,
    costUsd: 0,
    byProvider,
  };
}

describe("dateKey / shiftDay", () => {
  test("keys are zero-padded local dates", () => {
    expect(dateKey(new Date(2026, 0, 5))).toBe("2026-01-05");
    expect(dateKey(new Date(2026, 11, 31))).toBe("2026-12-31");
  });

  test("shiftDay crosses month and year ends in both directions", () => {
    expect(shiftDay("2026-01-31", 1)).toBe("2026-02-01");
    expect(shiftDay("2026-01-01", -1)).toBe("2025-12-31");
    expect(shiftDay("2024-02-28", 1)).toBe("2024-02-29");
    expect(shiftDay("2026-09-28", 0)).toBe("2026-09-28");
  });
});

describe("buildGrid", () => {
  // Mon 28 Sep 2026: Jan 1 was a Thursday, so the grid opens on Sun 28 Dec 2025
  // and closes on the week holding Wed 30 Sep.
  const now = new Date(2026, 8, 28);
  const { weeks, months } = buildGrid(now);

  test("is whole Sunday-first weeks", () => {
    expect(weeks).toHaveLength(40);
    for (const week of weeks) {
      expect(week).toHaveLength(7);
      expect(week[0]!.date.getDay()).toBe(0);
    }
  });

  test("runs one calendar day at a time, with no gap or repeat", () => {
    const keys = weeks.flat().map((d) => d.key);
    for (let i = 1; i < keys.length; i++) expect(keys[i]).toBe(shiftDay(keys[i - 1]!, 1));
  });

  test("marks the edge weeks' spill as outside, and days after today as future", () => {
    const flat = weeks.flat();
    expect(flat.filter((d) => d.outside).map((d) => d.key)).toEqual([
      "2025-12-28",
      "2025-12-29",
      "2025-12-30",
      "2025-12-31",
      "2026-10-01",
      "2026-10-02",
      "2026-10-03",
    ]);
    expect(flat.find((d) => d.key === "2026-09-28")!.future).toBe(false);
    expect(flat.find((d) => d.key === "2026-09-29")!.future).toBe(true);
  });

  test("names a column for each month shown, each holding that month's 1st", () => {
    expect(months.map((m) => m.month)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    for (const { month, column } of months) {
      const first = dateKey(new Date(2026, month, 1));
      expect(weeks[column]!.some((d) => d.key === first)).toBe(true);
    }
  });

  test("always draws the month's last day, even when it opens a week", () => {
    // 30 Jun 2024 is a Sunday: the last day of the span is the first of its
    // week, the case a millisecond week-count drops across a DST change.
    for (let month = 0; month < 12; month++) {
      const last = dateKey(new Date(2024, month + 1, 0));
      const grid = buildGrid(new Date(2024, month, 15));
      const lastWeek = grid.weeks.at(-1)!;
      expect(lastWeek.find((d) => d.key === last)?.outside).toBe(false);
    }
  });
});

describe("quartileLevels", () => {
  test("no activity is level 0, whatever the yardstick", () => {
    const level = quartileLevels([0, 10, 20, 30, 40]);
    expect(level(0)).toBe(0);
    expect(quartileLevels([])(0)).toBe(0);
  });

  test("steps up by quartile of the active days, quiet days set aside", () => {
    const level = quartileLevels([1, 2, 3, 4, 5, 6, 7, 8, 0, 0, 0]);
    expect([1, 2, 3, 4, 5, 6, 7, 8].map(level)).toEqual([1, 1, 1, 2, 2, 3, 3, 4]);
  });

  test("one enormous day does not flatten the rest into the palest step", () => {
    const level = quartileLevels([10, 20, 30, 40, 1_000_000]);
    expect(level(1_000_000)).toBe(4);
    expect([20, 30, 40].map(level)).toEqual([1, 2, 3]);
  });
});

describe("activityStats", () => {
  const TODAY = "2026-09-28";
  // A dense window, as the report sends it: every day, quiet ones at zero.
  const dense = (pattern: number[]): UsageDay[] =>
    pattern.map((tokens, i) => day(shiftDay(TODAY, i - (pattern.length - 1)), tokens));

  test("counts a run of consecutive days, and the longest of several", () => {
    const stats = activityStats(dense([5, 5, 0, 5, 5, 5, 0, 5]), TODAY);
    expect(stats.activeDays).toBe(6);
    expect(stats.longest).toBe(3);
    expect(stats.current).toBe(1);
  });

  test("today still counts before anything has run, without breaking the streak", () => {
    const stats = activityStats(dense([5, 5, 5, 0]), TODAY);
    expect(stats.current).toBe(3);
    expect(stats.longest).toBe(3);
  });

  test("a whole quiet day breaks the current streak", () => {
    const stats = activityStats(dense([5, 5, 5, 0, 0]), TODAY);
    expect(stats.current).toBe(0);
    expect(stats.longest).toBe(3);
  });

  test("a day missing from the list breaks a run just like a zero day", () => {
    const sparse = [day("2026-09-24", 5), day("2026-09-25", 5), day("2026-09-27", 5), day("2026-09-28", 5)];
    const stats = activityStats(sparse, TODAY);
    expect(stats.longest).toBe(2);
    expect(stats.current).toBe(2);
  });

  test("a report that stops short of today does not carry an old streak forward", () => {
    const stale = [day("2026-09-24", 5), day("2026-09-25", 5)];
    expect(activityStats(stale, TODAY).current).toBe(0);
  });

  test("finds the busiest day and the average active day", () => {
    const stats = activityStats(dense([0, 10, 30, 20, 0]), TODAY);
    expect(stats.busiest).toEqual({ date: shiftDay(TODAY, -2), tokens: 30 });
    expect(stats.averageTokens).toBe(20);
  });

  test("an empty window is all zeroes", () => {
    expect(activityStats([], TODAY)).toEqual({
      activeDays: 0,
      averageTokens: 0,
      current: 0,
      longest: 0,
      busiest: null,
    });
  });
});

describe("versusAverage", () => {
  test("says nothing without a year to compare against", () => {
    expect(versusAverage(100, 100, 1)).toBeNull();
    expect(versusAverage(0, 100, 5)).toBeNull();
    expect(versusAverage(100, 0, 5)).toBeNull();
  });

  test("reads above, below and near the average", () => {
    expect(versusAverage(250, 100, 5)).toBe("2.5× your average day");
    expect(versusAverage(1500, 100, 5)).toBe("15× your average day");
    expect(versusAverage(40, 100, 5)).toBe("40% of your average day");
    expect(versusAverage(100, 100, 5)).toBe("About your average day");
  });
});

describe("dayAgents", () => {
  const entry = (provider: string, tokens: number) => ({
    provider,
    tokens,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  });

  test("lists known agents by tokens, with their share of the day", () => {
    const agents = dayAgents(
      day("2026-09-28", 100, [entry("codex", 25), entry("claudeAgent", 75), entry("gemini", 40), entry("cursor", 0)]),
      PROVIDER_COLORS.light,
    );
    expect(agents.map((a) => a.provider)).toEqual(["claudeAgent", "codex"]);
    expect(agents.map((a) => a.share)).toEqual([0.75, 0.25]);
    expect(agents[0]!.color).toBe(PROVIDER_COLORS.light.claudeAgent);
  });

  test("a day with no record has no agents", () => {
    expect(dayAgents(undefined, PROVIDER_COLORS.dark)).toEqual([]);
  });
});
