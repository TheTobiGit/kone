// Cursor overall usage from cursor.com's usage-events CSV export. Requires
// the same login Cursor's desktop app or CLI already saved locally — no extra
// credential storage in kone. Since Cursor 1.x the CLI keeps that login in the
// macOS Keychain and the desktop app's sqlite store may not exist at all, so
// the token is read there too — gated on the same quiet presence probe the
// quota path uses, so a never-connected user never sees a surprise prompt on
// page load.

import {
  buildCursorSessionCookie,
  detectCursorCredential,
  resolveCursorAccessToken,
} from "../quota/cursor.js";
import { parseCursorUsageCsv } from "./cursorUsageCsv.js";
import { makeDayFormatter } from "./transcripts/aggregate.js";
import type { UsageTokenTotals } from "./transcripts/types.js";
import { localDateLabel, rangeStart, startOfLocalDay, type UsageRange } from "./report.js";

export type CursorDashboardBucket = {
  day: string;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  records: number;
};

export type CursorDashboardScanStatus =
  | "ok"
  | "no-credential"
  | "fetch-failed"
  | "parse-failed";

export type CursorDashboardScanResult = {
  buckets: CursorDashboardBucket[];
  status: CursorDashboardScanStatus;
  rowsRejected: number;
};

const CACHE_TTL_MS = 5 * 60_000;
const CSV_URL = "https://cursor.com/api/dashboard/export-usage-events-csv";

let cache: { key: string; result: CursorDashboardScanResult; fetchedAt: number } | null = null;

export function clearCursorDashboardCache(): void {
  cache = null;
}

function resolveTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

type UsageWindow = {
  startMs: number;
  endMs: number;
  sinceDay: string;
  untilDay: string;
};

function windowForRange(range: UsageRange): UsageWindow {
  const endMs = Date.now();
  const untilDay = localDateLabel(startOfLocalDay(endMs));
  const rangeStartMs = rangeStart(range);
  let startMs: number;
  if (rangeStartMs === null) {
    const d = startOfLocalDay(endMs);
    d.setFullYear(d.getFullYear() - 1);
    startMs = d.getTime();
  } else {
    startMs = startOfLocalDay(rangeStartMs).getTime();
  }
  const sinceDay = localDateLabel(startOfLocalDay(startMs));
  return { startMs, endMs, sinceDay, untilDay };
}

function aggregateRows(
  rows: readonly import("./cursorUsageCsv.js").CursorCsvRow[],
  sinceDay: string,
  untilDay: string,
  timeZone: string,
): CursorDashboardBucket[] {
  const toDay = makeDayFormatter(timeZone);
  const map = new Map<string, { totals: UsageTokenTotals; costUsd: number; records: number }>();

  for (const row of rows) {
    const day = toDay(row.timestampMs);
    if (day < sinceDay || day > untilDay) continue;
    const key = `${day}\0${row.model}`;
    const bucket = map.get(key) ?? {
      totals: {
        uncachedInputTokens: 0,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 0,
        reasoningTokens: 0,
      },
      costUsd: 0,
      records: 0,
    };
    bucket.totals.uncachedInputTokens += row.totals.uncachedInputTokens;
    bucket.totals.cachedInputTokens += row.totals.cachedInputTokens;
    bucket.totals.cacheCreationTokens += row.totals.cacheCreationTokens;
    bucket.totals.outputTokens += row.totals.outputTokens;
    bucket.totals.reasoningTokens += row.totals.reasoningTokens;
    bucket.costUsd += row.costUsd;
    bucket.records += 1;
    map.set(key, bucket);
  }

  return [...map.entries()].map(([key, bucket]) => {
    const sep = key.indexOf("\0");
    const day = key.slice(0, sep);
    const model = key.slice(sep + 1);
    return {
      day,
      model,
      totals: bucket.totals,
      costUsd: bucket.costUsd,
      records: bucket.records,
    };
  });
}

export async function scanCursorDashboardUsage(options: {
  range: UsageRange;
  forceRefresh?: boolean;
}): Promise<CursorDashboardScanResult> {
  const { startMs, endMs, sinceDay, untilDay } = windowForRange(options.range);
  const timeZone = resolveTimeZone();
  const cacheKey = `${options.range}:${startMs}:${endMs}`;

  if (
    !options.forceRefresh &&
    cache &&
    cache.key === cacheKey &&
    Date.now() - cache.fetchedAt < CACHE_TTL_MS
  ) {
    return cache.result;
  }

  // The sqlite read never prompts, but a keychain-only login (the Cursor CLI
  // keeps its session in the macOS Keychain these days) would read as "not
  // connected" forever if the keychain were never consulted. `detectCursorCredential`
  // is the same probe the quota path runs: a 2.5s presence check that dies
  // silently, so a first-time prompt can never hold the page open — and it
  // only answers "something is there" when the item is already readable or a
  // prompt is the honest ask. A user who connected in Limits reads silently.
  const keychainPresent = await detectCursorCredential();
  const accessToken = await resolveCursorAccessToken({ allowKeychain: keychainPresent });
  if (!accessToken) {
    const result: CursorDashboardScanResult = {
      buckets: [],
      status: "no-credential",
      rowsRejected: 0,
    };
    cache = { key: cacheKey, result, fetchedAt: Date.now() };
    return result;
  }

  const sessionCookie = buildCursorSessionCookie(accessToken);
  if (!sessionCookie) {
    const result: CursorDashboardScanResult = {
      buckets: [],
      status: "no-credential",
      rowsRejected: 0,
    };
    cache = { key: cacheKey, result, fetchedAt: Date.now() };
    return result;
  }

  const url = new URL(CSV_URL);
  url.searchParams.set("startDate", String(startMs));
  url.searchParams.set("endDate", String(endMs));
  url.searchParams.set("strategy", "tokens");

  try {
    const response = await fetch(url.toString(), {
      headers: {
        Cookie: `WorkosCursorSessionToken=${sessionCookie}`,
        Accept: "text/csv",
      },
      signal: AbortSignal.timeout(30_000),
    });

    if (!response.ok) {
      const result: CursorDashboardScanResult = {
        buckets: [],
        status: "fetch-failed",
        rowsRejected: 0,
      };
      cache = { key: cacheKey, result, fetchedAt: Date.now() };
      return result;
    }

    const csv = await response.text();
    const parsed = parseCursorUsageCsv(csv);
    if (parsed.rows.length === 0 && parsed.rejectedRowCount > 0 && csv.includes("Date")) {
      const result: CursorDashboardScanResult = {
        buckets: [],
        status: "parse-failed",
        rowsRejected: parsed.rejectedRowCount,
      };
      cache = { key: cacheKey, result, fetchedAt: Date.now() };
      return result;
    }

    const buckets = aggregateRows(parsed.rows, sinceDay, untilDay, timeZone);
    const result: CursorDashboardScanResult = {
      buckets,
      status: "ok",
      rowsRejected: parsed.rejectedRowCount,
    };
    cache = { key: cacheKey, result, fetchedAt: Date.now() };
    return result;
  } catch {
    const result: CursorDashboardScanResult = {
      buckets: [],
      status: "fetch-failed",
      rowsRejected: 0,
    };
    cache = { key: cacheKey, result, fetchedAt: Date.now() };
    return result;
  }
}
