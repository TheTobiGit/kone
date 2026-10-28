// A turn's trace, as the timeline shows it under a request: what the turn
// cost in tokens and dollars, and who answered it. Built from the per-turn
// usage rows the store already keeps — grouped by the provider session each
// row names, or, for rows older than that column, by the hand-in boundaries
// that started a new session — and priced here because pricing lives in the
// main process and the renderer never sees the catalog.

import { RUNNING_TOTAL_PROVIDERS, type TurnUsageRecord } from "./conversationStoreTypes.js";
import { priceTurnUsage } from "./usage/storeUsage.js";

export type TurnTraceRecord = TurnUsageRecord & {
  /** Dollars the turn cost at the current price list; null when its model
   *  has no price or its counts are unknown. */
  costUsd: number | null;
};

/** The read surface a turn trace needs: the thread's usage rows, and its
 *  hand-in boundaries. Boundaries are only a fallback for rows written before
 *  usage rows carried a session id; new rows are grouped by that durable id. */
type TurnTraceStore = {
  listTurnUsage(threadId: string): TurnUsageRecord[];
  handInsForThread(threadId: string): ReadonlyArray<{ at: number }>;
};

const COUNTS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheCreationTokens",
  "reasoningTokens",
] as const satisfies ReadonlyArray<keyof TurnUsageRecord>;

export function turnTraces(store: TurnTraceStore, threadId: string): TurnTraceRecord[] {
  const boundaries = store
    .handInsForThread(threadId)
    .map((handIn) => handIn.at)
    .sort((a, b) => a - b);
  let before: TurnUsageRecord | null = null;
  let beforeLegacyTally = -1;
  let legacyTally = 0;
  let nextBoundary = 0;
  return store.listTurnUsage(threadId).map((row) => {
    // Legacy rows (no recorded session id) predate the durable boundary, so
    // they keep the old reading: each hand-in at or before the row starts a
    // new tally. New rows ignore these timestamps entirely.
    while (nextBoundary < boundaries.length && boundaries[nextBoundary]! <= row.at) {
      legacyTally += 1;
      nextBoundary += 1;
    }
    const own = ownSpend(row, before, beforeLegacyTally, legacyTally);
    before = row;
    beforeLegacyTally = legacyTally;
    return { ...own, costUsd: priceRow(own) };
  });
}

// SAFETY: a provider name is only ever compared against the list, never used
// as one of its members.
const isRunningTotal = (provider: string | null): boolean =>
  provider !== null && (RUNNING_TOTAL_PROVIDERS as readonly string[]).includes(provider);

/** The turn's own spend. Most providers report each turn's; the running-total
 *  ones report the whole provider session so far, so their turn is the step
 *  from the row just before within that same session.
 *
 *  A session id on both rows is the durable answer, and the only one used for
 *  rows that carry it: two counters are comparable exactly when the provider
 *  says they belong to the same native session, whatever the provider, model
 *  or clock says. Legacy rows carry no id, so they keep the old reading — the
 *  same provider across no hand-in boundary. A pair with only one side named
 *  has no known boundary and is not subtracted, rather than guessed from the
 *  provider name or timestamps. A count that went down within one session
 *  (the provider reset it) is that turn's own rather than a negative. */
function ownSpend(
  row: TurnUsageRecord,
  before: TurnUsageRecord | null,
  beforeLegacyTally: number,
  legacyTally: number,
): TurnUsageRecord {
  if (!before || !isRunningTotal(row.provider) || before.provider !== row.provider) {
    return row;
  }
  const sameSession =
    row.usageSessionId !== null
      ? before.usageSessionId === row.usageSessionId
      : before.usageSessionId === null && beforeLegacyTally === legacyTally;
  if (!sameSession) return row;
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
