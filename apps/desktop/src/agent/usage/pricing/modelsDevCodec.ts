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
  // Name-sorted entries keep the documented "first provider in sorted order
  // wins" rule deterministic.
  const providerBlocks = Object.entries(raw).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, provider] of providerBlocks) {
    if (!provider || typeof provider !== "object") continue;
    const models = provider.models;
    if (!models || typeof models !== "object") continue;
    for (const [modelId, value] of Object.entries(models)) {
      if (entries[modelId]) continue; // first provider in sorted order wins
      if (!value || typeof value !== "object") continue;
      const costRaw = "cost" in value ? value.cost : undefined;
      if (!isCostBlock(costRaw)) continue;
      const { input, output } = costRaw;
      if (typeof input !== "number" || typeof output !== "number") continue;
      entries[modelId] = {
        inputPerMillion: input,
        outputPerMillion: output,
        cacheWritePerMillion: costRaw.cache_write ?? input,
        cacheReadPerMillion: costRaw.cache_read ?? input * 0.1,
        cacheReadIsExplicit: costRaw.cache_read !== undefined,
        fastMultiplier: 1,
        longContext: longContextTier(costRaw, input),
      };
    }
  }
  if (Object.keys(entries).length === 0) throw new Error("models.dev feed contained no usable model entries");
  return { entries, retrievedAt };
}
