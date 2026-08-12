// Compatibility shim over the real pricing engine in ./pricing/. This file
// used to hold a flat, hand-maintained input/output rate table; it's now a
// thin adapter so `ConversationStore.ts`'s two call sites (`estimateCost`,
// indirectly `rateForModel`) keep compiling and behaving the same way while
// every new caller reaches for ./pricing/index.ts directly.
//
// Two things are deliberately lost in this adapter, both scoped exceptions
// rather than oversights:
//
//   - Only two buckets. The new engine prices input/output/cache-read/
//     cache-write separately (see pricing/types.ts) and picks a long-context
//     tier per request; `rateForModel`'s `{ input, output }` shape has no
//     room for any of that, so a model with a real cache discount or a
//     long-context tier gets approximated here by its *standard* input/
//     output rate only. `estimateCost` shares the same limitation, and also
//     collapses onto `input`+`output` token counts only (no cache tokens).
//   - Silent zero, not exclusion. The new engine's whole point is to report
//     an unpriceable model instead of silently pricing it at zero (see
//     pricing/resolver.ts and pricing/cost.ts) — but `estimateCost`'s return
//     type is a bare `number`, so there's nowhere to surface that here.
//     `ConversationStore.ts` still gets 0 for a model no source can price,
//     exactly like before. Migrating its two call sites to `priceMany`'s
//     `{ dollars, excludedModels }` shape is the real fix; that's out of
//     scope for this change (ConversationStore.ts is owned by other work
//     landing in this same worktree right now).
//
// Everything else — which of the three layers actually resolves a model,
// fuzzy matching, fast-variant multipliers — now comes from the real engine,
// so this file no longer drifts out of date on its own hand-maintained
// table.

import { costForRates, currentPricingSnapshot, resolveModelRates } from "./pricing/index.js";

export type ModelRate = { input: number; output: number };

/** The standard (non-cache, non-long-context, non-fast) input/output rate
 *  for a model, per the three-layer engine in ./pricing/. Returns null when
 *  no layer can price it — same contract as the old static-table lookup,
 *  callers must not treat null as "free". */
export function rateForModel(model: string | null | undefined): ModelRate | null {
  const rates = resolveModelRates(currentPricingSnapshot(), model);
  if (!rates) return null;
  return { input: rates.inputPerMillion, output: rates.outputPerMillion };
}

/** Estimated USD cost for an input/output token count against a model's
 *  standard rate. 0 for a model with no known rate, or non-positive/missing
 *  token counts — never a fabricated price, and never blocks on the pricing
 *  engine's background refresh (see pricing/store.ts: a lookup always reads
 *  whatever is already loaded). */
export function estimateCost(
  model: string | null | undefined,
  inputTokens: number,
  outputTokens: number,
): number {
  const rates = resolveModelRates(currentPricingSnapshot(), model);
  if (!rates) return 0;
  const input = Number.isFinite(inputTokens) && inputTokens > 0 ? inputTokens : 0;
  const output = Number.isFinite(outputTokens) && outputTokens > 0 ? outputTokens : 0;
  return costForRates(rates, { input, output, cacheRead: 0, cacheWrite: 0 });
}
