import { readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "../sqlite.js";

import { sanitizeError } from "./security.js";
import { dollars, emptyReport } from "./types.js";
import type { QuotaProviderReport, QuotaWindow, SpendTile, TrendPoint } from "./types.js";

// OpenCode's own usage, read straight off the local SQLite log OpenCode's CLI
// already writes (~/.local/share/opencode/opencode*.db) — no network call,
// no credential, nothing to opt into beyond "does this machine have the
// file". The read is flattened to kone's needs: one aggregate "hosted usage"
// read across both providerIDs OpenCode itself prices (see
// HOSTED_PROVIDER_IDS below), feeding every window, spend tile and trend
// point this module produces.

const DOLLARS_PER_SESSION_CAP = 12; // per rolling 5 hours
const DOLLARS_PER_WEEK_CAP = 30; // per UTC week (Monday start)
const DOLLARS_PER_MONTH_CAP = 60; // per anchored month

const FIVE_HOURS_MS = 5 * 60 * 60 * 1000;
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// One scan covers every window this report needs: the anchored month can
// reach back close to 31 days, and the trend needs 30 — 35 leaves slack for
// both without a second query round-trip per window.
const SCAN_DAYS_BACK = 35;
const TREND_DAYS = 30;

// The two providerIDs OpenCode itself hosts and prices — a subscription seat
// (`opencode-go`) and the pay-as-you-go gateway (`opencode`). Both write a
// real, provider-computed `cost` on every assistant message because OpenCode
// is the one paying the model bill and passing it through. Every other
// providerID (`openai`, `github-copilot`, ...) is bring-your-own-key: the
// user's own credential pays that bill directly, OpenCode never sees it, and
// it always logs `cost: 0` for those rows. Summing those in would either add
// nothing (the common case) or, worse, credit kone's OpenCode card with spend
// that has nothing to do with the Go/Zen caps it's reporting against — so
// only the two hosted ids are summed.
const HOSTED_PROVIDER_IDS = ["opencode-go", "opencode"];
const HOSTED_PROVIDER_FILTER = HOSTED_PROVIDER_IDS.map((id) => `'${id}'`).join(",");

// Bind `?` to the cutoff (ms epoch) so one prepared statement serves every
// call. `time_created` is milliseconds, matching Date.now() directly — no
// unit conversion needed on either side of the comparison. The `cost` this
// query reads is authoritative: OpenCode itself priced the message against
// the model it actually billed, so kone never re-estimates it — every dollar
// figure this module produces is `estimated: false`.
const HOSTED_ROWS_SQL = `
  SELECT time_created AS timeCreated,
         json_extract(data,'$.cost') AS cost,
         COALESCE(json_extract(data,'$.tokens.total'),0) AS tokens
  FROM message
  WHERE time_created >= ?
    AND json_valid(data)
    AND json_extract(data,'$.role') = 'assistant'
    AND json_extract(data,'$.providerID') IN (${HOSTED_PROVIDER_FILTER})
    AND json_type(data,'$.cost') IN ('integer','real')
`;

// Unbounded (no cutoff): the monthly cycle anchor is the day-of-month of the
// EARLIEST hosted usage this machine has ever recorded, which can easily sit
// outside the 35-day scan window above.
const EARLIEST_HOSTED_USAGE_SQL = `
  SELECT MIN(time_created) AS anchor
  FROM message
  WHERE json_valid(data)
    AND json_extract(data,'$.role') = 'assistant'
    AND json_extract(data,'$.providerID') IN (${HOSTED_PROVIDER_FILTER})
    AND json_type(data,'$.cost') IN ('integer','real')
`;

type UsageRow = {
  timeCreated: number;
  cost: number;
  tokens: number;
};

/** Resolution order mirrors OpenCode itself, so kone reads exactly the
 *  directory the CLI just wrote to: an explicit override first, then XDG,
 *  then the plain default. Supports comma-separated `OPENCODE_DATA_DIR`. */
export function resolveOpenCodeDataDirs(): string[] {
  const override = process.env.OPENCODE_DATA_DIR?.trim();
  if (override) {
    const dirs = override
      .split(",")
      .map((part) => part.trim())
      .filter((part) => part.length > 0);
    if (dirs.length > 0) return dirs;
  }
  const xdg = process.env.XDG_DATA_HOME?.trim();
  if (xdg) return [path.join(xdg, "opencode")];
  return [path.join(os.homedir(), ".local", "share", "opencode")];
}

function resolveDataDir(): string {
  return resolveOpenCodeDataDirs()[0] ?? path.join(os.homedir(), ".local", "share", "opencode");
}

/** Every `opencode*.db` file in the data dir. OpenCode partitions its usage
 *  log by release channel — `opencode.db` for stable, `opencode-<channel>.db`
 *  for others (e.g. `opencode-dev.db`) — so globbing rather than hardcoding
 *  one name means a user on a non-default channel is still tracked. Sorted
 *  for deterministic iteration; a missing data dir is the ordinary "OpenCode
 *  never ran here" case and returns `[]`, while any other enumeration
 *  failure (permissions) is rethrown so the caller can tell "no database"
 *  apart from "there's something here we couldn't look at". */
export function listOpenCodeDatabasePaths(dataDir: string): string[] {
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names
    .filter((name) => name.startsWith("opencode") && name.endsWith(".db"))
    .sort()
    .map((name) => path.join(dataDir, name));
}

/** Cheap presence check for provider-detection UI: does OpenCode's data dir
 *  hold at least one channel database on this machine? No SQLite open, no
 *  parsing — just "is there a file kone could try to read". */
export async function detectOpenCodeDatabase(): Promise<boolean> {
  try {
    for (const dir of resolveOpenCodeDataDirs()) {
      if (listOpenCodeDatabasePaths(dir).length > 0) return true;
    }
    return false;
  } catch (error) {
    console.warn(sanitizeError(error));
    return false;
  }
}

/** The hosted-usage rows inside a scan window, plus the earliest hosted
 *  timestamp ever recorded (unbounded), read from one channel database. */
type HostedUsageRead = {
  rows: UsageRow[];
  earliestMs: number | null;
};

/** Read one channel database read-only and return its hosted-usage rows
 *  inside the scan window, plus its own earliest-ever hosted timestamp
 *  (unbounded) for the monthly anchor. Never mutates the file — `readOnly`
 *  lets kone open a database OpenCode's own CLI has open and writing to
 *  concurrently without risking a lock conflict or a stray write. */
function readDatabase(dbPath: string, cutoffMs: number): HostedUsageRead {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    const rawRows = db.prepare(HOSTED_ROWS_SQL).all(cutoffMs) as Array<{
      timeCreated: number | bigint;
      cost: number | bigint | null;
      tokens: number | bigint | null;
    }>;
    const rows: UsageRow[] = rawRows.map((row) => ({
      timeCreated: Number(row.timeCreated),
      cost: Number(row.cost ?? 0),
      tokens: Number(row.tokens ?? 0),
    }));
    const earliestRow = db.prepare(EARLIEST_HOSTED_USAGE_SQL).get() as { anchor: number | bigint | null } | undefined;
    const earliestMs = earliestRow?.anchor != null ? Number(earliestRow.anchor) : null;
    return { rows, earliestMs };
  } finally {
    db.close();
  }
}

