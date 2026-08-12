// kone's own pricing layer — see supplementData.json for what lives here and
// why. This is the highest-precedence source in resolver.ts: a model priced
// here is never overridden by LiteLLM or models.dev, because every entry
// exists specifically to correct or fill a gap those two can't cover (a
// Cursor-native model no metered API bills, or a fast-tier rate that isn't a
// clean multiplier of the base model). Unlike LiteLLM and models.dev, this
// file ships bundled only — kone has no gh-pages-style publishing pipeline
// pricing correction here ships with an app update rather than landing
// within the hour. That trade-off is fine in practice: this layer changes
// only when Cursor's own pricing page changes, which is rare compared to
// the two large community feeds it sits above.

import supplementJson from "./supplementData.json" with { type: "json" };
import type { ModelRates } from "./types.js";

interface AliasRule {
  pattern: RegExp;
  canonical: string;
}

export interface Supplement {
  pricing: Record<string, ModelRates>;
  /** Base-model -> fast-variant multiplier, for a `-fast` slug whose base
   *  entry (in this file, LiteLLM, or models.dev) carries no fast rate of
   *  its own. Currently empty — every fast variant kone has needed so far
   *  either resolves through LiteLLM's own multiplier fields or, when the
   *  per-bucket scaling isn't uniform (Cursor's Grok fast tier), gets its
   *  own explicit entry in `pricing` instead. Kept as a real mechanism
   *  rather than deleted so the next uniform-multiplier fast variant that
   *  shows up doesn't need a new code path, just a JSON edit. */
  fastMultipliers: Record<string, number>;
  aliasRules: AliasRule[];
  updatedAt?: string;
}

interface SupplementEntry {
  input_per_million: number;
  output_per_million: number;
  cache_write_per_million?: number;
  cache_read_per_million?: number;
}

interface SupplementFile {
  updated_at?: string;
  pricing: Record<string, SupplementEntry>;
  fast_multipliers?: Record<string, number>;
  alias_rules: Array<{ pattern: string; canonical: string }>;
}

function decode(file: SupplementFile): Supplement {
  const pricing: Record<string, ModelRates> = {};
  for (const [model, entry] of Object.entries(file.pricing)) {
    pricing[model] = {
      inputPerMillion: entry.input_per_million,
      outputPerMillion: entry.output_per_million,
      cacheWritePerMillion: entry.cache_write_per_million ?? entry.input_per_million,
      cacheReadPerMillion: entry.cache_read_per_million ?? entry.input_per_million * 0.1,
      cacheReadIsExplicit: entry.cache_read_per_million !== undefined,
      fastMultiplier: file.fast_multipliers?.[model] ?? 1,
    };
  }
  const aliasRules: AliasRule[] = [];
  for (const rule of file.alias_rules) {
    try {
      aliasRules.push({ pattern: new RegExp(rule.pattern), canonical: rule.canonical });
    } catch {
      // A hand-edited pattern that fails to compile is skipped rather than
      // crashing pricing for every model — the rest of the supplement (and
      // the two catalogs beneath it) still work.
    }
  }
  return { pricing, fastMultipliers: file.fast_multipliers ?? {}, aliasRules, updatedAt: file.updated_at };
}

/** The bundled supplement, decoded once at module load. There's no disk
 *  cache or network fetch for this layer (see file header), so this is the
 *  only place it's ever produced. */
export const supplement: Supplement = decode(supplementJson as SupplementFile);

/** The canonical pricing key `model` should resolve to per the supplement's
 *  alias rules, or undefined when no rule matches — the overwhelming
 *  majority of lookups, since most model ids need no rewriting at all. */
export function canonicalNameFor(model: string): string | undefined {
  for (const rule of supplement.aliasRules) {
    if (rule.pattern.test(model)) return rule.canonical;
  }
  return undefined;
}
