import { lstat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { detectKeychainItem, fraction, quotaRequestSignal, readKeychainPassword, sanitizeError } from "./security.js";
import type { KeychainOutcome } from "./security.js";
import { dollars, emptyReport, percent } from "./types.js";
import type { QuotaProviderReport, QuotaWindow } from "./types.js";

// Cursor's own dashboard usage endpoint — a Connect RPC service on
// wires two REST fallbacks (`cursor.com/api/usage`, `/api/usage-summary`) plus
// a Stripe balance read and a usage-events CSV export, but every one of those
// requires deriving a `WorkosCursorSessionToken` cookie from the access
// token's JWT `sub` claim (`<userId>::<token>`, URL-encoded) — a second,
// unrelated auth scheme layered on top of the Bearer token the Connect RPC
// already accepts directly. Those REST paths exist to cover Enterprise/Team
// accounts whose `planUsage` carries no usable limit, and to price a local
// per-day spend trend off exported token counts against a shared pricing
// table kone has no equivalent of. Porting that whole session-cookie +
// CSV-pricing stack is exactly the "half-ported RPC beats a working REST
// read" tradeoff in reverse: here the Connect RPC (`POST` + `Authorization:
// Bearer` + a `{}` body) is the SIMPLER of the two, so it is the only network
// path this module speaks. The REST fallbacks, the Stripe balance and the CSV
// spend trend are knowingly not implemented: Enterprise/Team accounts whose
// `planUsage` has no usable limit fall through to no windows rather than a
// half-built fallback, and the Today/Yesterday/Last-30-days spend tiles and
// trend sparkline stay empty rather than fabricated (see decodeCursorUsage's
// `spend`/`trend` fields below).
const DASHBOARD_BASE = "https://api2.cursor.sh/aiserver.v1.DashboardService";
const USAGE_URL = `${DASHBOARD_BASE}/GetCurrentPeriodUsage`;
const PLAN_URL = `${DASHBOARD_BASE}/GetPlanInfo`;
const CREDITS_URL = `${DASHBOARD_BASE}/GetCreditGrantsBalance`;
const REFRESH_URL = "https://api2.cursor.sh/oauth/token";
// `CursorUsageClient.clientID`, used only to refresh a token Cursor's own app
// already minted. kone never mints a Cursor session itself.
const CLIENT_ID = "KbZUR41cY7W6zRSdpSUJ7I7mLYBKOCmB";

const ACCESS_TOKEN_KEY = "cursorAuth/accessToken";
const REFRESH_TOKEN_KEY = "cursorAuth/refreshToken";
// The keychain services the Cursor app/CLI writes on macOS — the same names
// and the state.vscdb path below may not exist at all.
const KEYCHAIN_ACCESS_SERVICE = "cursor-access-token";
const KEYCHAIN_REFRESH_SERVICE = "cursor-refresh-token";

/** Cursor's app keeps its own session in a local sqlite key/value store, not
 *  a flat JSON credential file — so `readSecureFile` (built for a small,
 *  single-blob file with strict permission bits) doesn't fit here. This is
 *  the same store `CursorAdapter.ts` already reads for ACP session context
 *  (`node:sqlite`'s `DatabaseSync`, opened `readOnly`, imported lazily so this
 *  module still loads on a runtime without the builtin). The one hardening
 *  `readSecureFile` provides that's worth keeping by hand: refuse to follow a
 *  symlink before ever opening the path. */
function cursorStateDbPath(): string {
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  if (process.platform === "win32") {
    return path.join(os.homedir(), "AppData", "Roaming", "Cursor", "User", "globalStorage", "state.vscdb");
  }
  return path.join(os.homedir(), ".config", "Cursor", "User", "globalStorage", "state.vscdb");
}

async function readTokenFromStateDb(dbPath: string, key: string): Promise<string | null> {
  try {
    const stats = await lstat(dbPath);
    if (stats.isSymbolicLink()) return null;
  } catch {
    // No Cursor install, or it has never signed in — that's "not connected",
    // not an error worth surfacing.
    return null;
  }
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(dbPath, { readOnly: true });
    try {
      const row = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(key) as { value: unknown } | undefined;
      if (!row) return null;
      const raw = row.value;
      const text = typeof raw === "string" ? raw : raw instanceof Uint8Array ? Buffer.from(raw).toString("utf8") : null;
      const trimmed = text?.trim();
      return trimmed ? trimmed : null;
    } finally {
      db.close();
    }
  } catch {
    // A locked DB (Cursor mid-write), a schema Cursor has since changed, or a
    // runtime with no `node:sqlite` — all read the same as "couldn't read a
    // token right now", never as "definitely disconnected".
    return null;
  }
}

