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

import { z } from "zod";

import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import type { ModelRates, PricingTable } from "./types.js";

const TierBlockSchema = z.object({
  input: z.number().finite().optional(),
  output: z.number().finite().optional(),
  cache_read: z.number().finite().optional(),
  cache_write: z.number().finite().optional(),
  tier: z.object({
    type: z.string().optional(),
    size: z.number().finite().optional(),
  }).optional(),
}).passthrough();

const CostBlockSchema = z.object({
  input: z.number().finite().optional(),
  output: z.number().finite().optional(),
  cache_read: z.number().finite().optional(),
  cache_write: z.number().finite().optional(),
  tiers: z.array(TierBlockSchema).optional(),
}).passthrough();

const ModelBlockSchema = z.object({
  cost: CostBlockSchema.optional(),
}).passthrough();

const ProviderBlockSchema = z.object({
  models: z.record(z.string(), ModelBlockSchema).optional(),
}).passthrough();

const ModelsDevFeedSchema = z.record(z.string(), ProviderBlockSchema);

function longContextTier(cost: z.infer<typeof CostBlockSchema>, baseInput: number) {
  const tier = cost.tiers?.[0];
  if (!tier || tier.tier?.size === undefined || tier.input === undefined || tier.output === undefined) {
    return undefined;
  }
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
export function parseModelsDev(raw: JsonValue | null | undefined, retrievedAt?: string): PricingTable {
  const parsed = ModelsDevFeedSchema.safeParse(raw);
  if (!parsed.success) throw new Error("models.dev feed is not a JSON object");
  const entries: Record<string, ModelRates> = {};
  // Name-sorted entries keep the documented "first provider in sorted order
  // wins" rule deterministic.
  const providerBlocks = Object.entries(parsed.data).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [, provider] of providerBlocks) {
    if (!provider.models) continue;
    for (const [modelId, value] of Object.entries(provider.models)) {
      if (entries[modelId]) continue; // first provider in sorted order wins
      const cost = value.cost;
      if (!cost) continue;
      const { input, output } = cost;
      if (input === undefined || output === undefined) continue;
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
