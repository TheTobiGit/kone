// Turns a resolved `ModelRates` plus one usage event's token buckets into a
// dollar figure, and turns a batch of (model, tokens) pairs into a
// `PricedTotal` that never silently prices an unknown model at zero.

import { resolveModelRates, type PricingSnapshot } from "./resolver.js";
import type { ModelRates, PricedTotal, TokenBuckets } from "./types.js";

function positive(n: number | undefined): number {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/** Dollar cost of one usage event's tokens against already-resolved rates.
 *  The long-context tier switches the *whole* request to its rates once the
 *  prompt (input + both cache buckets — output tokens don't select the
 *  tier, but bill at it once selected) crosses the threshold, matching how
 *  providers actually meter it: they don't charge a blended rate across the
 *  boundary, the higher tier applies to the entire request. */
export function costForRates(rates: ModelRates, tokens: TokenBuckets): number {
  const input = positive(tokens.input);
  const output = positive(tokens.output);
  const cacheRead = positive(tokens.cacheRead);
  const cacheWrite = positive(tokens.cacheWrite);

  const promptTokens = input + cacheRead + cacheWrite;
  const tier =
    rates.longContext && promptTokens > rates.longContext.thresholdTokens ? rates.longContext : rates;
  const multiplier = tokens.isFast ? rates.fastMultiplier : 1;

  const dollars =
    input * tier.inputPerMillion +
    output * tier.outputPerMillion +
    cacheRead * tier.cacheReadPerMillion +
    cacheWrite * tier.cacheWritePerMillion;

  return (dollars / 1_000_000) * multiplier;
}

export type PriceOutcome = { priced: true; dollars: number } | { priced: false };

/** Prices one usage event. `{ priced: false }` means no source could resolve
 *  `model` — callers must exclude its tokens from any total rather than
 *  treating this the same as a real $0 result (a free tier, or all-zero
 *  token counts, both still come back `priced: true`). */
export function priceModel(
  snapshot: PricingSnapshot,
  model: string | null | undefined,
  tokens: TokenBuckets,
): PriceOutcome {
  const rates = resolveModelRates(snapshot, model);
  if (!rates) return { priced: false };
  return { priced: true, dollars: costForRates(rates, tokens) };
}

/** Prices a batch of usage events and folds them into one total. This is the
 *  shape most callers actually want (a usage report scanning thousands of
 *  turn_usage rows): a dollar figure that only ever covers tokens a source
 *  could price, plus the distinct list of models that couldn't be, named so
 *  the caller can tell the user the total is a floor, not the real spend,
 *  and which models to blame. */
export function priceMany(
  snapshot: PricingSnapshot,
  entries: Iterable<{ model: string | null | undefined; tokens: TokenBuckets }>,
): PricedTotal {
  let dollars = 0;
  const excluded = new Set<string>();
  for (const { model, tokens } of entries) {
    const outcome = priceModel(snapshot, model, tokens);
    if (outcome.priced) {
      dollars += outcome.dollars;
    } else if (model && model.trim()) {
      excluded.add(model.trim());
    }
  }
  return { dollars, excludedModels: [...excluded].sort() };
}