/** Sum of `cost` for rows with `start <= timeCreated < end`, snapped to a
 *  hundredth of a cent to shed float-summation noise before a meter divides
 *  by its cap (thousands of tiny per-message costs otherwise leave a
 *  visible 0.00000000003 fringe). */
function sumCost(rows: UsageRow[], start: number, end: number): number {
  let total = 0;
  for (const row of rows) {
    if (row.timeCreated >= start && row.timeCreated < end) total += row.cost;
  }
  return Math.round(total * 10000) / 10000;
}

/** The rolling 5-hour session cap. Unlike the week/month windows, a rolling
 *  window with nothing in it genuinely has not begun — there is no "started
 *  5 hours ago" to point at, so `resetsAt` would have to be invented. The
 *  window's real start is the earliest qualifying message inside the span;
 *  it resets 5 hours after that, not 5 hours after "now". */
function computeSessionWindow(rows: UsageRow[], nowMs: number): QuotaWindow {
  const spanStart = nowMs - FIVE_HOURS_MS;
  const inSpan = rows.filter((row) => row.timeCreated >= spanStart && row.timeCreated < nowMs);
  if (inSpan.length === 0) {
    return {
      id: "session",
      label: "Session",
      used: dollars(0),
      limit: dollars(DOLLARS_PER_SESSION_CAP),
      percent: 0,
      state: "notStarted",
      resetsAt: null,
    };
  }
  const earliestInSpan = Math.min(...inSpan.map((row) => row.timeCreated));
  const spend = sumCost(rows, spanStart, nowMs);
  return {
    id: "session",
    label: "Session",
    used: dollars(spend),
    limit: dollars(DOLLARS_PER_SESSION_CAP),
    percent: Math.min(spend / DOLLARS_PER_SESSION_CAP, 1),
    state: "active",
    resetsAt: new Date(earliestInSpan + FIVE_HOURS_MS).toISOString(),
  };
}

