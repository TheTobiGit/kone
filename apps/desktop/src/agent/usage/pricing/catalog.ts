// Real provider log/CLI model ids rarely match a catalog key exactly — a
// gateway prefixes them (`opencode-go/deepseek-v4-flash`), a turn parameter
// gets appended (`claude-opus-5[thinking=true]`), or the id is simply dated
// where the catalog key isn't (`claude-sonnet-4-5-20250929` vs
// `claude-sonnet-4-5`) — so exact lookup is tried first and a boundary-aware
// fuzzy match is the fallback, never the primary path.

import type { ModelRates, PricingTable } from "./types.js";

export interface CatalogMatch {
  key: string;
  rates: ModelRates;
}

/** Exact lookup only. Used for the highest-confidence path in the resolver
 *  before any fuzzy matching is attempted. */
export function findExact(table: PricingTable, model: string): CatalogMatch | undefined {
  const rates = table.entries[model];
  return rates ? { key: model, rates } : undefined;
}

/** Fuzzy lookup over every entry in the table. Prefers the longest matching
 *  key (a more specific model name beats a shorter prefix of it), then the
 *  lexicographically smallest for determinism when two keys tie in length.
 *  Only call this after `findExact` has already missed — it's O(n) in the
 *  table size and only worth paying when nothing matched directly. */
export function findFuzzy(table: PricingTable, model: string): CatalogMatch | undefined {
  const normalizedModel = normalizeSeparators(model);
  let best: CatalogMatch | undefined;
  for (const [key, rates] of Object.entries(table.entries)) {
    if (!keyMatches(key, model, normalizedModel)) continue;
    if (!best || key.length > best.key.length || (key.length === best.key.length && key < best.key)) {
      best = { key, rates };
    }
  }
  return best;
}

/** Merge `other` on top of `base` — `other`'s entries win per key. Used to
 *  layer a freshly fetched table over the bundled snapshot: entries the live
 *  feed still carries get the newer numbers, entries it dropped keep the
 *  bundled ones rather than vanishing. */
export function mergeTables(base: PricingTable, other: PricingTable): PricingTable {
  return { entries: { ...base.entries, ...other.entries }, retrievedAt: other.retrievedAt ?? base.retrievedAt };
}

/** Normalizes separator variants so `grok-4.3` and `grok-4-3` compare equal:
 *  LiteLLM, models.dev, and provider CLIs are inconsistent about whether a
 *  version number uses `.`, `@`, or `-`. */
function normalizeSeparators(value: string): string {
  if (!value.includes(".") && !value.includes("@")) return value;
  return value.replace(/[.@]/g, "-");
}

/** A candidate catalog key matches a model id when either string contains
 *  the other at word boundaries, on the raw or separator-normalized forms —
 *  covers a catalog key with a provider prefix the model id lacks
 *  (`xai/grok-4.3` catalog key vs `grok-4.3` model id) and the reverse (a
 *  gateway-prefixed model id vs a bare catalog key). */
function keyMatches(candidate: string, model: string, normalizedModel: string): boolean {
  if (containsKeyAtBoundary(model, candidate) || containsKeyAtBoundary(candidate, model)) return true;
  const normalizedCandidate = normalizeSeparators(candidate);
  return (
    containsKeyAtBoundary(normalizedModel, normalizedCandidate) ||
    containsKeyAtBoundary(normalizedCandidate, normalizedModel)
  );
}

const isAlphanumeric = (ch: string): boolean => /[a-zA-Z0-9]/.test(ch);
const isDigit = (ch: string): boolean => ch >= "0" && ch <= "9";

/** Finds `key` inside `value` only where the surrounding characters are
 *  non-alphanumeric boundaries (or string edges), so `sonnet-4` never
 *  matches inside `claude-sonnet-40` — a bare substring test would treat
 *  those as the same model. */
function containsKeyAtBoundary(value: string, key: string): boolean {
  if (!key) return false;
  if (key.length > value.length) return false;
  for (let start = 0; start <= value.length - key.length; start++) {
    if (value.slice(start, start + key.length) !== key) continue;
    const before = value[start - 1];
    if (before !== undefined && isAlphanumeric(before)) continue;
    const suffix = value.slice(start + key.length);
    if (suffixAllowsMatch(key, suffix)) return true;
  }
  return false;
}

/** A boundary right after the key is fine on its own (end of string). A
 *  separator followed by more alphanumerics is fine too *unless* it reads as
 *  a continuation of a numeric version on the key (`claude-sonnet-4` must
 *  not match inside `claude-sonnet-4-5`) — except an 8-digit date suffix,
 *  which is a real Anthropic id pattern (`claude-sonnet-4` + `-20250514`)
 *  and should still match. */
function suffixAllowsMatch(key: string, suffix: string): boolean {
  const separator = suffix[0];
  if (separator === undefined) return true;
  if (isAlphanumeric(separator)) return false;
  return !suffixStartsWithNumericModelVersion(key, suffix);
}

function suffixStartsWithNumericModelVersion(key: string, suffix: string): boolean {
  const dateSuffixDigits = 8;
  const lastKeyChar = key[key.length - 1];
  if (lastKeyChar === undefined || !isDigit(lastKeyChar)) return false;
  const separator = suffix[0];
  if (separator !== "-" && separator !== ".") return false;
  const rest = suffix.slice(1);
  let digitCount = 0;
  while (digitCount < rest.length && isDigit(rest[digitCount] ?? "")) digitCount++;
  if (digitCount === 0) return false;
  const afterDigits = rest[digitCount];
  const isDateSuffix = digitCount === dateSuffixDigits && (afterDigits === undefined || !isAlphanumeric(afterDigits));
  return !isDateSuffix;
}
