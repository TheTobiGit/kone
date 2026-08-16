// for providers without a local overall source.

import type { ConversationStore } from "../ConversationStore.js";
import {
  type AgentUsageReport,
  type UsageBySlice,
  type UsageDay,
  type UsageDayProvider,
  type UsageRange,
  localDateLabel,
  rangeStart,
  startOfLocalDay,
} from "./report.js";
import type { StoreUsageReport } from "./storeUsage.js";
import {
  scanCursorDashboardUsage,
  clearCursorDashboardCache,
  type CursorDashboardBucket,
  type CursorDashboardScanResult,
} from "./cursorDashboardUsage.js";
import {
  bucketInputTokens,
  bucketTotalTokens,
  clearUsageScanCaches,
  scanTranscriptUsage,
  type TranscriptScanResult,
} from "./transcriptService.js";
import type { TranscriptProviderKind } from "./transcripts/types.js";
import type { UsageTokenTotals } from "./transcripts/types.js";

const TRANSCRIPT_PROVIDERS: Record<TranscriptProviderKind, string> = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
  droid: "droid",
  antigravity: "antigravity",
};

// Report-level memoization. Even with the per-file transcript scan cache, a full
// report still walks every transcript directory, re-reads the Cursor CSV and
// re-queries + re-folds the store on every call — tens of milliseconds to a
// second of work the UI pays on each open, range flip and scope flip. This memo
// serves an identical request from memory within a short window, and collapses
// concurrent identical requests onto one scan, so the pane's own load and its
// background revalidation don't each hit the disk. A forceRefresh (the refresh
// button) bypasses and re-primes it. Bounded lifetime keeps it honestly fresh.
const REPORT_TTL_MS = 45_000;
type ReportCacheEntry = { report: AgentUsageReport; at: number };
const reportCache = new Map<string, ReportCacheEntry>();
const reportInFlight = new Map<string, Promise<AgentUsageReport>>();

function reportCacheKey(range: UsageRange, projectPath: string | null): string {
  return `${projectPath ? "project" : "global"}:${range}:${projectPath ?? ""}`;
}

export async function buildAgentUsageReport(
  store: ConversationStore,
  options: { range: UsageRange; projectPath?: string | null; forceRefresh?: boolean },
): Promise<AgentUsageReport> {
  const projectPath = options.projectPath ?? null;
  const key = reportCacheKey(options.range, projectPath);

  if (options.forceRefresh) {
    reportCache.delete(key);
    reportInFlight.delete(key);
  } else {
    const cached = reportCache.get(key);
    if (cached && Date.now() - cached.at < REPORT_TTL_MS) return cached.report;
    const pending = reportInFlight.get(key);
    if (pending) return pending;
  }

  const build = buildFreshReport(store, options, projectPath).then(
    (report) => {
      reportCache.set(key, { report, at: Date.now() });
      reportInFlight.delete(key);
      return report;
    },
    (err) => {
      reportInFlight.delete(key);
      throw err;
    },
  );
  reportInFlight.set(key, build);
  return build;
}

async function buildFreshReport(
  store: ConversationStore,
  options: { range: UsageRange; projectPath?: string | null; forceRefresh?: boolean },
  projectPath: string | null,
): Promise<AgentUsageReport> {
  if (options.forceRefresh) {
    await clearUsageScanCaches();
    clearCursorDashboardCache();
  }

  const scope: "project" | "global" = projectPath ? "project" : "global";

  const transcript = await scanTranscriptUsage({
    range: options.range,
    projectPath,
  });

  const cursorDashboard =
    projectPath === null
      ? await scanCursorDashboardUsage({
          range: options.range,
          forceRefresh: options.forceRefresh,
        })
      : emptyCursorScan();

  const useCursorStore =
    projectPath !== null ||
    cursorDashboard.status === "no-credential" ||
    cursorDashboard.status === "fetch-failed";

  const filter = resolveStoreProviderFilter(projectPath, useCursorStore);

  const sql = store.readStoreUsageReport({
    range: options.range,
    projectPath,
    excludeProviders: filter.excludeProviders,
    onlyProviders: filter.onlyProviders,
  });

  return mergeUsageReport({
    range: options.range,
    scope,
    projectPath,
    transcript,
    cursorDashboard,
    sql,
  });
}

function emptyCursorScan(): CursorDashboardScanResult {
  return { buckets: [], status: "ok", rowsRejected: 0 };
}