type CursorCredential = { accessToken: string | null; refreshToken: string | null };

export type CursorDeps = {
  fetch: typeof fetch;
  stateDbPath: string;
  readToken: (dbPath: string, key: string) => Promise<string | null>;
  readKeychain: (service: string) => Promise<KeychainOutcome>;
  now: () => number;
};

const defaults: CursorDeps = {
  fetch: globalThis.fetch,
  stateDbPath: cursorStateDbPath(),
  readToken: readTokenFromStateDb,
  readKeychain: (service) => readKeychainPassword(service),
  now: Date.now,
};

type DiscoverResult = { credential: CursorCredential | null; denied: boolean };

/** The session in whichever store Cursor actually keeps it: the sqlite
 *  state.vscdb the desktop app writes, or — since the Cursor CLI moved to the
 *  macOS Keychain — the `cursor-access-token` / `cursor-refresh-token` items.
 *  The sqlite store is the primary source (it is the credential Cursor's own
 *  app owns and refreshes); the keychain is only consulted on a user-initiated
 *  connect/refresh (`allowKeychain`), the one moment a first-read prompt is
 *  not a surprise. */
async function discoverCredential(deps: CursorDeps, allowKeychain: boolean): Promise<DiscoverResult> {
  const [accessToken, refreshToken] = await Promise.all([
    deps.readToken(deps.stateDbPath, ACCESS_TOKEN_KEY),
    deps.readToken(deps.stateDbPath, REFRESH_TOKEN_KEY),
  ]);
  if (accessToken || refreshToken) return { credential: { accessToken, refreshToken }, denied: false };
  if (!allowKeychain || process.platform !== "darwin") return { credential: null, denied: false };
  const [access, refresh] = await Promise.all([
    deps.readKeychain(KEYCHAIN_ACCESS_SERVICE),
    deps.readKeychain(KEYCHAIN_REFRESH_SERVICE),
  ]);
  const denied = access.status === "accessDenied" || refresh.status === "accessDenied";
  const value: CursorCredential = {
    accessToken: access.status === "found" ? access.value : null,
    refreshToken: refresh.status === "found" ? refresh.value : null,
  };
  return { credential: value.accessToken || value.refreshToken ? value : null, denied };
}

/** Answers "is there something here to connect to" for the Agents page's
 *  opt-in gate — presence only, no network call. The sqlite read never
 *  prompts; the keychain probe uses a short timeout so a first-time prompt
 *  (an item whose ACL doesn't yet trust `security`) dies in the background
 *  rather than holding the page open — and counts as "there is something",
 *  because a prompt only appears when the item exists. */
export async function detectCursorCredential(): Promise<boolean> {
  try {
    const discovered = await discoverCredential(defaults, false);
    if (discovered.credential) return true;
    return detectKeychainItem(KEYCHAIN_ACCESS_SERVICE);
  } catch {
    return false;
  }
}

