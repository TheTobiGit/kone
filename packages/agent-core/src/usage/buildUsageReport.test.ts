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

import type { ConversationStore } from "../ConversationStore.js";
import type { StoreUsageReport } from "./storeUsage.js";

const EMPTY: StoreUsageReport = {
  promptsRow: { prompts: 0, threads: 0 },
  usageRows: [],
  usageByDayRows: [],
  promptsByDayRows: [],
};

type CapturedFilter = { excludeProviders: string[]; onlyProviders?: readonly string[] };

function stubStore(
  readStoreUsageReport: (options: CapturedFilter) => StoreUsageReport,
): ConversationStore {
  // SAFETY: buildAgentUsageReport's store surface reduces to this one method
  // for these tests; every filter decision it makes is captured and asserted.
  return { readStoreUsageReport, conversationIdsForProject: () => new Set<string>() } as never;
}

describe("buildAgentUsageReport store-provider filter", () => {
  afterEach(() => {
    mock.restore();
  });

  test("project-scoped reports take scanned providers from the scan, not the store", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");
    let captured: CapturedFilter | undefined;
    const store = stubStore((opts) => {
      captured = opts;
      return EMPTY;
    });

    await buildAgentUsageReport(store, { range: "1d", projectPath: "/some/project", forceRefresh: true });

    expect(captured).toBeDefined();
    // The scan narrows itself to the project's sessions, so it stays the source
    // for these; their turn_usage rows are running totals and would overcount.
    for (const provider of ["claudeAgent", "codex", "opencode", "droid", "antigravity"]) {
      expect(captured!.excludeProviders).toContain(provider);
    }
    // A project can't scope the Cursor dashboard, so Cursor is all the store adds.
    expect(captured!.onlyProviders).toEqual(["cursor"]);
  });

  test("global reports still exclude OpenCode (it comes from the transcript scan)", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");
    let captured: CapturedFilter | undefined;
    const store = stubStore((opts) => {
      captured = opts;
      return EMPTY;
    });

    await buildAgentUsageReport(store, { range: "1d", projectPath: null, forceRefresh: true });

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
    const store = stubStore((opts) => {
      captured = opts;
      return EMPTY;
    });

    await build2(store, { range: "1d", projectPath: null, forceRefresh: true });

    expect(captured).toBeDefined();
    // Cursor is no longer excluded, and it is the only store provider asked for.
    expect(captured!.excludeProviders).not.toContain("cursor");
    expect(captured!.onlyProviders).toEqual(["cursor"]);
  });
});

describe("buildAgentUsageReport slice provider", () => {
  afterEach(() => {
    mock.restore();
  });

  test("model and provider rows both name their provider; a project row has none", async () => {
    const { buildAgentUsageReport } = await import("./buildUsageReport.js");
    const store = stubStore(() => ({
      ...EMPTY,
      usageRows: [
        {
          model: "gpt-5",
          provider: "codex",
          project_path: "/some/project",
          input_tokens: 10,
          output_tokens: 5,
          total_tokens: 15,
          cache_read_tokens: 0,
          cache_creation_tokens: 0,
          reasoning_tokens: 0,
          turns: 2,
          cost_usd: 0.5,
          unpriced_turns: 0,
        },
      ],
    }));

    const report = await buildAgentUsageReport(store, { range: "1d", projectPath: null, forceRefresh: true });

    expect(report.models.map((m) => m.provider)).toEqual(["codex"]);
    expect(report.providers.map((p) => [p.key, p.provider])).toEqual([["codex", "codex"]]);
    expect(report.projects.map((p) => p.provider)).toEqual([undefined]);
  });
});
