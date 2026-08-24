import os from "node:os";
import path from "node:path";

import { fraction, detectKeychainItem, quotaRequestSignal, readKeychainPassword, readSecureFile, sanitizeError } from "./security.js";
import type { KeychainOutcome } from "./security.js";
import { emptyReport, percent as percentValue } from "./types.js";
import type { QuotaProviderReport, QuotaWindow, QuotaWindowState } from "./types.js";

// Claude's own OAuth usage endpoint — the same one Claude Code's CLI reads to
// print its own /usage output. kone never talks to this until the user opts
// the Claude provider into the Agents quota page; the credential is Claude
// Code's own `.credentials.json`, never anything kone minted.

const ENDPOINT = "https://api.anthropic.com/api/oauth/usage";
const KEYCHAIN_SERVICE = "Claude Code-credentials";

type ClaudeApiValue = string | number | boolean | null | ClaudeApiValue[] | { [key: string]: ClaudeApiValue };

type ClaudeApiRecord = { [key: string]: ClaudeApiValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isApiNumber(value: ClaudeApiValue | undefined): value is number {
  return Number.isFinite(value);
}

function isApiRecord(value: ClaudeApiValue | undefined): value is ClaudeApiRecord {
  return value instanceof Object && !Array.isArray(value);
}

function apiRecord(value: ClaudeApiValue | undefined): ClaudeApiRecord | undefined {
  return isApiRecord(value) ? value : undefined;
}

function apiArray(value: ClaudeApiValue | undefined): ClaudeApiValue[] {
  return Array.isArray(value) ? value : [];
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  identity — booleans by value, numbers by finiteness, composites by their
 *  constructors. */
function apiText(value: ClaudeApiValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isApiNumber(value)) return null;
  return value;
}

function readNumber(value: ClaudeApiValue | undefined): number | null {
  return isApiNumber(value) ? value : null;
}

/** A timestamp the server may send in any textual form, kept only when it
 *  parses; normalized to ISO so downstream comparisons see one shape. */
function isoResetTime(value: ClaudeApiValue | undefined): string | null {
  const text = apiText(value);
  return text !== null && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
}

type ClaudeCredential = { accessToken: string; expiresAt?: number; rateLimitTier?: string };

export type ClaudeDeps = {
  fetch: typeof fetch;
  credentialPath: string;
  readFile: typeof readSecureFile;
  now: () => number;
  keychain?: () => Promise<KeychainOutcome>;
};

const defaults: ClaudeDeps = {
  fetch: globalThis.fetch,
  credentialPath: path.join(os.homedir(), ".claude", ".credentials.json"),
  readFile: readSecureFile,
  now: Date.now,
};

function parseCredential(raw: string): ClaudeCredential | null {
  // Claude Code's own credential file is sometimes line-wrapped pretty-printed
  // JSON with stray indentation — strip that before parsing rather than
  // trusting it's always compact.
  const clean = raw.replace(/\r/g, "").replace(/\n[ \t]*/g, "");
  // SAFETY: the credential file's bytes are arbitrary JSON; every field below
  // is revalidated through the decoders before use.
  const root = apiRecord(apiRecord(JSON.parse(clean) as ClaudeApiValue)?.claudeAiOauth);
  if (!root) return null;
  const accessToken = apiText(root.accessToken);
  if (accessToken === null || accessToken.length === 0) return null;
  return {
    accessToken,
    expiresAt: isApiNumber(root.expiresAt) ? root.expiresAt : undefined,
    rateLimitTier: apiText(root.rateLimitTier) ?? undefined,
  };
}

async function credentialFromFile(deps: ClaudeDeps): Promise<ClaudeCredential | null> {
  const raw = await deps.readFile(deps.credentialPath, 64 * 1024);
  return raw ? parseCredential(raw) : null;
}

/** The credential in whichever of Claude Code's two stores it actually lives
 *  in today: the classic `.credentials.json` file, or — since 2.1.x, which
 *  keeps the OAuth login in the macOS Keychain — the keychain item. The file
 *  wins when both exist; the keychain is only consulted on a user-initiated
 *  connect/refresh (`allowKeychain`), the one moment a first-read prompt is
 *  not a surprise. */
async function resolveCredential(
  deps: ClaudeDeps,
  allowKeychain: boolean,
): Promise<{ credential: ClaudeCredential | null; denied: boolean }> {
  const fromFile = await credentialFromFile(deps);
  if (fromFile) return { credential: fromFile, denied: false };
  if (!allowKeychain || process.platform !== "darwin") return { credential: null, denied: false };
  const outcome = await (deps.keychain ?? readClaudeKeychain)();
  if (outcome.status === "accessDenied") return { credential: null, denied: true };
  return { credential: outcome.status === "found" ? parseCredential(outcome.value) : null, denied: false };
}

/** Claude Code has written its keychain item under both `$USER` (2.1.x) and
 *  the older hardcoded "agentseal" account; a user-scoped miss must fall
 *  through to the service-only lookup rather than reporting disconnected. */
function claudeKeychainAccounts(): (string | null)[] {
  const user = process.env.USER;
  return user ? [user, null] : [null];
}

export async function readClaudeKeychain(): Promise<KeychainOutcome> {
  return readKeychainPassword(KEYCHAIN_SERVICE, claudeKeychainAccounts());
}

/** The Limits card's presence check. Modern Claude Code (2.1.x) keeps the
 *  OAuth login in the macOS Keychain rather than `.credentials.json`, so a
 *  file miss must fall through to a keychain probe before the card may say
 *  "no local sign-in found". Never throws — every miss reads as "not
 *  connected", the same way the file path always has. */
export async function detectClaudeCredential(): Promise<boolean> {
  try {
    if ((await credentialFromFile(defaults)) !== null) return true;
    return detectKeychainItem(KEYCHAIN_SERVICE, claudeKeychainAccounts());
  } catch {
    return false;
  }
}

// Claude only ever publishes a percentage-of-window figure, never a raw
// used/limit count — so `used` is always derived from the same fraction as
// `percent`, and `limit` stays null (there's nothing in the provider's own
// unit to put there).
function windowState(frac: number, resetsAt: string | null): QuotaWindowState {
  return frac === 0 && resetsAt === null ? "notStarted" : "active";
}

function windowOf(id: string, label: string, value: ClaudeApiValue | undefined): QuotaWindow | null {
  const row = apiRecord(value);
  if (!row) return null;
  const frac = fraction(readNumber(row.utilization));
  if (frac === null) return null;
  const resetsAt = isoResetTime(row.resets_at);
  return { id, label, used: percentValue(frac), limit: null, percent: frac, state: windowState(frac, resetsAt), resetsAt };
}

/** Machine id for a scoped weekly window keyed off the model's display name
 *  (e.g. "Claude Opus 4.5" → "weekly_scoped_claude_opus_4_5"). */
function scopedWindowId(display: string): string {
  const slug = display
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `weekly_scoped_${slug || "model"}`;
}

function tierLabel(raw: string | undefined): string {
  const value = raw?.toLowerCase() ?? "";
  if (value.includes("max_20x") || value.includes("max20x") || value.includes("max-20x")) return "Max 20x";
  if (value.includes("max_5x") || value.includes("max5x") || value.includes("max-5x") || value.includes("max")) return "Max 5x";
  if (value.includes("pro")) return "Pro";
  if (value.includes("team")) return "Team";
  if (value.includes("enterprise")) return "Enterprise";
  return "Subscription";
}

/** Decodes the oauth/usage payload into a report. Exported for tests — the
 *  window/limits shape is worth locking down independent of the network. */
export function decodeClaudeUsage(body: ClaudeApiValue | undefined, credential: ClaudeCredential): QuotaProviderReport {
  const data = apiRecord(body);
  const five = windowOf("five_hour", "5-hour", data?.five_hour);
  const weekly = windowOf("weekly", "Weekly", data?.seven_day);
  const opus = windowOf("weekly_opus", "Weekly · Opus", data?.seven_day_opus);
  const sonnet = windowOf("weekly_sonnet", "Weekly · Sonnet", data?.seven_day_sonnet);
  const scoped: QuotaWindow[] = [];
  for (const item of apiArray(data?.limits)) {
    const row = apiRecord(item);
    if (!row) continue;
    const display = apiText(apiRecord(apiRecord(row.scope)?.model)?.display_name);
    const frac = fraction(readNumber(row.percent));
    if (row.kind !== "weekly_scoped" || display === null || frac === null) continue;
    const resetsAt = isoResetTime(row.resets_at);
    scoped.push({
      id: scopedWindowId(display),
      label: `Weekly · ${display}`,
      used: percentValue(frac),
      limit: null,
      percent: frac,
      state: windowState(frac, resetsAt),
      resetsAt,
    });
  }
  return {
    provider: "claudeAgent",
    connection: "connected",
    primary: weekly,
    windows: [five, weekly, opus, sonnet].filter((row): row is QuotaWindow => row !== null).concat(scoped),
    spend: [],
    trend: [],
    planLabel: tierLabel(credential.rateLimitTier),
    excludedModels: [],
    fetchedAt: Date.now(),
  };
}

async function request(token: string, deps: ClaudeDeps, parent?: AbortSignal): Promise<Response> {
  return deps.fetch(ENDPOINT, {
    method: "GET",
    signal: quotaRequestSignal(parent),
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/json",
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "kone/quota",
    },
  });
}

