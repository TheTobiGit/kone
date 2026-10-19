// A turn's trace, as the timeline shows it under a request: what the turn
// cost in tokens and dollars, and who answered it. Built from the per-turn
// usage rows the store already keeps, priced here because pricing lives in
// the main process and the renderer never sees the catalog.

import { RUNNING_TOTAL_PROVIDERS, type TurnUsageRecord } from "./conversationStoreTypes.js";
import { priceTurnUsage } from "./usage/storeUsage.js";

export type TurnTraceRecord = TurnUsageRecord & {
  /** Dollars the turn cost at the current price list; null when its model
   *  has no price or its counts are unknown. */
  costUsd: number | null;
};

const COUNTS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
] as const satisfies ReadonlyArray<keyof TurnUsageRecord>;

export function turnTraces(store: { listTurnUsage(threadId: string): TurnUsageRecord[] }, threadId: string): TurnTraceRecord[] {
  let before: TurnUsageRecord | null = null;
  return store.listTurnUsage(threadId).map((row) => {
    const own = ownSpend(row, before);
    if (isRunningTotal(row.provider)) before = row;
    return { ...own, costUsd: priceRow(own) };
  });
}

// SAFETY: a provider name is only ever compared against the list, never used
// as one of its members.
const isRunningTotal = (provider: string | null): boolean =>
  provider !== null && (RUNNING_TOTAL_PROVIDERS as readonly string[]).includes(provider);

/** The turn's own spend. Most providers report each turn's; the running-total
 *  ones report the whole thread so far, so their turn is the step from that
 *  provider's row before. A row after a hand-off to another provider starts
 *  that provider's tally, and a count that went down (the thread started
 *  over, or the provider reset its tally) is that turn's own, not a negative. */
function ownSpend(row: TurnUsageRecord, before: TurnUsageRecord | null): TurnUsageRecord {
  if (!before || !isRunningTotal(row.provider) || before.provider !== row.provider) return row;
  const own: TurnUsageRecord = { ...row };
  for (const key of COUNTS) {
    const now = row[key];
    const then = before[key];
    if (now === null || then === null) continue;
    own[key] = now >= then ? now - then : now;
  }
  return own;
}

function priceRow(row: TurnUsageRecord): number | null {
  if (row.inputTokens === null && row.outputTokens === null) return null;
  return (
    priceTurnUsage(row.model, {
      input: row.inputTokens ?? 0,
      output: row.outputTokens ?? 0,
      cacheRead: row.cacheReadTokens,
      cacheWrite: row.cacheCreationTokens,
    }) ?? null
  );
}