/** Which providers the store slice may contribute, per report scope. The store
 *  (turn_usage) is never the primary source: the transcript scan and the Cursor
 *  dashboard are authoritative for the providers they cover, and those are
 *  excluded here so the store doesn't double-count them.
 *
 *  Global scope covers every provider from its transcript/dashboard source, so
 *  the store contributes only Cursor — and only when the dashboard export isn't
 *  available to stand in for it.
 *
 *  Project scope is narrower: the transcript scan is Claude-only there (every
 *  other provider's local log is machine-wide, so it can't be scoped to a
 *  project), which makes the store the sole project-scoped source for everything
 *  else. Only claudeAgent is excluded — codex, opencode and cursor all record
 *  their per-turn usage against the thread's project, and dropping opencode from
 *  that list (as it once was) would silently erase OpenCode spend from every
 *  project report while its transcript, being machine-wide, had nowhere else to
 *  come from. Droid and Antigravity emit no per-turn usage kone can read, so
 *  leaving them in the store slice costs nothing today and becomes correct the
 *  day they do. */
export function resolveStoreProviderFilter(
  projectPath: string | null,
  useCursorStore: boolean,
): { excludeProviders: string[]; onlyProviders?: string[] } {
  if (projectPath !== null) {
    return { excludeProviders: ["claudeAgent"] };
  }
  return {
    excludeProviders: [
      "claudeAgent",
      "codex",
      "opencode",
      "droid",
      "antigravity",
      ...(useCursorStore ? [] : ["cursor"]),
    ],
    ...(useCursorStore ? { onlyProviders: ["cursor"] } : {}),
  };
}

type StoreSlice = StoreUsageReport;

type UsageBucket = {
  day: string;
  koneProvider: string;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  records: number;
  sessions: number;
};