/** Start of the current UTC-ISO week (Monday 00:00:00 UTC) containing
 *  `nowMs`. `getUTCDay()` returns Sun=0..Sat=6; `(weekday + 6) % 7` rotates
 *  that to days-since-Monday (Mon=0..Sun=6). */
function startOfUtcWeek(nowMs: number): number {
  const now = new Date(nowMs);
  const startOfTodayUtc = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  const weekday = new Date(startOfTodayUtc).getUTCDay();
  const daysSinceMonday = (weekday + 6) % 7;
  return startOfTodayUtc - daysSinceMonday * DAY_MS;
}

function computeWeekWindow(rows: UsageRow[], nowMs: number): QuotaWindow {
  const start = startOfUtcWeek(nowMs);
  const end = start + WEEK_MS;
  const spend = sumCost(rows, start, end);
  return {
    id: "week",
    label: "Week",
    used: dollars(spend),
    limit: dollars(DOLLARS_PER_WEEK_CAP),
    percent: Math.min(spend / DOLLARS_PER_WEEK_CAP, 1),
    state: "active",
    resetsAt: new Date(end).toISOString(),
  };
}

/** The anchored-month start within a given local `year`/`month` (0-based):
 *  the anchor's day-of-month (clamped to how many days that month actually
 *  has — a January 31st anchor lands on February's 28th/29th) at the
 *  anchor's local time-of-day. */
function anchoredMonthStart(year: number, month: number, anchor: Date): number {
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const day = Math.min(anchor.getDate(), daysInMonth);
  return new Date(
    year,
    month,
    day,
    anchor.getHours(),
    anchor.getMinutes(),
    anchor.getSeconds(),
    anchor.getMilliseconds(),
  ).getTime();
}

/** A [start, end) pair of local-time epoch ms delimiting one anchored monthly
 *  billing cycle. */
type AnchoredMonthBounds = {
  start: number;
  end: number;
};

/** The current anchored monthly cycle's [start, end) in local time. Anchored
 *  to the day-of-month of the earliest-ever hosted usage — e.g. a user whose
 *  first-ever OpenCode Go message landed on the 14th resets on the 14th of
 *  every month, not the 1st, because that's when their billing cycle
 *  actually turns over. `earliestMs === null` (a database that exists but has
 *  never logged hosted usage) falls back to the plain calendar month — there
 *  is no anchor day to honor yet. */
