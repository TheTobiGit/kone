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

type RawEntry = Record<string, unknown>;

const ABOVE_TIER_PATTERN = /_above_(\d+)k_tokens$/;

function numberField(entry: RawEntry, key: string): number | undefined {
  const value = entry[key];
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/** Finds the single long-context threshold this entry publishes (if any) by
 *  scanning its field names, then reads each bucket's rate at that suffix.
 *  Real feeds never mix two thresholds on one model (verified against a live
 *  pull of the feed while building this), so the first suffix found is used
 *  for every bucket. Every argument here is a raw per-token rate (not yet
 *  scaled to per-million) so the fallback math matches the base-rate path
 *  in `parseLiteLLM` exactly. There's no `baseInputPerToken` parameter here
 *  because the tier's own input/output fields are required (a suffix with
 *  either one missing isn't treated as a usable tier at all, see below) —
 *  only the cache buckets, which providers sometimes omit even at the
 *  higher tier, fall back to the base rate. */
function longContextTier(entry: RawEntry, baseCacheWritePerToken: number, baseCacheReadPerToken: number) {
  let suffix: string | undefined;
  for (const field of Object.keys(entry)) {
    const match = ABOVE_TIER_PATTERN.exec(field);
    if (match) {
      suffix = match[0];
      break;
    }
  }
  if (!suffix) return undefined;
  const thresholdTokens = Number(suffix.match(/\d+/)![0]) * 1000;
  const input = numberField(entry, `input_cost_per_token${suffix}`);
  const output = numberField(entry, `output_cost_per_token${suffix}`);
  if (input === undefined || output === undefined) return undefined;
  const cacheWrite = numberField(entry, `cache_creation_input_token_cost${suffix}`) ?? baseCacheWritePerToken;
  const cacheRead = numberField(entry, `cache_read_input_token_cost${suffix}`) ?? baseCacheReadPerToken;
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
export function parseLiteLLM(raw: unknown, retrievedAt?: string): PricingTable {
  if (!raw || typeof raw !== "object") throw new Error("LiteLLM feed is not a JSON object");
  const entries: Record<string, ModelRates> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") continue;
    const entry = value as RawEntry;
    const input = numberField(entry, "input_cost_per_token");
    const output = numberField(entry, "output_cost_per_token");
    if (input === undefined || output === undefined) continue;
    const cacheWrite = numberField(entry, "cache_creation_input_token_cost");
    const cacheRead = numberField(entry, "cache_read_input_token_cost");
    const inputPerMillion = input * 1_000_000;
    const outputPerMillion = output * 1_000_000;
    const cacheReadPerMillion = (cacheRead ?? input * 0.1) * 1_000_000;
    const rates: ModelRates = {
      inputPerMillion,
      outputPerMillion,
      cacheWritePerMillion: (cacheWrite ?? input) * 1_000_000,
      cacheReadPerMillion,
      cacheReadIsExplicit: cacheRead !== undefined,
      fastMultiplier: 1,
      longContext: longContextTier(entry, cacheWrite ?? input, cacheRead ?? input * 0.1),
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
    const providerSpecific = entry.provider_specific_entry;
    const explicitFast =
      providerSpecific && typeof providerSpecific === "object" ? (providerSpecific as RawEntry).fast : undefined;
    if (typeof explicitFast === "number" && Number.isFinite(explicitFast)) {
      rates.fastMultiplier = explicitFast;
    } else {
      const priorityInput = numberField(entry, "input_cost_per_token_priority");
      if (priorityInput !== undefined && input > 0) rates.fastMultiplier = priorityInput / input;
    }
    entries[key] = rates;
  }
  if (Object.keys(entries).length === 0) throw new Error("LiteLLM feed contained no usable model entries");
  return { entries, retrievedAt };
}
