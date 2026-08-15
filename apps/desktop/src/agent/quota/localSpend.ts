// Today / Yesterday / Last-30-days spend tiles and the 30-day trend sparkline
// for the providers whose quota API reports rate-limit *windows* but no spend —
// Claude, Codex, and Cursor. OpenCode is absent here: it writes its own
// authoritative per-message cost to a local database, so its tiles come from
// that (quota/opencode.ts) and are exact, not estimated.
//
// Applies to Claude and Codex. The honest move this makes, kept here: the
// **token counts are measured** (read straight from the CLI's own session
// logs), and the **dollars are an estimate**, priced from those tokens at
// published API rates and flagged as such (the `estimated` "~" on the tile).
// Cursor is priced the same way:
// kone reads Cursor's own dashboard usage export, but the CSV only carries
// token counts — the dollars are kone's price-table estimate, imputed from
// locally-read Cursor costs.
//
// Source of the numbers is kone's existing local usage layer
// (buildAgentUsageReport) — the same scan the Usage tab already shows — filtered
// to one provider. No new disk work and no network: it's memoised there.

import type { ConversationStore } from "../ConversationStore.js";
import { buildAgentUsageReport } from "../usage/buildUsageReport.js";
import type { QuotaCapableProvider, SpendTile, TrendPoint } from "./types.js";

/** Whether a provider's dollar figures are kone's estimate (priced from measured
 *  tokens) or the provider's own reported cost. Only the estimate carries the
 *  "~". OpenCode never reaches this module. Cursor is estimated too: its daily
 *  spend comes from either its dashboard export or a kone-store fallback, and
 *  this layer can't tell which, so the conservative "may be estimated" wins. */
const DOLLARS_ARE_ESTIMATED: Record<QuotaCapableProvider, boolean> = {
  claudeAgent: true, // priced from measured tokens at API rates (openusage's ⓘ)
  codex: true, //       same
  cursor: true, //      dashboard export or store fallback — mark as estimated
  opencode: false, //   unused — has its own authoritative source
  antigravity: true, // priced from measured tokens like claudeAgent/codex
  droid: true, //       has no authoritative cost of its own (sidecar is zeros) — kone's estimate
};

const round4 = (n: number) => Math.round(n * 10000) / 10000;

/** The provider's spend on one local day. Zero when the day had no usage — a
 *  real measured zero, not "No data": the strip only builds when the 30-day scan
 *  found usage (see below), so the logs were readable and an empty day genuinely
 *  is `$0.00`, the same as OpenCode's own-DB tiles. */
function sliceFor(
  day: { byProvider: { provider: string; costUsd: number; tokens: number }[] } | undefined,
  provider: QuotaCapableProvider,
): { dollars: number; tokens: number } {
  const p = day?.byProvider.find((x) => x.provider === provider);
  return { dollars: round4(p?.costUsd ?? 0), tokens: p?.tokens ?? 0 };
}

/**
 * Build the spend strip (three tiles) and 30-day trend for one provider from the
 * local usage scan. Returns empty arrays when the provider has no local usage in
 * the window at all, so the card shows no strip rather than three "No data"
 * tiles under a flat line.
 */
export async function localSpendForProvider(
  store: ConversationStore,
  provider: QuotaCapableProvider,
  opts: { forceRefresh?: boolean } = {},
): Promise<{ spend: SpendTile[]; trend: TrendPoint[] }> {
  if (provider === "opencode") return { spend: [], trend: [] };

  const report = await buildAgentUsageReport(store, {
    range: "30d",
    projectPath: null,
    forceRefresh: opts.forceRefresh,
  });
  const days = report.days; // ascending, dense (one entry per day incl. zero days)
  if (days.length === 0) return { spend: [], trend: [] };

  const estimated = DOLLARS_ARE_ESTIMATED[provider];

  // Trend keeps the dense zero-days as points at dollars: 0 — a gap in the line
  // is a different claim from a zero, and for a daily series the zero is true.
  const trend: TrendPoint[] = days.map((d) => {
    const s = sliceFor(d, provider);
    return { date: d.date, dollars: s.dollars, tokens: s.tokens };
  });

  const tile = (idx: number, id: string, label: string): SpendTile => {
    const s = sliceFor(days[idx], provider);
    return { id, label, dollars: s.dollars, tokens: s.tokens, estimated };
  };

  let sumDollars = 0;
  let sumTokens = 0;
  let any = false;
  for (const d of days) {
    const s = sliceFor(d, provider);
    sumDollars += s.dollars;
    sumTokens += s.tokens;
    if (s.dollars > 0 || s.tokens > 0) any = true;
  }
  // Nothing at all in the window → no strip. Keeps a connected-but-idle card
  // clean instead of hanging three "No data" tiles off it.
  if (!any) return { spend: [], trend: [] };

  const spend: SpendTile[] = [
    tile(days.length - 1, "today", "Today"),
    tile(days.length - 2, "yesterday", "Yesterday"),
    {
      id: "last30",
      label: "Last 30 days",
      dollars: round4(sumDollars),
      tokens: sumTokens,
      estimated,
    },
  ];

  return { spend, trend };
}
