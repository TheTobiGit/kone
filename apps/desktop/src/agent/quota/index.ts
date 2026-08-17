import { detectAntigravityCredential, fetchAntigravityQuota } from "./antigravity.js";
import { detectClaudeCredential, fetchClaudeQuota } from "./claude.js";
import { fetchCodexQuota } from "./codex.js";
import { fetchCursorQuota, detectCursorCredential } from "./cursor.js";
import { detectDroidCredential, fetchDroidQuota } from "./droid.js";
import { fetchOpenCodeQuota, detectOpenCodeDatabase } from "./opencode.js";
import { createRateLimitResilience } from "./rateLimitResilience.js";
import { readSecureFile, sanitizeError } from "./security.js";
import { emptyReport } from "./types.js";
import type { QuotaCapableProvider, QuotaProviderReport } from "./types.js";

// The Agents-page quota surface: report how much of a provider's own
// subscription is left, entirely opt-in per provider (nothing here is read or
// fetched until the caller asks for that specific provider). Layers a 60s
// in-memory cache and an honest 429 backoff on top of the per-provider modules.
//
// "Read the provider's own numbers" means different things per provider, and
// this registry is deliberately indifferent to which:
//   claudeAgent, codex, cursor  → an OAuth token their CLI stored locally,
//                                 spent against that provider's usage endpoint.
//   opencode                    → no network at all; OpenCode writes its own
//                                 authoritative per-message cost to a local
//                                 SQLite database, so the "credential" is just
//                                 the presence of that file.
//   antigravity                 → no stored credential at all: the language
//                                 server the Antigravity app / `agy` already
//                                 runs on loopback answers the quota RPC, so
//                                 the "credential" is the process itself.
//   droid                       → the Factory API key the user already holds
//                                 (FACTORY_API_KEY or ~/.factory/.env), spent
//                                 against Factory's billing/usage endpoints.
//                                 Droid's own device-pairing login files are
//                                 encrypted and
//                                 never opened.

export type {
  QuotaConnection,
  QuotaProviderReport,
  QuotaWindow,
  QuotaCapableProvider,
  MetricValue,
  MetricKind,
  SpendTile,
  TrendPoint,
} from "./types.js";

const CACHE_TTL_MS = 60_000;

const CODEX_AUTH_PATH = `${process.env.HOME ?? ""}/.codex/auth.json`;
const CODEX_OPENAI_AUTH_PATH = `${process.env.HOME ?? ""}/Library/Application Support/com.openai.codex/auth.json`;

type CacheEntry = { at: number; report: QuotaProviderReport };
const cache = new Map<QuotaCapableProvider, CacheEntry>();

/** In-flight fetches, keyed by provider — a second request for a provider whose
 *  read is already running joins that one promise instead of opening a second
 *  because the startup warm and the pane's own open can ask for the same
 *  provider within the same tick. */
const inFlight = new Map<QuotaCapableProvider, Promise<QuotaProviderReport>>();

const resilience = createRateLimitResilience();

/** The provider kinds the Agents page can show a quota card for, in the order
 *  they appear. OpenCode leads because it is the only one that needs neither a
 *  network call nor a consent prompt to be useful. */
export function quotaCapableProviders(): QuotaCapableProvider[] {
  return ["opencode", "claudeAgent", "codex", "cursor", "antigravity", "droid"];
}

/** Drop the in-memory quota cache, any in-flight read, and all remembered
 *  rate-limit state. Tests use this so one case cannot leak into the next. */
export function resetQuotaStateForTests(): void {
  cache.clear();
  inFlight.clear();
  resilience.reset();
}

/** Answers "is there something here to connect to" — no parsing beyond
 *  presence, and never a network call. Used both to gate the opt-in "Connect"
 *  affordance and, on failure, to fall back to a `disconnected` report without
 *  paying for a doomed fetch. File checks are always safe; the keychain
 *  presence probes (Claude Code and the Cursor CLI both keep their login
 *  there these days) run under a short timeout so a first-read prompt can
 *  never hold the page open. */
export async function detectProviderCredential(provider: QuotaCapableProvider): Promise<boolean> {
  try {
    if (provider === "opencode") return await detectOpenCodeDatabase();
    if (provider === "cursor") return await detectCursorCredential();
    if (provider === "claudeAgent") return await detectClaudeCredential();
    if (provider === "antigravity") return await detectAntigravityCredential();
    if (provider === "droid") return await detectDroidCredential();
    if ((await readSecureFile(CODEX_AUTH_PATH, 64 * 1024)) !== null) return true;
    return (await readSecureFile(CODEX_OPENAI_AUTH_PATH, 64 * 1024).catch(() => null)) !== null;
  } catch (error) {
    // A permissions/symlink refusal reads the same as "nothing to connect to"
    // here — fetchProviderQuota is what surfaces the real accessDenied.
    console.warn(`Quota credential detection failed: ${sanitizeError(error)}`);
    return false;
  }
}

