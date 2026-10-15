import type { QuotaCapableProvider } from "~/types/desktop";

// Capability metadata: what kone can *do* with each provider, independent of
// whether kone currently offers it. Offer policy is a separate fact, kept in
// providerOffer.ts, and every user-facing set is the offered list filtered by
// these capabilities — never a capability list restated as an offer. Keeping
// the two apart is what stops "take a provider off offer" from leaving its
// probe, meter or mark silently wired in: the offered views are derived, so a
// provider that drops out of OFFERED_PROVIDERS drops out of all of them.

/** Every provider whose own usage kone knows how to read. The quota bridge
 *  accepts exactly these, so the narrowing lives in the type — and the set is
 *  deliberately wider than the offered list, because a provider kone has taken
 *  off offer still keeps its adapter and read path. */
export const QUOTA_CAPABLE_PROVIDERS = [
  "opencode",
  "claudeAgent",
  "codex",
  "cursor",
  "antigravity",
  "droid",
] as const satisfies readonly QuotaCapableProvider[];

/** Quota-capable providers that need no opt-in: the question the consent
 *  toggle asks — "may kone spend your stored credential on a call?" — does not
 *  apply. OpenCode touches no credential and makes no network call; it reads a
 *  local cost file. Antigravity's "credential" is the language server the
 *  app/CLI already runs and its read is loopback-only. */
export const NO_CONSENT_QUOTA_PROVIDERS = [
  "opencode",
  "antigravity",
] as const satisfies readonly QuotaCapableProvider[];

const QUOTA_CAPABLE_SET: ReadonlySet<string> = new Set(QUOTA_CAPABLE_PROVIDERS);
const NO_CONSENT_SET: ReadonlySet<string> = new Set(NO_CONSENT_QUOTA_PROVIDERS);

/** Whether kone can read a usage/quota figure from this provider. Takes a bare
 *  string so a value read off the wire can be tested without an assertion, and
 *  narrows to the quota-capable union a caller can rely on. */
export function isQuotaCapable(provider: string): provider is QuotaCapableProvider {
  return QUOTA_CAPABLE_SET.has(provider);
}

/** Whether a quota-capable provider can be read without an opt-in. */
export function isConsentFreeQuotaProvider(provider: QuotaCapableProvider): boolean {
  return NO_CONSENT_SET.has(provider);
}