function mergeUsageReport(input: {
  range: UsageRange;
  scope: "project" | "global";
  projectPath: string | null;
  transcript: TranscriptScanResult;
  cursorDashboard: CursorDashboardScanResult;
  sql: StoreSlice;
}): AgentUsageReport {
  const { transcript, cursorDashboard, sql } = input;

  const scanBuckets: UsageBucket[] = [
    ...transcript.buckets.map((bucket) => ({
      day: bucket.day,
      koneProvider: TRANSCRIPT_PROVIDERS[bucket.provider],
      model: bucket.model,
      totals: bucket.totals,
      costUsd: bucket.costUsd,
      records: bucket.records,
      sessions: bucket.sessions,
    })),
    ...cursorDashboard.buckets.map((bucket) => cursorBucketToUsage(bucket)),
  ];

  const dayLabels = buildDayLabels(input.range, transcript, cursorDashboard, sql);
  const usageByDate = new Map<
    string,
    {
      input: number;
      output: number;
      total: number;
      cacheRead: number;
      cacheCreation: number;
      reasoning: number;
      cost: number;
      prompts: number;
      byProvider: Map<string, UsageDayProvider>;
    }
  >();

  for (const bucket of scanBuckets) {
    const inputTokens = bucketInputTokens(bucket.totals);
    const output = bucket.totals.outputTokens;
    const total = bucketTotalTokens(bucket.totals);
    const date = bucket.day;
    const row = usageByDate.get(date) ?? emptyDayBucket();
    row.input += inputTokens;
    row.output += output;
    row.total += total;
    row.cacheRead += bucket.totals.cachedInputTokens;
    row.cacheCreation += bucket.totals.cacheCreationTokens;
    row.reasoning += bucket.totals.reasoningTokens;
    row.cost += bucket.costUsd;
    addProviderSlice(row, bucket.koneProvider, {
      tokens: total,
      inputTokens,
      outputTokens: output,
      cacheReadTokens: bucket.totals.cachedInputTokens,
      cacheCreationTokens: bucket.totals.cacheCreationTokens,
      reasoningTokens: bucket.totals.reasoningTokens,
      costUsd: bucket.costUsd,
    });
    usageByDate.set(date, row);
  }

  for (const row of sql.usageByDayRows) {
    const date = row.date;
    const day = usageByDate.get(date) ?? emptyDayBucket();
    day.input += row.input_tokens;
    day.output += row.output_tokens;
    day.total += row.total_tokens;
    day.cacheRead += row.cache_read_tokens;
    day.cacheCreation += row.cache_creation_tokens;
    day.reasoning += row.reasoning_tokens;
    day.cost += row.cost_usd;
    addProviderSlice(day, row.provider, {
      tokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheReadTokens: row.cache_read_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      reasoningTokens: row.reasoning_tokens,
      costUsd: row.cost_usd,
    });
    usageByDate.set(date, day);
  }

  const promptsByDate = new Map(sql.promptsByDayRows.map((r) => [r.date, r.prompts]));

  const days: UsageDay[] = dayLabels.map((date) => {
    const usage = usageByDate.get(date);
    return {
      date,
      tokens: usage?.total ?? 0,
      inputTokens: usage?.input ?? 0,
      outputTokens: usage?.output ?? 0,
      cacheReadTokens: usage?.cacheRead ?? 0,
      cacheCreationTokens: usage?.cacheCreation ?? 0,
      reasoningTokens: usage?.reasoning ?? 0,
      prompts: promptsByDate.get(date) ?? 0,
      costUsd: usage?.cost ?? 0,
      byProvider: usage
        ? [...usage.byProvider.values()].sort((a, b) => b.tokens - a.tokens)
        : [],
    };
  });

  const modelsMap = new Map<string, UsageBySlice>();
  const providersMap = new Map<string, UsageBySlice>();
  const projectsMap = new Map<string, UsageBySlice>();

  let totalTokens = 0;
  let totalInput = 0;
  let totalOutput = 0;
  let totalCacheRead = 0;
  let totalCacheCreation = 0;
  let totalReasoning = 0;
  let totalCost = 0;

  const foldSlice = (
    map: Map<string, UsageBySlice>,
    key: string,
    label: string,
    provider: string | undefined,
    row: {
      tokens: number;
      inputTokens: number;
      outputTokens: number;
      cacheRead: number;
      cacheCreation: number;
      reasoning: number;
      prompts: number;
      cost: number;
    },
  ) => {
    const slice = map.get(key) ?? {
      key,
      label,
      provider,
      tokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      prompts: 0,
      costUsd: 0,
    };
    slice.tokens += row.tokens;
    slice.cacheReadTokens += row.cacheRead;
    slice.cacheCreationTokens += row.cacheCreation;
    slice.reasoningTokens += row.reasoning;
    slice.prompts += row.prompts;
    slice.costUsd += row.cost;
    map.set(key, slice);
  };

  for (const bucket of scanBuckets) {
    const inputTokens = bucketInputTokens(bucket.totals);
    const output = bucket.totals.outputTokens;
    const total = bucketTotalTokens(bucket.totals);
    totalTokens += total;
    totalInput += inputTokens;
    totalOutput += output;
    totalCacheRead += bucket.totals.cachedInputTokens;
    totalCacheCreation += bucket.totals.cacheCreationTokens;
    totalReasoning += bucket.totals.reasoningTokens;
    totalCost += bucket.costUsd;

    foldSlice(modelsMap, bucket.model, bucket.model, bucket.koneProvider, {
      tokens: total,
      inputTokens,
      outputTokens: output,
      cacheRead: bucket.totals.cachedInputTokens,
      cacheCreation: bucket.totals.cacheCreationTokens,
      reasoning: bucket.totals.reasoningTokens,
      prompts: bucket.records,
      cost: bucket.costUsd,
    });
    foldSlice(providersMap, bucket.koneProvider, bucket.koneProvider, undefined, {
      tokens: total,
      inputTokens,
      outputTokens: output,
      cacheRead: bucket.totals.cachedInputTokens,
      cacheCreation: bucket.totals.cacheCreationTokens,
      reasoning: bucket.totals.reasoningTokens,
      prompts: bucket.records,
      cost: bucket.costUsd,
    });
  }

  for (const row of sql.usageRows) {
    totalTokens += row.total_tokens;
    totalInput += row.input_tokens;
    totalOutput += row.output_tokens;
    totalCacheRead += row.cache_read_tokens;
    totalCacheCreation += row.cache_creation_tokens;
    totalReasoning += row.reasoning_tokens;
    totalCost += row.cost_usd;

    if (row.model) {
      foldSlice(modelsMap, row.model, row.model, row.provider, {
        tokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens,
        reasoning: row.reasoning_tokens,
        prompts: row.turns,
        cost: row.cost_usd,
      });
    }
    foldSlice(providersMap, row.provider, row.provider, undefined, {
      tokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheCreation: row.cache_creation_tokens,
      reasoning: row.reasoning_tokens,
      prompts: row.turns,
      cost: row.cost_usd,
    });
    if (row.project_path) {
      const label = basenameProject(row.project_path);
      foldSlice(projectsMap, row.project_path, label, undefined, {
        tokens: row.total_tokens,
        inputTokens: row.input_tokens,
        outputTokens: row.output_tokens,
        cacheRead: row.cache_read_tokens,
        cacheCreation: row.cache_creation_tokens,
        reasoning: row.reasoning_tokens,
        prompts: row.turns,
        cost: row.cost_usd,
      });
    }
  }

  const transcriptSessions = transcript.sources.reduce((n, s) => n + s.distinctSessions, 0);
  const transcriptRecords = transcript.buckets.reduce((n, b) => n + b.records, 0);
  const cursorRecords = cursorDashboard.buckets.reduce((n, b) => n + b.records, 0);

  return {
    generatedAt: Date.now(),
    range: input.range,
    scope: input.scope,
    projectPath: input.projectPath,
    totals: {
      tokens: totalTokens,
      inputTokens: totalInput,
      outputTokens: totalOutput,
      cacheReadTokens: totalCacheRead,
      cacheCreationTokens: totalCacheCreation,
      reasoningTokens: totalReasoning,
      prompts: sql.promptsRow.prompts + transcriptRecords + cursorRecords,
      threads: Math.max(sql.promptsRow.threads, transcriptSessions),
      costUsd: totalCost,
    },
    days,
    models: [...modelsMap.values()].sort((a, b) => b.tokens - a.tokens),
    providers: [...providersMap.values()].sort((a, b) => b.tokens - a.tokens),
    projects: [...projectsMap.values()].sort((a, b) => b.tokens - a.tokens),
  };
}