function decodeJwtPayload(token: string): Record<string, unknown> | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const json = Buffer.from(segment.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    const parsed: unknown = JSON.parse(json);
    return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** ms epoch the access token's own `exp` claim names, or null when the token
 *  isn't a JWT (or carries no `exp`) — treated as "refresh before relying on
 *  it" rather than "never expires". */
function tokenExpiryMs(token: string): number | null {
  const exp = decodeJwtPayload(token)?.exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : null;
}

// Deliberately never written back to the sqlite store or Keychain: this
// module only ever reads Cursor's own credential, never rotates it on disk.
// That means a token refreshed here lives only for the one fetch that needed
// it — the next poll re-reads the (possibly still-stale) on-disk token and
// persist-the-rotation behaviour, but it keeps this module's write surface at
// zero, which is the stricter of the two tradeoffs.
async function refreshAccessToken(refreshToken: string, deps: CursorDeps, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await deps.fetch(REFRESH_URL, {
      method: "POST",
      signal: quotaRequestSignal(signal),
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ grant_type: "refresh_token", client_id: CLIENT_ID, refresh_token: refreshToken }),
    });
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    return typeof body.access_token === "string" && body.access_token.length > 0 ? body.access_token : null;
  } catch {
    return null;
  }
}

async function connectPost(url: string, accessToken: string, deps: CursorDeps, signal?: AbortSignal): Promise<Response> {
  return deps.fetch(url, {
    method: "POST",
    signal: quotaRequestSignal(signal),
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      "Connect-Protocol-Version": "1",
      "User-Agent": "kone/quota",
    },
    body: "{}",
  });
}

// `Number('')` is 0, not NaN — a blank string must be rejected explicitly or
// an absent field decodes as a confident zero rather than "unknown".
function num(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

function planLabelOf(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;
  return trimmed
    .split(/[\s_-]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1).toLowerCase())
    .join(" ");
}

async function fetchPlanName(accessToken: string, deps: CursorDeps, signal?: AbortSignal): Promise<string | null> {
  try {
    const response = await connectPost(PLAN_URL, accessToken, deps, signal);
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    const planInfo = body.planInfo && typeof body.planInfo === "object" ? (body.planInfo as Record<string, unknown>) : null;
    const name = typeof planInfo?.planName === "string" ? planInfo.planName.trim() : "";
    return name.length > 0 ? name : null;
  } catch {
    // Plan name is cosmetic (the "Max 20x"-style badge next to the provider
    // name) — never worth failing the whole report over.
    return null;
  }
}

type CreditGrants = { totalCents: number; usedCents: number };

async function fetchCreditGrants(accessToken: string, deps: CursorDeps, signal?: AbortSignal): Promise<CreditGrants | null> {
  try {
    const response = await connectPost(CREDITS_URL, accessToken, deps, signal);
    if (!response.ok) return null;
    const body = (await response.json()) as Record<string, unknown>;
    if (body.hasCreditGrants !== true) return null;
    const totalCents = num(body.totalCents);
    const usedCents = num(body.usedCents);
    if (totalCents === null || totalCents <= 0 || usedCents === null || usedCents < 0) return null;
    return { totalCents, usedCents };
  } catch {
    // Same story as the plan name: an optional enrichment of the primary
    // usage read, not a reason to report the provider as unreachable.
    return null;
  }
}

