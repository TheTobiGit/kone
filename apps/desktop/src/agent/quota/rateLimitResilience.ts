// "Keep last-good + back off" for live usage fetchers. When a provider's usage
// endpoint throttles (HTTP 429), blanking the pane is worse than showing
// slightly stale numbers — so each provider's last clean report is remembered
// and kept on screen (flagged `rateLimited`) for the duration of a cooldown
// that honours Retry-After, while live calls are skipped so kone doesn't pile
// on more 429s. The cooldown is clamped: a Retry-After that names hours (or a
// broken server that sends a nonsense value) must not freeze the meters on
// stale data, and a sub-60s value must not let the next poll hammer the
// endpoint again immediately.

import { emptyReport } from "./types.js";
import type { QuotaCapableProvider, QuotaProviderReport } from "./types.js";

/** Fallback cooldown when a 429 carries no usable Retry-After. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS = 300;
/** Upper bound so a huge/hostile Retry-After can't serve stale numbers for hours. */
export const MAX_RATE_LIMIT_COOLDOWN_SECONDS = 900;
/** Lower bound so the very next poll can't immediately re-trigger a throttle. */
export const MIN_RATE_LIMIT_COOLDOWN_SECONDS = 60;

interface ResilienceEntry {
  lastGood: QuotaProviderReport | null;
  cooldownUntilMs: number;
}

export interface RateLimitResilience {
  /** The report to serve while `provider` is cooling down, or null when no
   *  cooldown is active for it. */
  serveDuringCooldown(provider: QuotaCapableProvider, nowMs: number): QuotaProviderReport | null;
  /** Record a clean fetch and clear any cooldown for `provider`. */
  rememberLastGood(provider: QuotaCapableProvider, report: QuotaProviderReport): void;
  /** Begin a cooldown for `provider` honouring Retry-After (clamped), then
   *  return the report to serve — the last clean snapshot flagged stale, or an
   *  error snapshot when there is none yet. */
  enterCooldown(
    provider: QuotaCapableProvider,
    retryAfterSeconds: number,
    nowMs: number,
  ): QuotaProviderReport;
  /** Drop any remembered snapshot and cooldown — used when the account or
   *  credential changed (user disconnected, provider rejected the account), so
   *  a stale meter can't be re-served for a provider that is no longer there. */
  forget(provider: QuotaCapableProvider): void;
  /** Test-only: drop all remembered state. */
  reset(): void;
}

export function createRateLimitResilience(options: {
  defaultCooldownSeconds?: number;
  maxCooldownSeconds?: number;
} = {}): RateLimitResilience {
  const defaultCooldownSeconds =
    options.defaultCooldownSeconds ?? DEFAULT_RATE_LIMIT_COOLDOWN_SECONDS;
  const maxCooldownSeconds = options.maxCooldownSeconds ?? MAX_RATE_LIMIT_COOLDOWN_SECONDS;

  const store = new Map<QuotaCapableProvider, ResilienceEntry>();

  const entryFor = (provider: QuotaCapableProvider): ResilienceEntry => {
    let entry = store.get(provider);
    if (!entry) {
      entry = { lastGood: null, cooldownUntilMs: 0 };
      store.set(provider, entry);
    }
    return entry;
  };

  const cooldownMessage = (entry: ResilienceEntry, nowMs: number): string => {
    const mins = Math.max(1, Math.ceil((entry.cooldownUntilMs - nowMs) / 60_000));
    return `Backing off after a rate limit — retrying in ~${mins} min.`;
  };

  // The last clean fetch with a staleness note when we have one, otherwise an
  // error snapshot that at least explains the throttle. The note rides on the
  // last-good report's `connection: "connected"` so the UI keeps rendering the
  // meters instead of collapsing the card to an error row; `rateLimited: true`
  // (with the original `fetchedAt`) is what lets a consumer tell a re-served
  // snapshot from a fresh read.
  const snapshotForCooldown = (
    provider: QuotaCapableProvider,
    entry: ResilienceEntry,
    nowMs: number,
  ): QuotaProviderReport => {
    const lastGood = entry.lastGood;
    if (lastGood) {
      return { ...lastGood, rateLimited: true, message: cooldownMessage(entry, nowMs) };
    }
    const report = emptyReport(provider, "transientFailure", cooldownMessage(entry, nowMs));
    report.rateLimited = true;
    return report;
  };

  return {
    serveDuringCooldown(provider, nowMs) {
      const entry = store.get(provider);
      if (!entry || nowMs >= entry.cooldownUntilMs) return null;
      return snapshotForCooldown(provider, entry, nowMs);
    },
    rememberLastGood(provider, report) {
      const entry = entryFor(provider);
      entry.lastGood = report;
      entry.cooldownUntilMs = 0;
    },
    enterCooldown(provider, retryAfterSeconds, nowMs) {
      const entry = entryFor(provider);
      const seconds = Number.isFinite(retryAfterSeconds)
        ? retryAfterSeconds
        : defaultCooldownSeconds;
      const clamped = Math.min(
        Math.max(seconds, MIN_RATE_LIMIT_COOLDOWN_SECONDS),
        maxCooldownSeconds,
      );
      entry.cooldownUntilMs = nowMs + clamped * 1000;
      return snapshotForCooldown(provider, entry, nowMs);
    },
    forget(provider) {
      store.delete(provider);
    },
    reset() {
      store.clear();
    },
  };
}
