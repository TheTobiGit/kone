import { describe, expect, mock, test } from "bun:test";

// A provider the app no longer offers is still scanned from disk; the report is
// asked for one population, and every aggregate it returns must describe that
// population alone. The stubs below return a Codex bucket and a retired
// provider's bucket, so the assertions can prove the retired one is filtered
// from the scan before aggregation rather than surviving in the totals while
// dropping out of the breakdowns.
mock.module("./transcriptService.js", () => ({
  scanTranscriptUsage: async () => ({
    buckets: [
      {
        provider: "codex",
        day: "2026-01-01",
        model: "gpt-5",
        totals: {
          uncachedInputTokens: 100,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 50,
          reasoningTokens: 0,
        },
        costUsd: 1,
        records: 2,
        unpricedRecords: 0,
        sessions: 1,
      },
      {
        provider: "droid",
        day: "2026-01-01",
        model: "droid-model",
        totals: {
          uncachedInputTokens: 900,
          cachedInputTokens: 0,
          cacheCreationTokens: 0,
          outputTokens: 100,
          reasoningTokens: 0,
        },
        costUsd: 9,
        records: 3,
        unpricedRecords: 0,
        sessions: 2,
      },
    ],
    sources: [
      { provider: "codex", dir: "/c", status: "ok", scannedFiles: 1, skippedFiles: 0, distinctSessions: 1 },
      { provider: "droid", dir: "/d", status: "ok", scannedFiles: 1, skippedFiles: 0, distinctSessions: 2 },
    ],
    scanDurationMs: 0,
    timeZone: "UTC",
    sinceDay: "2026-01-01",
    untilDay: "2026-01-01",
  }),
  clearUsageScanCaches: async () => {},
  bucketInputTokens: (t: { uncachedInputTokens: number }) => t.uncachedInputTokens,
  bucketTotalTokens: (t: {
    uncachedInputTokens: number;
    cachedInputTokens: number;
    cacheCreationTokens: number;
    outputTokens: number;
  }) => t.uncachedInputTokens + t.cachedInputTokens + t.cacheCreationTokens + t.outputTokens,
}));

mock.module("./cursorDashboardUsage.js", () => ({
  scanCursorDashboardUsage: async () => ({ buckets: [], status: "ok" as const, rowsRejected: 0 }),
  clearCursorDashboardCache: () => {},
}));

import type { UsageReportStore } from "./buildUsageReport.js";
import type { StoreUsageReport } from "./storeUsage.js";

const EMPTY: StoreUsageReport = {
  promptsRow: { prompts: 0, threads: 0 },
  usageRows: [],
  usageByDayRows: [],
  promptsByDayRows: [],
};

/** A store stand-in typed to exactly what the report reads; the transcript stub
 *  above supplies every bucket, so the store contributes nothing here. */
function emptyStore(): UsageReportStore {
  return {
    readStoreUsageReport: () => EMPTY,
    conversationIdsForProject: () => new Set<string>(),
  };
}

describe("buildAgentUsageReport provider population", () => {
  test("totals, providers, models and day splits cover exactly the requested population", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");

    const report = await buildAgentUsageReport(emptyStore(), {
      range: "all",
      projectPath: null,
      forceRefresh: true,
      providers: ["codex"],
    });

    expect(report.providers.map((p) => p.key)).toEqual(["codex"]);
    expect(report.models.map((m) => m.key)).toEqual(["gpt-5"]);

    const day = report.days[0];
    expect(day?.byProvider.map((p) => p.provider)).toEqual(["codex"]);

    // Every aggregate reconciles with the same surviving rows: Codex's 150
    // tokens, never Codex + Droid's 1150.
    expect(report.totals.tokens).toBe(150);
    expect(report.totals.costUsd).toBe(1);
    expect(day?.tokens).toBe(150);
    expect(day?.tokens).toBe(day?.byProvider.reduce((sum, p) => sum + p.tokens, 0) ?? -1);
    expect(report.totals.tokens).toBe(report.providers.reduce((sum, p) => sum + p.tokens, 0));

    // The thread count is derived from sources, not buckets, so droid's two
    // sessions must not survive it either.
    expect(report.totals.threads).toBe(1);
  });
});