/** Decodes the `GetCurrentPeriodUsage` Connect RPC payload (plus the
 *  optionally-fetched plan name and credit-grant balance) into a report.
 *  Exported for tests — the window shape is worth locking down independent
 *  of the network. Field names below (`planUsage.totalPercentUsed`,
 *  `spendLimitUsage.individualLimit`, …) are ported straight from
export function decodeCursorUsage(body: unknown, planName: string | null, credits: CreditGrants | null): QuotaProviderReport {
  const data = body && typeof body === "object" ? (body as Record<string, unknown>) : {};
  // `enabled` is only "usage tracking is off for this account" when
  // `CursorPlanUsageFacts.isEnabled`.
  const enabled = data.enabled !== false;
  const planUsage = data.planUsage && typeof data.planUsage === "object" ? (data.planUsage as Record<string, unknown>) : null;
  const spendLimitUsage =
    data.spendLimitUsage && typeof data.spendLimitUsage === "object" ? (data.spendLimitUsage as Record<string, unknown>) : null;

  // by 1000 only because Swift's `Date` wants seconds) — `new Date(ms)` is
  // the direct read. Past 8.64e15 ms `toISOString()` throws, so that's
  // guarded the same way the Codex module guards its own epoch fields.
  const cycleEnd = num(data.billingCycleEnd);
  const resetsAt = cycleEnd !== null && cycleEnd > 0 && cycleEnd <= 8.64e15 ? new Date(cycleEnd).toISOString() : null;

  const windows: QuotaWindow[] = [];

  if (enabled && planUsage) {
    const limitCents = num(planUsage.limit);
    const spentCents = num(planUsage.totalSpend);
    const remainingCents = num(planUsage.remaining);
    // Cursor sometimes reports spend directly (`totalSpend`) and sometimes
    // only a limit/remaining pair — derive one from the other rather than
    // demanding a specific field be present.
    const usedCents = spentCents ?? (limitCents !== null && remainingCents !== null ? limitCents - remainingCents : null);
    const reportedPercent = num(planUsage.totalPercentUsed);
    const spendLimitType = typeof spendLimitUsage?.limitType === "string" ? spendLimitUsage.limitType.toLowerCase() : null;
    const pooledLimit = num(spendLimitUsage?.pooledLimit) ?? 0;
    const isTeamAccount = planName?.trim().toLowerCase() === "team" || spendLimitType === "team" || pooledLimit > 0;

    if (isTeamAccount && limitCents !== null && limitCents > 0 && usedCents !== null) {
      // Team/Enterprise plans meter the pool in dollars, not a published
      // percentage — Cursor's own totalSpend/limit are both authoritative
      // dollar figures here, so `estimated` stays false.
      windows.push({
        id: "totalUsage",
        label: "Total usage",
        used: dollars(usedCents / 100, false),
        limit: dollars(limitCents / 100, false),
        percent: Math.min(1, Math.max(0, usedCents / limitCents)),
        state: "active",
        resetsAt,
      });
    } else if (reportedPercent !== null) {
      // `totalPercentUsed` arrives as 0..100; the metric model stores the
      // 0..1 fraction and the UI prints the percent, so both the headline and
      // the bar derive from the same normalized figure.
      const frac = fraction(reportedPercent);
      windows.push({
        id: "totalUsage",
        label: "Total usage",
        used: percent(frac),
        limit: null,
        percent: frac,
        state: "active",
        resetsAt,
      });
    } else if (limitCents !== null && limitCents > 0 && usedCents !== null) {
      // No published percentage on this response shape — this figure is
      // kone's own division, not something Cursor stated, so it carries the
      // estimated flag even though every input to it is a real dollar amount.
      const derivedPercent = (usedCents / limitCents) * 100;
      const frac = fraction(derivedPercent);
      windows.push({
        id: "totalUsage",
        label: "Total usage",
        used: { ...percent(frac), estimated: true },
        limit: null,
        percent: frac,
        state: "active",
        resetsAt,
      });
    }

    const autoPercentUsed = num(planUsage.autoPercentUsed);
    if (autoPercentUsed !== null) {
      const frac = fraction(autoPercentUsed);
      windows.push({
        id: "autoUsage",
        label: "Auto usage",
        used: percent(frac),
        limit: null,
        percent: frac,
        state: "active",
        resetsAt,
      });
    }

    const apiPercentUsed = num(planUsage.apiPercentUsed);
    if (apiPercentUsed !== null) {
      const frac = fraction(apiPercentUsed);
      windows.push({
        id: "apiUsage",
        label: "API usage",
        used: percent(frac),
        limit: null,
        percent: frac,
        state: "active",
        resetsAt,
      });
    }
  }

  if (spendLimitUsage) {
    const limitCents = num(spendLimitUsage.individualLimit) ?? num(spendLimitUsage.pooledLimit);
    const remainingCents = num(spendLimitUsage.individualRemaining) ?? num(spendLimitUsage.pooledRemaining);
    const reportedUsedCents =
      [num(spendLimitUsage.individualUsed), num(spendLimitUsage.pooledUsed), num(spendLimitUsage.totalSpend)].find(
        (candidate): candidate is number => candidate !== null && candidate > 0,
      ) ?? null;
    const derivedUsedCents = limitCents !== null && remainingCents !== null ? Math.max(0, limitCents - remainingCents) : null;
    const usedCents = reportedUsedCents ?? derivedUsedCents;

    if (limitCents !== null && limitCents > 0 && usedCents !== null) {
      windows.push({
        id: "onDemand",
        label: "On-demand",
        used: dollars(usedCents / 100, false),
        limit: dollars(limitCents / 100, false),
        percent: Math.min(1, Math.max(0, usedCents / limitCents)),
        state: "active",
        resetsAt,
      });
    } else if (usedCents !== null && usedCents > 0) {
      // Spending with no published cap — an uncapped meter that only counts
      // up, so `limit`/`percent` stay null rather than drawing a bar with an
      // invented ceiling.
      windows.push({
        id: "onDemand",
        label: "On-demand",
        used: dollars(usedCents / 100, false),
        limit: null,
        percent: null,
        state: "active",
        resetsAt: null,
      });
    }
  }

  if (credits) {
    // `GetCreditGrantsBalance` names a total and a used figure directly —
    // both authoritative, so `estimated` is false on each. No expiry field
    // survives the aggregate (individual grants can expire on their own
    // schedules; the summed total doesn't say which), so `resetsAt` is null
    // rather than borrowing the billing-cycle date, which has nothing to do
    // with when a credit grant lapses.
    windows.push({
      id: "credits",
      label: "Credits",
      used: dollars(credits.usedCents / 100, false),
      limit: dollars(credits.totalCents / 100, false),
      percent: Math.min(1, Math.max(0, credits.usedCents / credits.totalCents)),
      state: "active",
      resetsAt: null,
    });
  }

  const primary = windows.find((window) => window.id === "totalUsage") ?? windows[0] ?? null;

  return {
    provider: "cursor",
    connection: "connected",
    primary,
    windows,
    // Today/Yesterday/Last-30-days spend and the trend sparkline both come,
    // local model-pricing table kone has no port of. Rather than fabricate
    // either from data this module doesn't have, both stay empty — the UI
    // renders that as "No data" for the tiles, which is the honest read.
    spend: [],
    trend: [],
    planLabel: planLabelOf(planName),
    excludedModels: [],
    fetchedAt: Date.now(),
  };
}

function parseRetryAfterSeconds(response: Response, now: number): number {
  const raw = response.headers.get("Retry-After");
  let seconds = raw === null ? NaN : Number(raw);
  if (!Number.isFinite(seconds) && raw) seconds = (Date.parse(raw) - now) / 1000;
  return Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60);
}

export type CursorQuotaResult = { report: QuotaProviderReport; retryAfterSeconds?: number };

/** JWT `sub` from Cursor's saved access token — used to build the
 *  `WorkosCursorSessionToken` cookie for cursor.com REST/CSV endpoints. */
