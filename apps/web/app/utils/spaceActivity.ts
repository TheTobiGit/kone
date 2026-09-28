import type { ProviderKind, UsageDay } from "~/types/desktop";
import { knownProviderRows, type ProviderIdentity } from "~/utils/usageProviders";

// The arithmetic behind the Space's Activity card, kept apart from the
// component so it can be tested: calendar keys, the week grid, shading, streaks
// and the day panel's copy. Everything reads calendar days by their local
// YYYY-MM-DD key, the same keys the usage report uses.

/** YYYY-MM-DD on the local calendar — the same keys the report uses. */
export function dateKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/** The key `by` calendar days from `key` (negative goes back). Steps the local
 *  calendar rather than adding milliseconds, so a daylight-saving change never
 *  skips or repeats a day. */
export function shiftDay(key: string, by: number): string {
  const date = new Date(`${key}T00:00:00`);
  date.setDate(date.getDate() + by);
  return dateKey(date);
}

// ── the week grid ────────────────────────────────────────────────────────────

export type GridDay = {
  key: string;
  date: Date;
  /** Outside the months shown (the edge weeks' spill) — not drawn. */
  outside: boolean;
  /** After today — drawn as an outline, the year's shape without a claim. */
  future: boolean;
};

export type YearGrid = {
  /** A column per week, Sunday first, seven days each. */
  weeks: GridDay[][];
  /** Each shown month, with the column holding its 1st. */
  months: { month: number; column: number }[];
};

/** January through the end of `now`'s month, laid out a column per week: from
 *  the week holding Jan 1 to the week holding the month's last day. Months still
 *  to come aren't drawn. Days after `now` are flagged `future`. */
export function buildGrid(now: Date): YearGrid {
  const year = now.getFullYear();
  const currentMonth = now.getMonth();
  const today = dateKey(now);
  const start = new Date(year, 0, 1);
  const end = new Date(year, currentMonth + 1, 0);

  const cursor = new Date(start);
  cursor.setDate(cursor.getDate() - cursor.getDay());

  const weeks: GridDay[][] = [];
  while (cursor <= end) {
    const week: GridDay[] = [];
    for (let d = 0; d < 7; d++) {
      const key = dateKey(cursor);
      week.push({
        key,
        date: new Date(cursor),
        outside: cursor < start || cursor > end,
        future: key > today,
      });
      cursor.setDate(cursor.getDate() + 1);
    }
    weeks.push(week);
  }

  const months = Array.from({ length: currentMonth + 1 }, (_, month) => {
    const first = dateKey(new Date(year, month, 1));
    return { month, column: weeks.findIndex((week) => week.some((day) => day.key === first)) };
  });
  return { weeks, months };
}

// ── shading ──────────────────────────────────────────────────────────────────

export type ActivityLevel = 0 | 1 | 2 | 3 | 4;

/** A day's shade, by quartile of the active days' tokens — so one enormous day
 *  doesn't flatten every other into the palest step. Zero is always level 0. */
export function quartileLevels(dayTokens: readonly number[]): (tokens: number) => ActivityLevel {
  const values = dayTokens.filter((t) => t > 0).sort((a, b) => a - b);
  const at = (q: number) => values[Math.min(values.length - 1, Math.floor(q * values.length))] ?? 0;
  const [q1, q2, q3] = [at(0.25), at(0.5), at(0.75)];
  return (tokens) => {
    if (tokens <= 0) return 0;
    if (tokens <= q1) return 1;
    if (tokens <= q2) return 2;
    if (tokens <= q3) return 3;
    return 4;
  };
}

// ── the numbers ──────────────────────────────────────────────────────────────

export type ActivityStats = {
  activeDays: number;
  /** Tokens on the average active day — the panel's yardstick. */
  averageTokens: number;
  /** Consecutive active days ending today (or yesterday, while today is still
   *  quiet). */
  current: number;
  longest: number;
  busiest: { date: string; tokens: number } | null;
};

/** Streaks and totals over `days`. A streak is a run of consecutive calendar
 *  days, so it does not lean on the report listing every day: a missing day
 *  breaks a run exactly as a zero day does. Today still counts toward the
 *  current streak before anything has run — a streak only breaks once a whole
 *  day has gone by without activity. */
export function activityStats(days: readonly UsageDay[], todayKey: string): ActivityStats {
  const active = days.filter((d) => d.tokens > 0);
  const activeDates = new Set(active.map((d) => d.date));

  let longest = 0;
  for (const date of activeDates) {
    if (activeDates.has(shiftDay(date, -1))) continue; // not where a run starts
    let length = 1;
    while (activeDates.has(shiftDay(date, length))) length += 1;
    longest = Math.max(longest, length);
  }

  let current = 0;
  let cursor = activeDates.has(todayKey) ? todayKey : shiftDay(todayKey, -1);
  while (activeDates.has(cursor)) {
    current += 1;
    cursor = shiftDay(cursor, -1);
  }

  const busiest = active.reduce<UsageDay | null>((top, d) => (!top || d.tokens > top.tokens ? d : top), null);
  return {
    activeDays: active.length,
    averageTokens: active.length ? active.reduce((sum, d) => sum + d.tokens, 0) / active.length : 0,
    current,
    longest,
    busiest: busiest ? { date: busiest.date, tokens: busiest.tokens } : null,
  };
}

// ── the day panel ────────────────────────────────────────────────────────────

/** How a day compares with the average active day — only once there is more
 *  than one active day to average, and never for the day that is the whole
 *  average. Null when there is nothing to say. */
export function versusAverage(tokens: number, averageTokens: number, activeDays: number): string | null {
  if (tokens <= 0 || activeDays <= 1 || averageTokens <= 0) return null;
  const ratio = tokens / averageTokens;
  if (ratio >= 1.05) return `${ratio.toFixed(ratio >= 10 ? 0 : 1)}× your average day`;
  if (ratio <= 0.95) return `${Math.round(ratio * 100)}% of your average day`;
  return "About your average day";
}

export type DayAgent = ProviderIdentity & {
  tokens: number;
  /** Of the day's tokens, 0–1. */
  share: number;
};

/** The agents that worked on a day, most tokens first. */
export function dayAgents(day: UsageDay | undefined, colors: Record<ProviderKind, string>): DayAgent[] {
  const total = day?.tokens ?? 0;
  return knownProviderRows(day?.byProvider ?? [], colors)
    .filter(({ row }) => row.tokens > 0)
    .sort((a, b) => b.row.tokens - a.row.tokens)
    .map(({ row, identity }) => ({
      ...identity,
      tokens: row.tokens,
      share: total > 0 ? row.tokens / total : 0,
    }));
}