/** Fetches one provider's usage report, opt-in and on demand. Honors a 60s
 *  cache and a 429 backoff window; every path resolves to a report — this
 *  never throws out to the caller. `allowKeychain` should only be set true on
 *  a user-initiated connect/refresh (a background poll must not risk a
 *  surprise macOS Keychain prompt). */
export async function fetchProviderQuota(
  provider: QuotaCapableProvider,
  opts: { allowKeychain?: boolean; signal?: AbortSignal; force?: boolean } = {},
): Promise<QuotaProviderReport> {
  const cached = cache.get(provider);
  if (!opts.force && cached && Date.now() - cached.at < CACHE_TTL_MS) return cached.report;

  const backoff = resilience.serveDuringCooldown(provider, Date.now());
  if (backoff) return backoff;

  // Coalesce with any read already in flight for this provider — a concurrent
  // caller gets the same fresh result rather than opening a second call. A
  // `force` refresh still joins an in-flight read (it is already fresh); it only
  // bypasses the TTL cache above.
  const pending = inFlight.get(provider);
  if (pending) return pending;

  const run = runProviderQuota(provider, opts).finally(() => inFlight.delete(provider));
  inFlight.set(provider, run);
  return run;
}

async function runProviderQuota(
  provider: QuotaCapableProvider,
  opts: { allowKeychain?: boolean; signal?: AbortSignal; force?: boolean },
): Promise<QuotaProviderReport> {
  try {
    const result = await fetchFor(provider, opts);

    if (result.retryAfterSeconds !== undefined) {
      // A 429: begin the cooldown and serve the last clean snapshot (flagged
      // stale) instead of blanking the meters. The freshness cache is cleared so
      // a later force refresh re-fetches once the cooldown lapses; the
      // resilience layer holds the remembered numbers separately.
      cache.delete(provider);
      return resilience.enterCooldown(provider, result.retryAfterSeconds, Date.now());
    }

    // Only a live read earns a minute in the cache. A `disconnected` report is
    // the cheap answer "nothing to read here" — caching it would keep the
    // "run claude login" instruction on screen for up to a minute after the
    // user actually signed in (or clicked Refresh), which reads as kone
    // asking them to re-authenticate for no reason.
    if (result.report.connection === "connected") {
      cache.set(provider, { at: Date.now(), report: result.report });
      resilience.rememberLastGood(provider, result.report);
      return result.report;
    }

    cache.delete(provider);
    if (
      result.report.connection === "disconnected" ||
      result.report.connection === "terminalFailure"
    ) {
      // The account or credential changed — drop the remembered snapshot so a
      // later backoff can't serve numbers for a provider that is gone.
      resilience.forget(provider);
      return result.report;
    }

    if (result.report.connection === "transientFailure") {
      // Not a formatted 429, but also not "the provider is gone" — a timeout,
      // a 5xx, or a token-refresh problem. Serve the last clean snapshot
      // (flagged stale) when there is one, so a brief network blip can't blank
      // the whole card to an error row.
      const stale = resilience.serveOnFailure(
        provider,
        Date.now(),
        result.report.message ?? "Could not refresh this provider's usage.",
      );
      if (stale) return stale;
    }
    return result.report;
  } catch (error) {
    // Every provider module already catches internally and never throws — this
    // is a last-resort guard so a defect there still can't escape
    // fetchProviderQuota's "always resolves to a report" contract.
    console.warn(`Provider quota unavailable: ${sanitizeError(error)}`);
    cache.delete(provider);
    const stale = resilience.serveOnFailure(
      provider,
      Date.now(),
      "Something went wrong reading this provider's usage.",
    );
    if (stale) return stale;
    const report = emptyReport(
      provider,
      "transientFailure",
      "Something went wrong reading this provider's usage.",
    );
    return report;
  }
}

type FetchResult = { report: QuotaProviderReport; retryAfterSeconds?: number };

/** The one place that knows which module answers for which provider. Kept
 *  separate from the caching/backoff shell above so adding a fifth provider is
 *  a single new case rather than another branch inside the retry logic. */
function fetchFor(
  provider: QuotaCapableProvider,
  opts: { allowKeychain?: boolean; signal?: AbortSignal },
): Promise<FetchResult> {
  switch (provider) {
    case "claudeAgent":
      return fetchClaudeQuota({ allowKeychain: opts.allowKeychain, signal: opts.signal });
    case "codex":
      return fetchCodexQuota({ signal: opts.signal });
    case "cursor":
      return fetchCursorQuota({ allowKeychain: opts.allowKeychain, signal: opts.signal });
    case "opencode":
      return fetchOpenCodeQuota({ signal: opts.signal });
    case "antigravity":
      return fetchAntigravityQuota({ signal: opts.signal });
    case "droid":
      return fetchDroidQuota({ signal: opts.signal });
  }
}