function tokenSubject(accessToken: string): string | null {
  const sub = decodeJwtPayload(accessToken)?.sub;
  return typeof sub === "string" && sub.trim().length > 0 ? sub.trim() : null;
}

/** `userId%3A%3A<token>` cookie value for cursor.com dashboard REST/CSV. */
export function buildCursorSessionCookie(accessToken: string): string | null {
  const subject = tokenSubject(accessToken);
  if (!subject) return null;
  const parts = subject.split("|");
  const userId = parts.length > 1 ? parts[1] : parts[0];
  if (!userId) return null;
  return `${userId}%3A%3A${accessToken}`;
}

/** Reads (and refreshes when near expiry) the access token Cursor's app wrote
 *  to its local sqlite store. Shared by quota polling and usage CSV export;
 *  `allowKeychain` defaults off because the CSV scan runs on page load, where
 *  a first-read keychain prompt would be a surprise. */
export async function resolveCursorAccessToken(
  options: Partial<CursorDeps> & { signal?: AbortSignal; allowKeychain?: boolean } = {},
): Promise<string | null> {
  const deps = { ...defaults, ...options };
  const discovered = await discoverCredential(deps, options.allowKeychain ?? false);
  const credential = discovered.credential;
  if (!credential) return null;

  let accessToken = credential.accessToken;
  const refreshToken = credential.refreshToken;

  if (accessToken) {
    const expiresAt = tokenExpiryMs(accessToken);
    if (expiresAt !== null && expiresAt - deps.now() <= 5 * 60_000 && refreshToken) {
      const refreshed = await refreshAccessToken(refreshToken, deps, options.signal);
      if (refreshed) accessToken = refreshed;
    }
  } else if (refreshToken) {
    accessToken = await refreshAccessToken(refreshToken, deps, options.signal);
  }

  return accessToken ?? null;
}

