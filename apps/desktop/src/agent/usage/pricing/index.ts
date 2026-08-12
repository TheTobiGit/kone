// Public surface for the pricing engine. Everything else under this
// directory is an implementation detail of these exports:
//
//   - `priceMany`/`priceModel` turn token counts into dollars, honestly —
//     `priceMany`'s `excludedModels` is the answer to requirement #7 (see
//     store.ts/resolver.ts file headers): a model no source can price never
//     contributes a silent $0, it's named instead.
//   - `canPriceModel` answers "can this be priced at all" without computing
//     a cost, for a caller that wants to warn before any tokens accrue.
//   - `currentPricingSnapshot`/`refreshPricingNow` are the store's two entry
//     points — the former for normal callers (synchronous, never blocks),
//     the latter for tests/tooling that want a refresh to actually finish
//     before continuing.

export type { ModelRates, TokenBuckets, PricedTotal, PricingTable } from "./types.js";
export type { PricingSnapshot } from "./resolver.js";
export type { PriceOutcome } from "./cost.js";
export type { StoreDeps } from "./store.js";

export { resolveModelRates, canPriceModel } from "./resolver.js";
export { costForRates, priceModel, priceMany } from "./cost.js";
export { currentPricingSnapshot, refreshPricingNow } from "./store.js";
