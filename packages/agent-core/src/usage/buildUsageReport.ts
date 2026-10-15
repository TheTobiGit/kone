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

const TRANSCRIPT_PROVIDERS = {
  claude: "claudeAgent",
  codex: "codex",
  opencode: "opencode",
  droid: "droid",
  antigravity: "antigravity",
} satisfies Record<TranscriptProviderKind, string>;

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

function reportCacheKey(
  range: UsageRange,
  projectPath: string | null,
  providers: readonly string[] | undefined,
): string {
  // The provider population is part of the request's identity: an
  // offered-only report and a full one over the same range and scope are
  // different numbers, and must not share a cache entry.
  const population = providers ? providers.join(",") : "*";
  return `${projectPath ? "project" : "global"}:${range}:${projectPath ?? ""}:${population}`;
}

/** The slice of ConversationStore the report actually depends on. Naming it
 *  documents the real dependency and lets a caller (a test, or a store stand-in)
 *  satisfy it with a plain object, no assertion; a concrete ConversationStore
 *  is assignable because it has both members. */
export type UsageReportStore = Pick<
  ConversationStore,
  "readStoreUsageReport" | "conversationIdsForProject"
>;

export type UsageReportOptions = {
  range: UsageRange;
  projectPath?: string | null;
  forceRefresh?: boolean;
  /** When set, every figure in the report covers exactly these providers: the
   *  scan, the Cursor dashboard and the store are all narrowed to the list
   *  before aggregation, so totals, days, by-provider and model rows share one
   *  population (see restrictTranscript / restrictStoreFilter). Omit for every
   *  provider kone recorded. */
  providers?: readonly string[];
};

