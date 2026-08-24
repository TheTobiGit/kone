// The on-disk format for both the bundled snapshots (committed to the repo)
// and the ETag-refreshed disk cache (written under userData). LiteLLM's raw
// feed is ~1.7MB and models.dev's is ~3.6MB of mostly-irrelevant fields
// (context windows, modality flags, per-provider regional variants) — this
// format keeps only what the cost math needs, with short keys so the
// committed snapshots stay small after the curation pass that already
// dropped everything outside kone's five providers' plausible model reach.

import type { ModelRates, PricingTable } from "./types.js";

interface CompactLongContext {
  /** Prompt-token threshold above which this tier's rates apply. */
  t: number;
  i: number;
  o: number;
  cw: number;
  cr: number;
}

interface CompactModel {
  i: number;
  o: number;
  cw: number;
  cr: number;
  /** Omitted (undefined) means true — the source published a real cache-read
   *  discount. Only ever written `false` for a synthesized 10%-of-input
   *  fallback, so old cache files without this field still decode as
   *  "explicit" rather than silently flipping meaning. */
  cre?: boolean;
  /** Omitted means 1 (no fast/priority tier). */
  fast?: number;
  lc?: CompactLongContext;
}

export interface CompactFile {
  retrievedAt?: string;
  /** Where this snapshot's numbers came from — kept in the file itself (not
   *  just a code comment) so a disk cache written months from now still
   *  says which feed and when, for anyone debugging a surprising price. */
  source?: string;
  models: Record<string, CompactModel>;
}

export function decodeCompact(file: CompactFile): PricingTable {
  const entries: Record<string, ModelRates> = {};
  for (const [key, m] of Object.entries(file.models)) {
    entries[key] = {
      inputPerMillion: m.i,
      outputPerMillion: m.o,
      cacheWritePerMillion: m.cw,
      cacheReadPerMillion: m.cr,
      cacheReadIsExplicit: m.cre ?? true,
      fastMultiplier: m.fast ?? 1,
      longContext: m.lc
        ? {
            thresholdTokens: m.lc.t,
            inputPerMillion: m.lc.i,
            outputPerMillion: m.lc.o,
            cacheWritePerMillion: m.lc.cw,
            cacheReadPerMillion: m.lc.cr,
          }
        : undefined,
    };
  }
  return { entries, retrievedAt: file.retrievedAt };
}

export function encodeCompact(table: PricingTable, source?: string): CompactFile {
  const models: Record<string, CompactModel> = {};
  for (const [key, r] of Object.entries(table.entries)) {
    const model: CompactModel = {
      i: r.inputPerMillion,
      o: r.outputPerMillion,
      cw: r.cacheWritePerMillion,
      cr: r.cacheReadPerMillion,
    };
    if (!r.cacheReadIsExplicit) model.cre = false;
    if (r.fastMultiplier !== 1) model.fast = r.fastMultiplier;
    if (r.longContext) {
      model.lc = {
        t: r.longContext.thresholdTokens,
        i: r.longContext.inputPerMillion,
        o: r.longContext.outputPerMillion,
        cw: r.longContext.cacheWritePerMillion,
        cr: r.longContext.cacheReadPerMillion,
      };
    }
    models[key] = model;
  }
  return { retrievedAt: table.retrievedAt, source, models };
}

/** Parses a compact JSON file (bundled resource or disk cache), throwing on
 *  garbage so a corrupt cache file can never silently replace good data —
 *  callers are expected to catch and fall back. */
export function parseCompactJson(raw: string): PricingTable {
  // SAFETY: decodeCompact re-validates the parsed file; this cast only carries
  // us to the models-presence check that throws first.
  const file = JSON.parse(raw) as CompactFile;
  if (!file || !(file instanceof Object) || !file.models || !(file.models instanceof Object) || Array.isArray(file.models)) {
    throw new Error("compact pricing file missing a models object");
  }
  return decodeCompact(file);
}
