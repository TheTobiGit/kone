// A turn's trace, as the timeline shows it under a request: what the turn
// cost in tokens and dollars, and who answered it. Built from the per-turn
// usage rows the store already keeps, priced here because pricing lives in
// the main process and the renderer never sees the catalog.

import type { TurnUsageRecord } from "./conversationStoreTypes.js";
import { priceTurnUsage } from "./usage/storeUsage.js";

export type TurnTraceRecord = TurnUsageRecord & {
  /** Dollars the turn cost at the current price list; null when its model
   *  has no price or its counts are unknown. */
  costUsd: number | null;
};

export function turnTraces(store: { listTurnUsage(threadId: string): TurnUsageRecord[] }, threadId: string): TurnTraceRecord[] {
  return store.listTurnUsage(threadId).map((row) => ({ ...row, costUsd: priceRow(row) }));
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