function anchoredMonthBounds(nowMs: number, earliestMs: number | null): AnchoredMonthBounds {
  const now = new Date(nowMs);
  if (earliestMs === null) {
    const start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
    const end = new Date(now.getFullYear(), now.getMonth() + 1, 1).getTime();
    return { start, end };
  }

  const anchor = new Date(earliestMs);
  let year = now.getFullYear();
  let month = now.getMonth();
  let start = anchoredMonthStart(year, month, anchor);
  // The current month's anchored start can land in the future — the anchor
  // day-of-month hasn't happened yet this month — meaning the live cycle
  // actually began last month.
  if (start > nowMs) {
    month -= 1;
    if (month < 0) {
      month = 11;
      year -= 1;
    }
    start = anchoredMonthStart(year, month, anchor);
  }
  let nextYear = year;
  let nextMonth = month + 1;
  if (nextMonth > 11) {
    nextMonth = 0;
    nextYear += 1;
  }
  const end = anchoredMonthStart(nextYear, nextMonth, anchor);
  return { start, end };
}

function computeMonthWindow(rows: UsageRow[], nowMs: number, earliestMs: number | null): QuotaWindow {
  const { start, end } = anchoredMonthBounds(nowMs, earliestMs);
  const spend = sumCost(rows, start, end);
  return {
    id: "month",
    label: "Month",
    used: dollars(spend),
    limit: dollars(DOLLARS_PER_MONTH_CAP),
    percent: Math.min(spend / DOLLARS_PER_MONTH_CAP, 1),
    state: "active",
    resetsAt: new Date(end).toISOString(),
  };
}

/** Local midnight containing `ms` — the calendar-day boundary the spend
 *  tiles and trend both key on, matching ConversationStore's
 *  `startOfLocalDay` (stepping by local date fields stays correct across a
 *  DST transition, unlike a fixed 86_400_000ms stride). */
function startOfLocalDay(ms: number): number {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
}

/** Local midnight `days` calendar days before `nowMs`'s local midnight. Steps
 *  by date fields rather than a fixed 86_400_000ms stride, so a DST transition
 *  inside the span never shifts the boundary by an hour — a spring-forward day
 *  is 23h and a fall-back day 25h, so a fixed stride lands one hour early or
 *  late and mislabels the day. */
function daysAgoStart(nowMs: number, days: number): number {
  const d = new Date(startOfLocalDay(nowMs));
  d.setDate(d.getDate() - days);
  return d.getTime();
}

/** `YYYY-MM-DD` in local time — the same `toLocaleDateString("en-CA")`
 *  convention ConversationStore uses for its day-keyed series, so a day
 *  label here means the same calendar day everywhere else in the app. */
function localDateLabel(ms: number): string {
  return new Date(ms).toLocaleDateString("en-CA");
}

/** Cost and token totals for a half-open time span. */
type SpendTally = {
  dollars: number;
  tokens: number;
};

export function computeSpendTiles(rows: UsageRow[], nowMs: number): SpendTile[] {
  const todayStart = startOfLocalDay(nowMs);
  const yesterdayStart = daysAgoStart(nowMs, 1);
  const last30Start = daysAgoStart(nowMs, 29); // today + the 29 days before it
  const upperBound = nowMs + 1; // inclusive of "now" — nothing has happened later yet

  const tally = (start: number, end: number): SpendTally => {
    let cost = 0;
    let tokens = 0;
    for (const row of rows) {
      if (row.timeCreated >= start && row.timeCreated < end) {
        cost += row.cost;
        tokens += row.tokens;
      }
    }
    return { dollars: Math.round(cost * 10000) / 10000, tokens };
  };

  const today = tally(todayStart, upperBound);
  const yesterday = tally(yesterdayStart, todayStart);
  const last30 = tally(last30Start, upperBound);

  return [
    { id: "today", label: "Today", dollars: today.dollars, tokens: today.tokens, estimated: false },
    { id: "yesterday", label: "Yesterday", dollars: yesterday.dollars, tokens: yesterday.tokens, estimated: false },
    { id: "last30", label: "Last 30 days", dollars: last30.dollars, tokens: last30.tokens, estimated: false },
  ];
}

/** The last 30 local calendar days, oldest first, zero-filled — a day with no
 *  hosted usage is still a point at `dollars: 0`, because a gap in the line
 *  would claim "no data" for a day kone actually knows was quiet. */
