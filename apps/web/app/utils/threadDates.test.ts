import { describe, expect, test } from "bun:test";
import { dayKey, formatDayDivider } from "./threadDates";

describe("dayKey", () => {
  test("generates YYYY-MM-DD string from timestamp", () => {
    const ts = new Date(2026, 7, 29, 14, 30).getTime();
    expect(dayKey(ts)).toBe("2026-08-29");
  });

  test("distinguishes different calendar days across midnight", () => {
    const day1 = new Date(2026, 7, 28, 23, 59).getTime();
    const day2 = new Date(2026, 7, 29, 0, 1).getTime();
    expect(dayKey(day1)).not.toBe(dayKey(day2));
  });
});

describe("formatDayDivider", () => {
  const now = new Date(2026, 7, 29, 15, 0).getTime(); // Aug 29, 2026

  test("formats timestamps on the same day as Today", () => {
    const todayMorning = new Date(2026, 7, 29, 9, 15).getTime();
    expect(formatDayDivider(todayMorning, now)).toBe("Today");
  });

  test("formats timestamps from yesterday as Yesterday", () => {
    const yesterdayEve = new Date(2026, 7, 28, 22, 0).getTime();
    expect(formatDayDivider(yesterdayEve, now)).toBe("Yesterday");
  });

  test("formats older dates in the same year with month and day", () => {
    const pastDate = new Date(2026, 7, 24, 10, 0).getTime();
    expect(formatDayDivider(pastDate, now)).toBe("August 24");
  });

  test("formats dates in a previous year with month, day, and year", () => {
    const prevYearDate = new Date(2025, 11, 25, 12, 0).getTime();
    expect(formatDayDivider(prevYearDate, now)).toBe("December 25, 2025");
  });
});