export type ClaudeQuotaResult = { report: QuotaProviderReport; retryAfterSeconds?: number };

/** Fetches Claude's own usage report for the credential Claude Code's CLI
 *  already left on disk. Never throws — every path resolves to a report;
 *  the caller (index.ts) layers the cache/backoff on top of this. */
export async function fetchClaudeQuota(
  options: Partial<ClaudeDeps> & { signal?: AbortSignal; allowKeychain?: boolean } = {},
): Promise<ClaudeQuotaResult> {
  const deps = { ...defaults, ...options };
  try {
    const initial = await resolveCredential(deps, options.allowKeychain ?? false);
    if (initial.denied) {
      return { report: emptyReport("claudeAgent", "accessDenied", "macOS Keychain access was denied for Claude Code's saved login.") };
    }
    let credential = initial.credential;
    if (!credential) return { report: emptyReport("claudeAgent", "disconnected", "Not connected — run `claude login` (or sign in via Claude Code) first.") };

    if (credential.expiresAt !== undefined && credential.expiresAt - deps.now() <= 5 * 60_000) {
      // Claude Code refreshes its own token in the background; re-read the
      // credential once rather than calling a near-expiry token and eating a
      // 401. Re-resolves the same sources as the initial read, so a keychain-
      // only login isn't stuck reporting a stale file that no longer exists.
      const reread = await resolveCredential(deps, options.allowKeychain ?? false);
      if (!reread.credential || reread.credential.accessToken === credential.accessToken) {
        return { report: emptyReport("claudeAgent", "transientFailure", "Claude Code's saved login is about to expire — reopen Claude Code to refresh it.") };
      }
      credential = reread.credential;
    }

    let response = await request(credential.accessToken, deps, options.signal);
    if (response.status === 401) {
      const reread = await resolveCredential(deps, options.allowKeychain ?? false);
      if (!reread.credential || reread.credential.accessToken === credential.accessToken) {
        return { report: emptyReport("claudeAgent", "transientFailure", "Claude rejected the saved login.") };
      }
      credential = reread.credential;
      response = await request(credential.accessToken, deps, options.signal);
    }
    if (response.status === 429) {
      let hint: ClaudeApiValue | undefined;
      try {
        // SAFETY: the error body is arbitrary JSON; retry_after is
        // revalidated through the decoders below before use.
        hint = apiRecord((await response.json()) as ClaudeApiValue)?.retry_after;
      } catch {
        hint = undefined;
      }
      const text = apiText(hint);
      const parsed = readNumber(hint) ?? (text !== null ? Number(text) : NaN);
      return {
        report: { ...emptyReport("claudeAgent", "transientFailure", "Claude's usage endpoint is rate-limiting us — backing off."), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(parsed) ? parsed : 300, 60),
      };
    }
    if (!response.ok) {
      return {
        report: emptyReport(
          "claudeAgent",
          response.status >= 400 && response.status < 500 ? "terminalFailure" : "transientFailure",
          `Claude's usage endpoint returned ${response.status}.`,
        ),
      };
    }
    // SAFETY: the endpoint hands back arbitrary JSON; every field is
    // revalidated through the decoders inside decodeClaudeUsage.
    return { report: decodeClaudeUsage((await response.json()) as ClaudeApiValue, credential) };
  } catch (error) {
    // Deliberately sanitized before the only diagnostic sink — no token ever
    // reaches a log line or a returned report.
    console.warn(`Claude quota unavailable: ${sanitizeError(error)}`);
    return { report: emptyReport("claudeAgent", "transientFailure", "Could not reach Claude's usage endpoint.") };
  }
}