function cursorBucketToUsage(bucket: CursorDashboardBucket): UsageBucket {
  return {
    day: bucket.day,
    koneProvider: "cursor",
    model: bucket.model,
    totals: bucket.totals,
    costUsd: bucket.costUsd,
    records: bucket.records,
    sessions: 0,
  };
}

function emptyDayBucket() {
  return {
    input: 0,
    output: 0,
    total: 0,
    cacheRead: 0,
    cacheCreation: 0,
    reasoning: 0,
    cost: 0,
    prompts: 0,
    byProvider: new Map<string, UsageDayProvider>(),
  };
}

function addProviderSlice(
  day: ReturnType<typeof emptyDayBucket>,
  provider: string,
  slice: Omit<UsageDayProvider, "provider">,
) {
  const bucket = day.byProvider.get(provider) ?? {
    provider,
    tokens: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
    reasoningTokens: 0,
    costUsd: 0,
  };
  bucket.tokens += slice.tokens;
  bucket.inputTokens += slice.inputTokens;
  bucket.outputTokens += slice.outputTokens;
  bucket.cacheReadTokens += slice.cacheReadTokens;
  bucket.cacheCreationTokens += slice.cacheCreationTokens;
  bucket.reasoningTokens += slice.reasoningTokens;
  bucket.costUsd += slice.costUsd;
  day.byProvider.set(provider, bucket);
}

function buildDayLabels(
  range: UsageRange,
  transcript: TranscriptScanResult,
  cursorDashboard: CursorDashboardScanResult,
  sql: StoreSlice,
): string[] {
  const startMs = rangeStart(range);
  let spanStartMs = startMs;
  if (spanStartMs === null) {
    const candidates = [
      ...sql.usageByDayRows.map((r) => Date.parse(`${r.date}T00:00:00`)),
      ...transcript.buckets.map((b) => Date.parse(`${b.day}T00:00:00`)),
      ...cursorDashboard.buckets.map((b) => Date.parse(`${b.day}T00:00:00`)),
    ].filter((v) => Number.isFinite(v));
    spanStartMs = candidates.length > 0 ? Math.min(...candidates) : Date.now();
  }

  const labels: string[] = [];
  const cursor = startOfLocalDay(spanStartMs);
  const todayStart = startOfLocalDay(Date.now());
  while (cursor.getTime() <= todayStart.getTime()) {
    labels.push(localDateLabel(cursor));
    cursor.setDate(cursor.getDate() + 1);
  }
  return labels;
}

function basenameProject(projectPath: string): string {
  const parts = projectPath.split(/[/\\]/);
  return parts[parts.length - 1] || projectPath;
}
