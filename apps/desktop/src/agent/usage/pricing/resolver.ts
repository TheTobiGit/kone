// ModelPricing.swift. A model name resolves against, in strict order:
//
//   1. kone's own supplement (supplement.ts) — never overridden below.
//   2. LiteLLM exact match, then a `-fast` suffix (base model x multiplier),
//      then LiteLLM fuzzy match.
//   3. models.dev exact match only — it aggregates the same model under
//      several resellers with occasionally-diverging rates (see
//      modelsDevCodec.ts), so fuzzy-matching against it risks picking a
//      reseller's price for a model the caller never actually routed
//      through. An unmatched slug variant stays unpriced here rather than
//      guessing.
//
// A model no layer can price returns null. Callers must treat that as "we
// genuinely don't know", never as "$0" — see index.ts for where that
// distinction actually matters (excludedModels vs. a silently-low total).

import { findExact, findFuzzy } from "./catalog.js";
import { canonicalNameFor, supplement } from "./supplement.js";
import type { ModelRates, PricingTable } from "./types.js";

export interface PricingSnapshot {
  /** LiteLLM's table — consulted first of the two public catalogs. */
  primary: PricingTable;
  /** models.dev's table — gap-filler only, exact match. */
  secondary: PricingTable;
}

export const emptySnapshot: PricingSnapshot = { primary: { entries: {} }, secondary: { entries: {} } };

// Resolution walks every entry in the primary table on a fuzzy miss (see
// catalog.ts), so memoizing pays for itself under a report that prices
// hundreds of usage rows against a handful of distinct model ids. Keyed by
// snapshot object identity: store.ts publishes a brand-new snapshot object
// on every successful refresh, so a stale memo can never outlive the data
// it was computed from — there's nothing to invalidate by hand.
const memoBySnapshot = new WeakMap<PricingSnapshot, Map<string, ModelRates | null>>();

/** Rates for `model` against `snapshot`, or null when no layer can price it.
 *  `model` should be the raw id as the provider adapter recorded it — this
 *  function normalizes case and whitespace internally, but does not strip
 *  gateway prefixes or turn-parameter suffixes; the fuzzy matcher in
 *  catalog.ts is boundary-aware enough to see through those on its own. */
export function resolveModelRates(snapshot: PricingSnapshot, model: string | null | undefined): ModelRates | null {
  if (!model || typeof model !== "string") return null;
  const trimmed = model.trim();
  if (!trimmed) return null;

  let memo = memoBySnapshot.get(snapshot);
  if (!memo) {
    memo = new Map();
    memoBySnapshot.set(snapshot, memo);
  }
  const cached = memo.get(trimmed);
  if (cached !== undefined) return cached;

  const resolved = resolveUncached(snapshot, trimmed);
  memo.set(trimmed, resolved);
  return resolved;
}

/** Whether `model` can be priced at all, without computing a cost — for a UI
 *  that wants to warn about an unpriceable model before any tokens have
 *  accrued, rather than only after the fact via `excludedModels`. */
export function canPriceModel(snapshot: PricingSnapshot, model: string | null | undefined): boolean {
  return resolveModelRates(snapshot, model) !== null;
}

function resolveUncached(snapshot: PricingSnapshot, model: string): ModelRates | null {
  const canonical = canonicalNameFor(model);
  if (canonical && canonical !== model) {
    return lookup(snapshot, canonical) ?? lookup(snapshot, model);
  }
  return lookup(snapshot, model);
}

function normalize(name: string): string {
  return name.toLowerCase();
}

function lookup(snapshot: PricingSnapshot, name: string): ModelRates | null {
  const key = normalize(name);
  const direct = supplement.pricing[key];
  if (direct) return direct;

  const exact = findExact(snapshot.primary, key);
  if (exact) return exact.rates;

  const fast = fastVariant(snapshot, key);
  if (fast) return fast;

  // A `-fast` slug that LiteLLM can't price by exact match or multiplier
  // falls through to models.dev's exact entry for that literal slug, never
  // to LiteLLM's fuzzy match — fuzzy-matching a `-fast` id against a
  // standard-speed catalog key would silently charge the slow rate for a
  // fast request, which is worse than leaving it unpriced.
  if (key.endsWith("-fast")) {
    const secondaryFast = findExact(snapshot.secondary, key);
    return secondaryFast ? secondaryFast.rates : null;
  }

  const fuzzy = findFuzzy(snapshot.primary, key);
  if (fuzzy) return fuzzy.rates;

  const secondaryExact = findExact(snapshot.secondary, key);
  if (secondaryExact) return secondaryExact.rates;

  return null;
}

/** Prices a `<base>-fast` slug from its base entry, scaled by whatever fast
 *  multiplier is known for it. Returns null when no multiplier is known —
 *  the caller (`lookup`) then tries models.dev's exact entry for the
 *  literal `-fast` slug before giving up, but never falls back to the
 *  base model's standard-speed rate. */
function fastVariant(snapshot: PricingSnapshot, name: string): ModelRates | null {
  if (!name.endsWith("-fast")) return null;
  const base = name.slice(0, -"-fast".length);
  if (!base) return null;
  const baseRates = baseEntry(snapshot, base);
  if (!baseRates) return null;
  const multiplier = baseRates.fastMultiplier !== 1 ? baseRates.fastMultiplier : supplement.fastMultipliers[base];
  if (!multiplier) return null;
  return scaleRates(baseRates, multiplier);
}

function baseEntry(snapshot: PricingSnapshot, base: string): ModelRates | null {
  const direct = supplement.pricing[base];
  if (direct) return direct;
  const exact = findExact(snapshot.primary, base);
  if (exact) return exact.rates;
  const fuzzy = findFuzzy(snapshot.primary, base);
  if (fuzzy) return fuzzy.rates;
  const secondaryExact = findExact(snapshot.secondary, base);
  if (secondaryExact) return secondaryExact.rates;
  return null;
}

function scaleRates(rates: ModelRates, factor: number): ModelRates {
  return {
    inputPerMillion: rates.inputPerMillion * factor,
    outputPerMillion: rates.outputPerMillion * factor,
    cacheWritePerMillion: rates.cacheWritePerMillion * factor,
    cacheReadPerMillion: rates.cacheReadPerMillion * factor,
    cacheReadIsExplicit: rates.cacheReadIsExplicit,
    longContext: rates.longContext
      ? {
          thresholdTokens: rates.longContext.thresholdTokens,
          inputPerMillion: rates.longContext.inputPerMillion * factor,
          outputPerMillion: rates.longContext.outputPerMillion * factor,
          cacheWritePerMillion: rates.longContext.cacheWritePerMillion * factor,
          cacheReadPerMillion: rates.longContext.cacheReadPerMillion * factor,
        }
      : undefined,
    // The scaled entry's own multiplier resets to 1 — the multiplier already
    // went into the numbers above, and nothing should apply it a second time
    // (`fastVariant` is only ever reached for a request that is *already*
    // priced via its `-fast` slug, not a base-model request flagged fast).
    fastMultiplier: 1,
  };
}
