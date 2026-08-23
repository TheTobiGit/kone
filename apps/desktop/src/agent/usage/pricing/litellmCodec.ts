// Parses LiteLLM's `model_prices_and_context_window.json` — the community-
// maintained rate card this whole engine leans on as its primary source (see
// resolver.ts for why it outranks models.dev). The feed is a flat
// `{modelKey: {...fields}}` object; costs are USD-per-token, so everything
// here is scaled by 1e6 to match kone's per-million convention.
//
// Long-context tiers are keyed inconsistently across model families —
// Anthropic's Claude models publish `_above_200k_tokens` fields, OpenAI's
// GPT-5.4/5.5/5.6 family publishes `_above_272k_tokens` instead, and other
// thresholds (128k/256k/512k) show up too. Rather than hardcode 200k like a
// naive port would, this scans every field name for the
// `_above_{N}k_tokens` pattern and uses whichever threshold the model
// actually publishes — a model that ships no such field simply has no
// `longContext` tier at all, which is the honest answer for e.g. DeepSeek's
// flat-rate models.

import type { ModelRates, PricingTable } from "./types.js";

/** The rate fields this codec reads off one feed entry. Entries come off the
 *  wire unchecked, so each read is gated on a finite-number check before use
 *  rather than being trusted because of this shape. */
interface LiteLLMRates {
  input_cost_per_token?: number;
  output_cost_per_token?: number;
  cache_creation_input_token_cost?: number;
  cache_read_input_token_cost?: number;
  input_cost_per_token_priority?: number;
}

interface LiteLLMEntry extends LiteLLMRates {
  provider_specific_entry?: { fast?: number };
}

type LiteLLMFeed = Record<string, LiteLLMEntry | undefined>;

const ABOVE_TIER_PATTERN = /_above_(\d+)k_tokens$/;

/** A finite number or nothing. Number.isFinite rejects every non-number the
 *  wire could deliver (strings, booleans, NaN, Infinity), so this one check
 *  covers both "field present" and "field actually a usable rate". */
function finiteOrUndefined(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? value : undefined;
}

/** Finds the single long-context threshold this entry publishes (if any) by
 *  scanning its field names, then reads each bucket's rate at that suffix.
 *  Real feeds never mix two thresholds on one model (verified against a live
 *  pull of the feed while building this), so the first suffix found is used
 *  for every bucket. Every argument here is a raw per-token rate (not yet
 *  scaled to per-million) so the fallback math matches the base-rate path
 *  in `parseLiteLLM` exactly. There's no base input parameter here because
 *  the tier's own input/output fields are required (a suffix with either one
 *  missing isn't treated as a usable tier at all, see below) — only the
 *  cache buckets, which providers sometimes omit even at the higher tier,
 *  fall back to the base rate. */
function longContextTier(rates: LiteLLMRates, baseCacheWritePerToken: number, baseCacheReadPerToken: number) {
  const fields = new Map(Object.entries(rates));
  let suffix: string | undefined;
  for (const field of fields.keys()) {
    const match = ABOVE_TIER_PATTERN.exec(field);
    if (match) {
      suffix = match[0];
      break;
    }
  }
  if (!suffix) return undefined;
  const tierSuffix = suffix;
  const bucket = (prefix: string) => finiteOrUndefined(fields.get(`${prefix}${tierSuffix}`));
  const input = bucket("input_cost_per_token");
  const output = bucket("output_cost_per_token");
  if (input === undefined || output === undefined) return undefined;
  const thresholdTokens = Number(tierSuffix.match(/\d+/)![0]) * 1000;
  const cacheWrite = bucket("cache_creation_input_token_cost") ?? baseCacheWritePerToken;
  const cacheRead = bucket("cache_read_input_token_cost") ?? baseCacheReadPerToken;
  return {
    thresholdTokens,
    inputPerMillion: input * 1_000_000,
    outputPerMillion: output * 1_000_000,
    cacheWritePerMillion: cacheWrite * 1_000_000,
    cacheReadPerMillion: cacheRead * 1_000_000,
  };
}

/** Builds a pricing table from LiteLLM's full feed. Entries missing either
 *  an input or output cost are skipped — those are non-chat modes
 *  (embeddings, moderation) and stub entries LiteLLM carries for its own
 *  routing logic, never something kone would bill tokens against. */
export function parseLiteLLM(raw: LiteLLMFeed, retrievedAt?: string): PricingTable {
  if (raw === null || raw === undefined) throw new Error("LiteLLM feed is not a JSON object");
  const entries: Record<string, ModelRates> = {};
  for (const [key, entry] of Object.entries(raw)) {
    if (!entry) continue;
    const input = finiteOrUndefined(entry.input_cost_per_token);
    const output = finiteOrUndefined(entry.output_cost_per_token);
    if (input === undefined || output === undefined) continue;
    const cacheWriteField = finiteOrUndefined(entry.cache_creation_input_token_cost);
    const cacheReadField = finiteOrUndefined(entry.cache_read_input_token_cost);
    const rates: ModelRates = {
      inputPerMillion: input * 1_000_000,
      outputPerMillion: output * 1_000_000,
      cacheWritePerMillion: (cacheWriteField ?? input) * 1_000_000,
      cacheReadPerMillion: (cacheReadField ?? input * 0.1) * 1_000_000,
      cacheReadIsExplicit: cacheReadField !== undefined,
      fastMultiplier: 1,
      longContext: longContextTier(entry, cacheWriteField ?? input, cacheReadField ?? input * 0.1),
    };
    // Two independent ways LiteLLM records a fast/priority tier: Anthropic
    // models carry an explicit scalar in `provider_specific_entry.fast`;
    // OpenAI models instead publish a full `_priority` rate card (its
    // "priority processing" service tier) with no separate scalar field at
    // all. Both were verified live to be a single clean multiplier across
    // every bucket for every model that has them (never a per-bucket-varying
    // ratio) — a model whose priority/fast rate turned out inconsistent
    // would be a sign the source changed shape and deserves its own
    // supplement override rather than a guessed average.
    const explicitFast = finiteOrUndefined(entry.provider_specific_entry?.fast);
    if (explicitFast !== undefined) {
      rates.fastMultiplier = explicitFast;
    } else {
      const priorityInput = finiteOrUndefined(entry.input_cost_per_token_priority);
      if (priorityInput !== undefined && input > 0) rates.fastMultiplier = priorityInput / input;
    }
    entries[key] = rates;
  }
  if (Object.keys(entries).length === 0) throw new Error("LiteLLM feed contained no usable model entries");
  return { entries, retrievedAt };
}
