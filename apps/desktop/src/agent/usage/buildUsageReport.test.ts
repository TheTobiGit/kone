import { afterEach, describe, expect, mock, test } from "bun:test";

// The CLI-scan dependencies are stubbed wholesale so the report can be built in
// a unit test without touching the machine's real transcript directories,
// dashboard CSV, or a live ConversationStore. The module under test is imported
// dynamically below — a static import is hoisted above mock.module and would
// pull in the real transcriptService (and its node:sqlite transitive deps).
mock.module("./transcriptService.js", () => ({
  scanTranscriptUsage: async () => ({
    buckets: [],
    sources: [],
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

import type { StoreUsageReport } from "./storeUsage.js";

const EMPTY: StoreUsageReport = {
  promptsRow: { prompts: 0, threads: 0 },
  usageRows: [],
  usageByDayRows: [],
  promptsByDayRows: [],
};

type CapturedFilter = { excludeProviders: string[]; onlyProviders?: readonly string[] };

describe("buildAgentUsageReport store-provider filter", () => {
  afterEach(() => {
    mock.restore();
  });

  test("project-scoped reports keep OpenCode in the store slice", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");
    let captured: CapturedFilter | undefined;
    const store = {
      readStoreUsageReport: (opts: CapturedFilter) => {
        captured = opts;
        return EMPTY;
      },
    };

    await buildAgentUsageReport(store as never, { range: "1d", projectPath: "/some/project", forceRefresh: true });

    expect(captured).toBeDefined();
    // OpenCode emits per-turn usage that is recorded against the thread's
    // project, and its transcript scan is machine-wide (skipped for a project),
    // so the store is its only project-scoped source — excluding it here would
    // drop OpenCode spend from every project report.
    expect(captured!.excludeProviders).not.toContain("opencode");
  });

  test("global reports still exclude OpenCode (it comes from the transcript scan)", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");
    let captured: CapturedFilter | undefined;
    const store = {
      readStoreUsageReport: (opts: CapturedFilter) => {
        captured = opts;
        return EMPTY;
      },
    };

    await buildAgentUsageReport(store as never, { range: "1d", projectPath: null, forceRefresh: true });

    expect(captured).toBeDefined();
    expect(captured!.excludeProviders).toContain("opencode");
    expect(captured!.excludeProviders).toContain("claudeAgent");
    // The dashboard answered ok, so cursor usage comes from the CSV, not the store.
    expect(captured!.excludeProviders).toContain("cursor");
    expect(captured!.onlyProviders).toBeUndefined();
  });

  test("global reports fall back to the store for Cursor when the dashboard is unavailable", async () => {
    mock.module("./cursorDashboardUsage.js", () => ({
      scanCursorDashboardUsage: async () => ({ buckets: [], status: "no-credential" as const, rowsRejected: 0 }),
      clearCursorDashboardCache: () => {},
    }));
    const { buildAgentUsageReport: build2 } = await import("./buildUsageReport.js");

    let captured: CapturedFilter | undefined;
    const store = {
      readStoreUsageReport: (opts: CapturedFilter) => {
        captured = opts;
        return EMPTY;
      },
    };

    await build2(store as never, { range: "1d", projectPath: null, forceRefresh: true });

    expect(captured).toBeDefined();
    // Cursor is no longer excluded, and it is the only store provider asked for.
    expect(captured!.excludeProviders).not.toContain("cursor");
    expect(captured!.onlyProviders).toEqual(["cursor"]);
  });
});
