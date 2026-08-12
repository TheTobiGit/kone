// Parses models.dev's `api.json` — the gap-filler source, consulted only
// after both the supplement and LiteLLM have missed (see resolver.ts). Its
// shape is `{providerName: {models: {modelId: {cost: {...}}}}}`; unlike
// LiteLLM, costs are already USD-per-million, and long-context tiers (when
// present) live in a `tiers` array rather than suffixed field names.
//
// models.dev aggregates the same model under several reseller providers with
// occasionally-diverging rates (a discount reseller vs. the vendor's own
// provider (in name-sorted order) that carries a given model id and ignoring
// the rest — not the "best" price, just a deterministic one, since there's
// no principled way to know which reseller a given kone install actually
// routes through. This port keeps that rule so results reproduce.

import type { ModelRates, PricingTable } from "./types.js";

interface CostBlock {
  input?: number;
  output?: number;
  cache_read?: number;
  cache_write?: number;
}

interface TierBlock extends CostBlock {
  tier?: { type?: string; size?: number };
}

function isCostBlock(value: unknown): value is CostBlock & { tiers?: TierBlock[] } {
  return Boolean(value) && typeof value === "object";
}

function longContextTier(cost: CostBlock & { tiers?: TierBlock[] }, baseInput: number) {
  const tier = cost.tiers?.[0];
  if (!tier || typeof tier.tier?.size !== "number") return undefined;
  if (typeof tier.input !== "number" || typeof tier.output !== "number") return undefined;
  return {
    thresholdTokens: tier.tier.size,
    inputPerMillion: tier.input,
    outputPerMillion: tier.output,
    cacheWritePerMillion: tier.cache_write ?? tier.input,
    cacheReadPerMillion: tier.cache_read ?? baseInput * 0.1,
  };
}

/** Builds a pricing table from models.dev's full feed. Only chat-priced
 *  entries with both an input and output rate are kept — the feed also
 *  carries embedding/image/speech models with a differently-shaped `cost`
 *  block that this codec deliberately doesn't try to price. */
export function parseModelsDev(raw: unknown, retrievedAt?: string): PricingTable {
  if (!raw || typeof raw !== "object") throw new Error("models.dev feed is not a JSON object");
  const entries: Record<string, ModelRates> = {};
  const providerNames = Object.keys(raw as Record<string, unknown>).sort();
  for (const providerName of providerNames) {
    const provider = (raw as Record<string, unknown>)[providerName];
    if (!provider || typeof provider !== "object") continue;
    const models = (provider as Record<string, unknown>).models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, value] of Object.entries(models as Record<string, unknown>)) {
      if (entries[modelId]) continue; // first provider in sorted order wins
      if (!value || typeof value !== "object") continue;
      const cost = (value as Record<string, unknown>).cost;
      if (!isCostBlock(cost)) continue;
      const { input, output } = cost;
      if (typeof input !== "number" || typeof output !== "number") continue;
      entries[modelId] = {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheWritePerMillion: cost.cache_write ?? input,
        cacheReadPerMillion: cost.cache_read ?? input * 0.1,
        cacheReadIsExplicit: cost.cache_read !== undefined,
        fastMultiplier: 1,
        longContext: longContextTier(cost, input),
      };
    }
  }
  if (Object.keys(entries).length === 0) throw new Error("models.dev feed contained no usable model entries");
  return { entries, retrievedAt };
}
