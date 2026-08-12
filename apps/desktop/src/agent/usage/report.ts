// Pure types + helpers for the agent usage report. Claude/Codex/OpenCode/Droid
// from local CLI logs; Cursor from dashboard CSV when signed in; kone store only
// as fallback for Cursor when the dashboard export is unavailable.

export type UsageRange = "7d" | "30d" | "all";

/** Cache/reasoning token counts a provider adapter attaches to a
 *  `thread.token-usage.updated` payload's `usage` object, beyond the fields
 *  declared on the shared `TokenUsage` type (agent/types.ts). That type isn't
 *  widened here because it's owned by unrelated work in flight elsewhere in
 *  the codebase right now; adapters intersect it with this shape locally
 *  instead, and the store reads it back the same way. All three are required
 *  (never optional) so a provider that genuinely doesn't expose a count
 *  reports 0 explicitly rather than an absence a reader could mistake for an
 *  oversight — see the per-adapter comments at each token-accounting call
 *  site for which counts are real vs. always-zero. */
export type TokenUsageSplits = {
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
};

export type UsageTotals = {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  /** Additive breakdown of the tokens above already folded into `tokens` —
   *  cache reads/creations are counted as input tokens by every provider, and
   *  reasoning tokens as output, so these never need to be added on top of
   *  `tokens`/`inputTokens`/`outputTokens`; they exist purely so the UI can
   *  show what fraction of the spend was cache vs. fresh, or reasoning vs.
   *  plain output. */
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  threads: number;
  costUsd: number;
};

/** One day's usage for a single provider — the layer inside `UsageDay.byProvider`
 *  that lets the UI draw a stacked/layered daily chart instead of one
 *  undifferentiated bar, so a spike on a given day can be attributed to the
 *  provider that caused it. */
export type UsageDayProvider = {
  provider: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
};

/** One local calendar day. Dense across the whole range — including days with
 *  no activity — so the UI can draw a bar chart without inventing gaps. */
export type UsageDay = {
  /** YYYY-MM-DD, local calendar. */
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  costUsd: number;
  /** Per-provider split of this same day's totals. Desc by tokens; only
   *  providers with usage that day appear (never a zero-filled row). */
  byProvider: UsageDayProvider[];
};

/** A ranked slice of usage by model / provider / project. `label` is the
 *  display-ready name (already resolved from a path/id where relevant);
 *  `key` is the stable identity the UI keys off of. */
export type UsageBySlice = {
  key: string;
  label: string;
  provider?: string;
  tokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  costUsd: number;
};

export type AgentUsageReport = {
  generatedAt: number;
  range: UsageRange;
  scope: "project" | "global";
  projectPath: string | null;
  totals: UsageTotals;
  /** Ascending, one entry per day in range (including zero days). */
  days: UsageDay[];
  /** Desc by tokens. */
  models: UsageBySlice[];
  providers: UsageBySlice[];
  projects: UsageBySlice[];
};

export function rangeStart(range: UsageRange, now: number = Date.now()): number | null {
  if (range === "all") return null;
  const days = range === "7d" ? 7 : 30;
  const d = new Date(now);
  const start = new Date(d.getFullYear(), d.getMonth(), d.getDate());
  start.setDate(start.getDate() - (days - 1));
  return start.getTime();
}

/** Local calendar midnight containing `ms` — walks day charts via `setDate`. */
export function startOfLocalDay(ms: number): Date {
  const d = new Date(ms);
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** Local `YYYY-MM-DD` for a `Date`. */
export function localDateLabel(d: Date): string {
  return d.toLocaleDateString("en-CA");
}