export function computeTrend(rows: UsageRow[], nowMs: number): TrendPoint[] {
  const todayStart = startOfLocalDay(nowMs);
  const byDay = new Map<string, { dollars: number; tokens: number }>();
  const oldestTracked = daysAgoStart(nowMs, TREND_DAYS - 1);
  for (const row of rows) {
    const dayStart = startOfLocalDay(row.timeCreated);
    if (dayStart < oldestTracked || dayStart > todayStart) continue;
    const label = localDateLabel(dayStart);
    const entry = byDay.get(label) ?? { dollars: 0, tokens: 0 };
    entry.dollars += row.cost;
    entry.tokens += row.tokens;
    byDay.set(label, entry);
  }
  const points: TrendPoint[] = [];
  for (let i = TREND_DAYS - 1; i >= 0; i--) {
    const dayStart = daysAgoStart(nowMs, i);
    const label = localDateLabel(dayStart);
    const entry = byDay.get(label);
    points.push({
      date: label,
      dollars: entry ? Math.round(entry.dollars * 10000) / 10000 : 0,
      tokens: entry ? entry.tokens : 0,
    });
  }
  return points;
}

/** Fetches OpenCode's own usage report by reading its local SQLite log
 *  read-only — no network call at all, since the `cost` OpenCode already
 *  wrote per message is the same authoritative figure its own CLI would
 *  print. Never throws: every path, including a database that fails to
 *  open, resolves to a report — matching the contract every other quota
 *  provider in this module honors. */
export async function fetchOpenCodeQuota(opts: { signal?: AbortSignal } = {}): Promise<{ report: QuotaProviderReport }> {
  try {
    const dataDir = resolveDataDir();
    let paths: string[];
    try {
      paths = listOpenCodeDatabasePaths(dataDir);
    } catch (error) {
      // The data directory exists but couldn't even be listed (permissions,
      // I/O) — a real machine problem, not "OpenCode was never installed",
      // so it must not read as disconnected.
      console.warn(sanitizeError(error));
      return {
        report: emptyReport("opencode", "transientFailure", "OpenCode's local data directory could not be read."),
      };
    }
    if (paths.length === 0) {
      return {
        report: emptyReport("opencode", "disconnected", "OpenCode has no local usage database on this machine."),
      };
    }

    const nowMs = Date.now();
    const cutoffMs = nowMs - SCAN_DAYS_BACK * DAY_MS;
    const allRows: UsageRow[] = [];
    let earliestMs: number | null = null;
    let openedCount = 0;

    for (const dbPath of paths) {
      if (opts.signal?.aborted) break;
      try {
        const { rows, earliestMs: dbEarliestMs } = readDatabase(dbPath, cutoffMs);
        allRows.push(...rows);
        if (dbEarliestMs !== null) earliestMs = earliestMs === null ? dbEarliestMs : Math.min(earliestMs, dbEarliestMs);
        openedCount += 1;
      } catch (error) {
        // One channel's database being locked or corrupt must not take down
        // the others — skip it and keep aggregating the rest.
        console.warn(sanitizeError(error));
      }
    }

    if (openedCount === 0) {
      return {
        report: emptyReport("opencode", "transientFailure", "OpenCode's local usage database could not be read."),
      };
    }

    const sessionWindow = computeSessionWindow(allRows, nowMs);
    const weekWindow = computeWeekWindow(allRows, nowMs);
    const monthWindow = computeMonthWindow(allRows, nowMs, earliestMs);

    return {
      report: {
        provider: "opencode",
        connection: "connected",
        primary: monthWindow,
        windows: [sessionWindow, weekWindow, monthWindow],
        spend: computeSpendTiles(allRows, nowMs),
        trend: computeTrend(allRows, nowMs),
        planLabel: "Go",
        excludedModels: [],
        fetchedAt: nowMs,
      },
    };
  } catch (error) {
    // Last-resort guard: nothing above should throw, but a defect here must
    // still resolve to a report rather than escape to the caller.
    console.warn(sanitizeError(error));
    return { report: emptyReport("opencode", "transientFailure", "Something went wrong reading OpenCode's local usage.") };
  }
}
