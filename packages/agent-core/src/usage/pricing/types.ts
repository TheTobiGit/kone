// Shared shapes for the pricing engine. Kept dependency-free (no Electron, no
// fs) so every other file under usage/pricing/ can import from here without
// pulling in I/O — the types are the contract between the codecs (which turn
// raw feed JSON into these), the resolver (which picks one per model), and
// the cost math (which turns one plus a token count into dollars).

/** USD-per-million-token rates for one model, plus the two things that change
 *  which rate applies: a long-context tier and a fast/priority multiplier.
 *
 *  Four buckets, not two — a request's prompt tokens split into plain input,
 *  a cache write, and a cache read, each priced differently by every
 *  provider that supports prompt caching, and pricing only input+output (as
 *  kone's previous static table did) either overcounts a cache-heavy agent
 *  turn several-fold or undercounts it, depending which rate you reuse for
 *  the cache buckets. Charging each bucket at its own rate is the only way
 *  to get an honest number out of a caching-heavy tool-use loop. */
export interface ModelRates {
  inputPerMillion: number;
  outputPerMillion: number;
  /** Rate for tokens written into the provider's prompt cache. Anthropic and
   *  OpenAI both charge a premium over the plain input rate here (roughly
   *  1.25x for Anthropic's 5-minute cache); a source that never publishes
   *  this separately gets its input rate copied in by the codec instead of
   *  going unpriced. */
  cacheWritePerMillion: number;
  /** Rate for tokens served out of the cache instead of reprocessed — almost
   *  always a steep discount (Anthropic: 10% of input) and, like
   *  `cacheWritePerMillion`, backfilled from the input rate by the codec
   *  when a source doesn't publish it. */
  cacheReadPerMillion: number;
  /** Whether the source that produced these rates actually published a
   *  cache-read discount, versus the codec synthesizing the usual 10%-of-
   *  input fallback. Some providers (Codex chief among them) charge full
   *  input price for cached tokens when they advertise no discount at all,
   *  so a caller that needs to tell "known 10% discount" from "no discount
   *  published, guessed 10%" apart can check this bit instead of assuming. */
  cacheReadIsExplicit: boolean;
  /** Some models charge a flat higher rate for the *entire* request once its
   *  prompt crosses a threshold, rather than metering the overage — Claude's
   *  1M-context models above 200k tokens, GPT-5.4/5.5/5.6 above 272k. The
   *  threshold is per-model (LiteLLM's `_above_200k_tokens` fields imply
   *  200k; models.dev's `tiers[0].tier.size` states it explicitly and some
   *  models use 256k/272k/512k), so it travels with the rates rather than
   *  being hardcoded once for every model. */
  longContext?: {
    thresholdTokens: number;
    inputPerMillion: number;
    outputPerMillion: number;
    cacheWritePerMillion: number;
    cacheReadPerMillion: number;
  };
  /** Multiplier applied to every bucket above when the request ran the
   *  model's fast/priority service tier (OpenAI's `priority` service tier,
   *  Anthropic's `speed: fast`, Cursor's `-fast` model variants). 1 when the
   *  model has no such tier. */
  fastMultiplier: number;
}

/** One usage event's tokens, already split into the four buckets `ModelRates`
 *  prices separately. `isFast` flags a request that ran the model's
 *  fast/priority tier so the cost math can apply `fastMultiplier`. */
export interface TokenBuckets {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  isFast?: boolean;
}

/** The result of pricing one or more usage events. `dollars` covers only the
 *  events whose model a source could price; `excludedModels` names every
 *  distinct model that couldn't be, so a caller can both show a real number
 *  and tell the user it's incomplete — the two things a silent-zero price
 *  can never do at once. See pricing/index.ts for why this replaces the
 *  previous table's "unknown model costs 0" behaviour. */
export interface PricedTotal {
  dollars: number;
  excludedModels: string[];
}

/** A flat model-key -> rates table, as produced by one pricing source
 *  (LiteLLM or models.dev) after its codec runs. `retrievedAt` is
 *  informational only (surfaced in logs/diagnostics), never used to decide
 *  precedence — that's handled by which layer a table sits in, not by age. */
export interface PricingTable {
  entries: Record<string, ModelRates>;
  retrievedAt?: string;
}