/** Fetches Cursor's own usage report for whichever token its own app last
 *  wrote to the local sqlite session store (or the keychain, on a user-
 *  initiated connect — see discoverCredential). Never throws — every path
 *  resolves to a report; the caller (index.ts) layers the cache/backoff on
 *  top of this, same as fetchClaudeQuota / fetchCodexQuota. */
export async function fetchCursorQuota(
  options: Partial<CursorDeps> & { signal?: AbortSignal; allowKeychain?: boolean } = {},
): Promise<CursorQuotaResult> {
  const deps = { ...defaults, ...options };
  try {
    const discovered = await discoverCredential(deps, options.allowKeychain ?? false);
    if (discovered.denied) {
      return { report: emptyReport("cursor", "accessDenied", "macOS Keychain access was denied for Cursor's saved login.") };
    }
    const credential = discovered.credential;
    if (!credential) {
      return { report: emptyReport("cursor", "disconnected", "Not connected — sign in to the Cursor app first.") };
    }

    let accessToken = credential.accessToken;
    const refreshToken = credential.refreshToken;

    if (accessToken) {
      const expiresAt = tokenExpiryMs(accessToken);
      if (expiresAt !== null && expiresAt - deps.now() <= 5 * 60_000 && refreshToken) {
        const refreshed = await refreshAccessToken(refreshToken, deps, options.signal);
        if (refreshed) accessToken = refreshed;
      }
    } else if (refreshToken) {
      accessToken = await refreshAccessToken(refreshToken, deps, options.signal);
    }

    if (!accessToken) {
      return { report: emptyReport("cursor", "transientFailure", "Cursor's saved login could not be refreshed.") };
    }

    let usageResponse = await connectPost(USAGE_URL, accessToken, deps, options.signal);
    if ((usageResponse.status === 401 || usageResponse.status === 403) && refreshToken) {
      const refreshed = await refreshAccessToken(refreshToken, deps, options.signal);
      if (refreshed) {
        accessToken = refreshed;
        usageResponse = await connectPost(USAGE_URL, accessToken, deps, options.signal);
      }
    }
    if (usageResponse.status === 429) {
      return {
        report: {
          ...emptyReport("cursor", "transientFailure", "Cursor's usage endpoint is rate-limiting us — backing off."),
          rateLimited: true,
        },
        retryAfterSeconds: parseRetryAfterSeconds(usageResponse, deps.now()),
      };
    }
    if (usageResponse.status === 401 || usageResponse.status === 403) {
      return { report: emptyReport("cursor", "terminalFailure", "Cursor rejected the saved login.") };
    }
    if (!usageResponse.ok) {
      return {
        report: emptyReport(
          "cursor",
          usageResponse.status >= 400 && usageResponse.status < 500 ? "terminalFailure" : "transientFailure",
          `Cursor's usage endpoint returned ${usageResponse.status}.`,
        ),
      };
    }

    const usageBody: unknown = await usageResponse.json();
    // Plan name and credit-grant balance are optional enrichments — a
    // rejected or errored fetch for either degrades to null rather than
    // `fetchOptionalJSONObject` boundary.
    const [planName, credits] = await Promise.all([
      fetchPlanName(accessToken, deps, options.signal),
      fetchCreditGrants(accessToken, deps, options.signal),
    ]);
    return { report: decodeCursorUsage(usageBody, planName, credits) };
  } catch (error) {
    // Deliberately sanitized before the only diagnostic sink — no token ever
    // reaches a log line or a returned report.
    console.warn(`Cursor quota unavailable: ${sanitizeError(error)}`);
    return { report: emptyReport("cursor", "transientFailure", "Could not reach Cursor's usage endpoint.") };
  }
}