export async function buildAgentUsageReport(
  store: UsageReportStore,
  options: UsageReportOptions,
): Promise<AgentUsageReport> {
  const projectPath = options.projectPath ?? null;
  const key = reportCacheKey(options.range, projectPath, options.providers);

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
  store: UsageReportStore,
  options: UsageReportOptions,
  projectPath: string | null,
): Promise<AgentUsageReport> {
  if (options.forceRefresh) {
    await clearUsageScanCaches();
    clearCursorDashboardCache();
  }

  const scope: "project" | "global" = projectPath ? "project" : "global";
  const providers = options.providers;

  const scanned = await scanTranscriptUsage({
    range: options.range,
    projectPath,
    projectSessionIds: projectPath === null ? null : store.conversationIdsForProject(projectPath),
  });
  const transcript = providers ? restrictTranscript(scanned, providers) : scanned;

  // The dashboard is Cursor's, so it only contributes when Cursor is in the
  // population; otherwise its buckets would reintroduce a provider the rest of
  // the report has dropped.
  const cursorDashboard =
    projectPath === null && (!providers || providers.includes("cursor"))
      ? await scanCursorDashboardUsage({
          range: options.range,
          forceRefresh: options.forceRefresh,
        })
      : emptyCursorScan();

  const useCursorStore =
    projectPath !== null ||
    cursorDashboard.status === "no-credential" ||
    cursorDashboard.status === "fetch-failed";

  const filter = restrictStoreFilter(resolveStoreProviderFilter(useCursorStore), providers);

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

/** Narrow a transcript scan to the requested population before aggregation.
 *  Buckets feed every token/cost total, models, providers and day splits;
 *  sources feed the thread/session count. Dropping only the buckets would
 *  leave the thread count describing providers the totals no longer include,
 *  so both are filtered together. */
function restrictTranscript(
  scan: TranscriptScanResult,
  providers: readonly string[],
): TranscriptScanResult {
  const includes = (provider: TranscriptProviderKind) =>
    providers.includes(TRANSCRIPT_PROVIDERS[provider]);
  return {
    ...scan,
    buckets: scan.buckets.filter((bucket) => includes(bucket.provider)),
    sources: scan.sources.filter((source) => includes(source.provider)),
  };
}

/** Narrow the store's provider filter to the requested population. The store
 *  only ever contributes providers its base filter allows; this intersects that
 *  allowance with the population so a provider outside it can never slip in
 *  through the store alone. */
function restrictStoreFilter(
  base: StoreProviderFilter,
  providers: readonly string[] | undefined,
): StoreProviderFilter {
  if (!providers) return base;
  const allowed = base.onlyProviders
    ? base.onlyProviders.filter((provider) => providers.includes(provider))
    : providers;
  return { excludeProviders: base.excludeProviders, onlyProviders: [...allowed] };
}

function emptyCursorScan(): CursorDashboardScanResult {
  return { buckets: [], status: "ok", rowsRejected: 0 };
}

/** Which providers the store slice may contribute — the exclusion/inclusion
 *  pair the store query is told to respect. */
export type StoreProviderFilter = {
  excludeProviders: string[];
  onlyProviders?: string[];
};

/** Which providers the store slice may contribute. The store (turn_usage) is
 *  never the primary source: the transcript scan and the Cursor dashboard are
 *  authoritative for the providers they cover, and those are excluded here so
 *  the store doesn't double-count them.
 *
 *  The same rule holds for a project as for every project: the scan narrows
 *  itself to the project's sessions (see scanTranscriptUsage), so it stays the
 *  source there too. That matters beyond consistency — Codex, OpenCode and
 *  Antigravity report running thread totals, so their turn_usage rows each
 *  repeat every earlier turn and summing them overstates the spend several
 *  times over. The store contributes only Cursor, and only when the dashboard
 *  export can't stand in for it (never for a project, which it can't scope). */
export function resolveStoreProviderFilter(useCursorStore: boolean): StoreProviderFilter {
  const excludeProviders = [
    "claudeAgent",
    "codex",
    "opencode",
    "droid",
    "antigravity",
    ...(useCursorStore ? [] : ["cursor"]),
  ];
  return useCursorStore ? { excludeProviders, onlyProviders: ["cursor"] } : { excludeProviders };
}

type StoreSlice = StoreUsageReport;

type UsageBucket = {
  day: string;
  koneProvider: string;
  model: string;
  totals: UsageTokenTotals;
  costUsd: number;
  records: number;
  unpricedRecords: number;
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
      unpricedRecords: bucket.unpricedRecords,
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
      unpriced: number;
    },
  ) => {
    const slice = map.get(key) ?? {
      key,
      label,
      provider,
      tokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
      prompts: 0,
      costUsd: 0,
      unpricedRecords: 0,
    };
    slice.tokens += row.tokens;
    slice.outputTokens += row.outputTokens;
    slice.cacheReadTokens += row.cacheRead;
    slice.cacheCreationTokens += row.cacheCreation;
    slice.reasoningTokens += row.reasoning;
    slice.prompts += row.prompts;
    slice.costUsd += row.cost;
    slice.unpricedRecords += row.unpriced;
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
      unpriced: bucket.unpricedRecords,
    });
    foldSlice(providersMap, bucket.koneProvider, bucket.koneProvider, bucket.koneProvider, {
      tokens: total,
      inputTokens,
      outputTokens: output,
      cacheRead: bucket.totals.cachedInputTokens,
      cacheCreation: bucket.totals.cacheCreationTokens,
      reasoning: bucket.totals.reasoningTokens,
      prompts: bucket.records,
      cost: bucket.costUsd,
      unpriced: bucket.unpricedRecords,
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
        unpriced: row.unpriced_turns,
      });
    }
    foldSlice(providersMap, row.provider, row.provider, row.provider, {
      tokens: row.total_tokens,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      cacheRead: row.cache_read_tokens,
      cacheCreation: row.cache_creation_tokens,
      reasoning: row.reasoning_tokens,
      prompts: row.turns,
      cost: row.cost_usd,
      unpriced: row.unpriced_turns,
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
        unpriced: row.unpriced_turns,
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
    // The dashboard export carries Cursor's own charge for every row.
    unpricedRecords: 0,
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
