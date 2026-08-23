import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { quotaRequestSignal, readSecureFile, sanitizeError } from "./security.js";
import { emptyReport, percent as percentValue } from "./types.js";
import type { QuotaProviderReport, QuotaWindow, QuotaWindowState } from "./types.js";

// Factory Droid's own limits, read from Factory's billing/usage APIs with the
// Factory API key the user already holds (`FACTORY_API_KEY` env or
// `~/.factory/.env`). kone never runs a droid
// login and never decrypts Droid's own credential files (auth.v2.file is
// AES-encrypted): the API key is the only thing kone ever reads, and it never
// persists it anywhere.
//
// Endpoints, all called with `Authorization: Bearer <key>` plus the web-app
// client headers Factory's own dashboard sends:
//   GET https://api.factory.ai/api/billing/limits              → token-rate-
//     limit billing: `standard` and `core` pools, each with a rolling 5-hour,
//     weekly and monthly window (`usedPercent`, `windowEnd`,
//     `secondsRemaining`) — the authoritative source when the account uses it.
//   GET https://app.factory.ai/api/app/auth/me                 → plan / tier /
//     organization (the subscription label, never a credential).
//   GET https://api.factory.ai/api/organization/subscription/usage
//     ?useCache=true&userId=…                                  → legacy
//     standard/premium token usage against the billing period, used when the
//     billing-limits endpoint says the account isn't on token-rate-limit
//     billing or is unavailable.
//
// Window semantics: a rolling window whose
// reset time has already passed is treated as reset — Factory can leave stale
// `usedPercent` values after a short rolling window expires, and the web UI
// reads that state as 0%.

/** Test override for the CLI's state dir (mirrors droidScan's env-override
 *  pattern so detect can be exercised without touching a real ~/.factory). */
export const DROID_HOME_ENV = "DROID_HOME";

export const FACTORY_API_KEY_ENV = "FACTORY_API_KEY";

function droidHomeDir(): string {
  return process.env[DROID_HOME_ENV]?.trim() || path.join(os.homedir(), ".factory");
}

/** Credential files the CLI writes once a device-pairing login completes —
 *  same names droidHome.ts probes. Presence is the whole signal; kone never
 *  opens them (auth.v2.file is encrypted with the key in auth.v2.key). */
const DROID_LOGIN_FILES = ["auth.v2.file", "auth.encrypted"];

export type DroidDeps = {
  fetch: typeof fetch;
  env: NodeJS.ProcessEnv;
  factoryEnvPath: string;
  readFile: typeof readSecureFile;
  now: () => number;
};

function defaultDeps(): DroidDeps {
  return {
    fetch: globalThis.fetch,
    env: process.env,
    factoryEnvPath: path.join(os.homedir(), ".factory", ".env"),
    readFile: readSecureFile,
    now: Date.now,
  };
}

// ── the credential: a Factory API key ────────────────────────────────────────

function cleanedKey(value: string | undefined): string | null {
  if (!value) return null;
  let trimmed = value.trim();
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) || (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    trimmed = trimmed.slice(1, -1);
  }
  return trimmed.trim() || null;
}

/** `FACTORY_API_KEY` from a dotenv file — `export` prefixes and quoted values
 *  tolerated, everything but the exact key name ignored. */
export function parseFactoryDotEnvKey(contents: string): string | null {
  for (const rawLine of contents.split(/\r?\n/)) {
    let line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    if (line.startsWith("export ")) line = line.slice("export ".length).trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    if (line.slice(0, separator).trim() !== FACTORY_API_KEY_ENV) continue;
    let value = line.slice(separator + 1).trim();
    // A quoted value with a trailing `# comment` keeps only the quoted part
    // (dotenv semantics; a key never contains a bare `"`).
    if (value.startsWith('"') || value.startsWith("'")) {
      const close = value.indexOf(value[0]!, 1);
      if (close > 1) value = value.slice(0, close + 1);
    }
    return cleanedKey(value);
  }
  return null;
}

/** The API key in whichever of Factory's two plaintext spots it lives in: the
 *  process env, or the CLI's `~/.factory/.env`. The env wins when both exist —
 *  it is the more deliberate of the two. */
export async function resolveFactoryApiKey(deps: DroidDeps = defaultDeps()): Promise<string | null> {
  const fromEnv = cleanedKey(deps.env[FACTORY_API_KEY_ENV]);
  if (fromEnv) return fromEnv;
  try {
    const contents = await deps.readFile(deps.factoryEnvPath, 64 * 1024);
    return contents ? parseFactoryDotEnvKey(contents) : null;
  } catch (error) {
    // A permissions/symlink refusal reads the same as "no key here" — the
    // fetch below is what surfaces the real accessDenied.
    console.warn(`Factory .env read failed: ${sanitizeError(error)}`);
    return null;
  }
}

/** Is the user signed in *at all* — key or the CLI's own device-pairing login
 *  files? The fetch needs a key, so a login-only machine still reads
 *  "connected" here but gets a report that explains the key requirement
 *  rather than a silent "not connected". */
export async function detectDroidCredential(): Promise<boolean> {
  if ((await resolveFactoryApiKey()) !== null) return true;
  for (const name of DROID_LOGIN_FILES) {
    try {
      await fs.access(path.join(droidHomeDir(), name));
      return true;
    } catch {
      // Not this one — try the next login file.
    }
  }
  return false;
}

// ── decoding ─────────────────────────────────────────────────────────────────

/** One decoded Factory API document. getJson parses bytes once at its
 *  boundary; everything downstream branches on these domain values, so no
 *  step has to interrogate a representation. */
type FactoryApiValue =
  | string
  | number
  | boolean
  | null
  | FactoryApiValue[]
  | { [key: string]: FactoryApiValue };

type FactoryApiRecord = { [key: string]: FactoryApiValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isApiNumber(value: FactoryApiValue | undefined): value is number {
  return Number.isFinite(value);
}

function isApiRecord(value: FactoryApiValue | undefined): value is FactoryApiRecord {
  return value instanceof Object && !Array.isArray(value);
}

function apiRecord(value: FactoryApiValue | undefined): FactoryApiRecord | undefined {
  return isApiRecord(value) ? value : undefined;
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  identity — booleans by value, numbers by finiteness, composites by their
 *  constructors. */
function apiText(value: FactoryApiValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isApiNumber(value)) return null;
  return value;
}

function readNumber(value: FactoryApiValue | undefined): number | null {
  return isApiNumber(value) ? value : null;
}

function readString(value: FactoryApiValue | undefined): string | null {
  const text = apiText(value);
  return text !== null && text.trim().length > 0 ? text.trim() : null;
}

/** `windowEnd` arrives as epoch seconds, epoch milliseconds, or an ISO string. */
function parseWindowEnd(value: FactoryApiValue | undefined): number | null {
  if (isApiNumber(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    return ms > 0 ? ms : null;
  }
  const text = apiText(value);
  if (text !== null) {
    const numeric = Number(text);
    if (Number.isFinite(numeric) && text.trim() !== "") {
      const ms = numeric > 1e12 ? numeric : numeric * 1000;
      return ms > 0 ? ms : null;
    }
    const parsed = Date.parse(text);
    return Number.isNaN(parsed) ? null : parsed;
  }
  return null;
}

function windowState(frac: number, resetsAt: string | null): QuotaWindowState {
  return frac === 0 && resetsAt === null ? "notStarted" : "active";
}

/** One pool window → a kone meter. Factory can leave stale values after a
 *  short rolling window expires; a window whose reset has passed with no
 *  seconds remaining reads as reset (0%), matching the web UI. */
export function billingWindowOf(
  id: string,
  label: string,
  raw: FactoryApiValue | undefined,
  now: number,
): QuotaWindow | null {
  const window = apiRecord(raw);
  if (!window) return null;
  const usedPercent = readNumber(window.usedPercent);
  const secondsRemaining = readNumber(window.secondsRemaining);
  const windowEndMs = parseWindowEnd(window.windowEnd);

  const resetsAtMs = secondsRemaining !== null && secondsRemaining > 0
    ? now + secondsRemaining * 1000
    : windowEndMs !== null && windowEndMs > now
      ? windowEndMs
      : null;

  if (usedPercent === null) return null;
  let frac = Math.max(0, Math.min(1, usedPercent / 100));
  // An expired rolling window (window ended, no seconds remaining) is a reset,
  // not stale usage — the web UI reads it as 0%.
  if (resetsAtMs === null && windowEndMs !== null && secondsRemaining === null && frac > 0) {
    frac = 0;
  }
  const resetsAt = resetsAtMs === null ? null : new Date(resetsAtMs).toISOString();
  return {
    id,
    label,
    used: percentValue(frac),
    limit: null,
    percent: frac,
    state: windowState(frac, resetsAt),
    resetsAt,
  };
}

/** The six meters the billing-limits payload can report: the standard pool
 *  plus — only when it carries real data — the `core` pool, with the weekly
 *  window as primary. */
export function decodeBillingLimits(payload: FactoryApiValue | undefined, now: number): QuotaWindow[] {
  const root = apiRecord(payload);
  if (!root) return [];
  const limits = apiRecord(root.limits);
  if (!limits) return [];
  const standard = apiRecord(limits.standard);
  if (!standard) return [];

  const windows: QuotaWindow[] = [];
  const push = (id: string, label: string, raw: FactoryApiValue | undefined) => {
    const window = billingWindowOf(id, label, raw, now);
    if (window) windows.push(window);
  };
  push("droid-5h", "5-hour", standard.fiveHour);
  push("droid-weekly", "Weekly", standard.weekly);
  push("droid-monthly", "Monthly", standard.monthly);

  const core = apiRecord(limits.core);
  if (core && ["fiveHour", "weekly", "monthly"].some((name) => {
    const raw = apiRecord(core[name]);
    if (!raw) return false;
    return raw.usedPercent !== undefined || raw.windowEnd !== undefined || raw.secondsRemaining !== undefined;
  })) {
    push("droid-core-5h", "Core · 5-hour", core.fiveHour);
    push("droid-core-weekly", "Core · Weekly", core.weekly);
    push("droid-core-monthly", "Core · Monthly", core.monthly);
  }
  return windows;
}

/** Legacy subscription-usage payload: one token bucket per tier with a user
 *  allowance (or an org total). `usedRatio` (0..1) is preferred when present;
 *  otherwise tokens/allowance. An allowance past a trillion is unlimited —
 *  kone draws no meter there rather than inventing a percentage. */
export function decodeLegacyUsage(payload: FactoryApiValue | undefined, now: number): QuotaWindow[] {
  const root = apiRecord(payload);
  const usage = apiRecord(root?.usage);
  if (!usage) return [];
  const periodEndMs = parseWindowEnd(usage.endDate);

  const windows: QuotaWindow[] = [];
  const push = (id: string, label: string, raw: FactoryApiValue | undefined) => {
    const bucket = apiRecord(raw);
    if (!bucket) return;
    const usedRatio = readNumber(bucket.usedRatio);
    const used = readNumber(bucket.userTokens) ?? readNumber(bucket.orgTotalTokensUsed) ?? null;
    const allowance = readNumber(bucket.totalAllowance) ?? null;
    const unlimited = allowance !== null && allowance > 1_000_000_000_000;

    let frac: number | null = null;
    if (usedRatio !== null && Number.isFinite(usedRatio)) {
      frac = usedRatio >= -0.001 && usedRatio <= 1.001
        ? Math.max(0, Math.min(1, usedRatio))
        : usedRatio >= -0.1 && usedRatio <= 100.1 && !unlimited
          ? Math.max(0, Math.min(1, usedRatio / 100))
          : null;
    } else if (!unlimited && used !== null && allowance !== null && allowance > 0) {
      frac = Math.max(0, Math.min(1, used / allowance));
    }
    if (frac === null) return;

    const resetsAt = periodEndMs !== null && periodEndMs > now
      ? new Date(periodEndMs).toISOString()
      : null;
    windows.push({
      id,
      label,
      used: percentValue(frac),
      limit: null,
      percent: frac,
      state: windowState(frac, resetsAt),
      resetsAt,
    });
  };
  push("droid-standard", "Standard", usage.standard);
  push("droid-premium", "Premium", usage.premium);
  return windows;
}

/** Plan label from the auth payload: Factory tier + plan name, with the
 *  overage preference appended when the account declares one. */
export function planLabelFromAuth(body: FactoryApiValue | undefined): string | null {
  const root = apiRecord(body);
  const organization = apiRecord(root?.organization);
  const subscription = apiRecord(organization?.subscription);
  const orb = apiRecord(subscription?.orbSubscription);
  const plan = apiRecord(orb?.plan);
  const parts: string[] = [];
  const tier = readString(subscription?.factoryTier);
  if (tier) parts.push(`Factory ${tier.charAt(0)!.toUpperCase()}${tier.slice(1)}`);
  const planName = readString(plan?.name);
  if (planName && !planName.toLowerCase().includes("factory")) parts.push(planName);
  if (parts.length === 0) return null;
  return parts.join(" · ");
}

function userIdFromAuth(body: FactoryApiValue | undefined): string | null {
  const root = apiRecord(body);
  return readString(apiRecord(root?.userProfile)?.id);
}

// ── the provider surface ─────────────────────────────────────────────────────

const API_BASE = "https://api.factory.ai";
const APP_BASE = "https://app.factory.ai";

const WEB_APP_HEADERS = {
  Accept: "application/json",
  "Content-Type": "application/json",
  Origin: "https://app.factory.ai",
  Referer: "https://app.factory.ai/",
  "x-factory-client": "web-app",
  "User-Agent": "kone/quota",
};

async function getJson(
  deps: DroidDeps,
  url: string,
  key: string,
  signal: AbortSignal,
): Promise<{ status: number; body: FactoryApiValue | null; retryAfterSeconds?: number }> {
  const response = await deps.fetch(url, {
    method: "GET",
    signal,
    headers: { ...WEB_APP_HEADERS, Authorization: `Bearer ${key}` },
  });
  let body: FactoryApiValue | null = null;
  try {
    // SAFETY: the HTTP layer hands back arbitrary JSON; every consumer
    // re-validates fields through the decoders above before use.
    body = (await response.json()) as FactoryApiValue;
  } catch {
    body = null;
  }
  const retryAfter = response.headers.get("Retry-After");
  const retryAfterSeconds = retryAfter === null ? undefined : Number(retryAfter);
  return {
    status: response.status,
    body,
    retryAfterSeconds: Number.isFinite(retryAfterSeconds) ? retryAfterSeconds : undefined,
  };
}

export type DroidQuotaResult = { report: QuotaProviderReport; retryAfterSeconds?: number };

/** Fetches Factory Droid's own limits with the user's Factory API key. Never
 *  throws — every path resolves to a report; the caller (index.ts) layers the
 *  cache/backoff on top of this. */
export async function fetchDroidQuota(
  options: { signal?: AbortSignal; deps?: Partial<DroidDeps> } = {},
): Promise<DroidQuotaResult> {
  // SAFETY: Partial<DroidDeps> only omits optional hooks; the spread always
  // leaves the required defaults in place.
  const deps = { ...defaultDeps(), ...options.deps } as DroidDeps;
  const signal = quotaRequestSignal(options.signal);
  try {
    const key = await resolveFactoryApiKey(deps);
    if (key === null) {
      const loggedIn = await detectDroidCredential();
      return {
        report: emptyReport(
          "droid",
          "disconnected",
          loggedIn
            ? "Factory Droid is signed in, but kone reads its limits with a Factory API key — create one at https://app.factory.ai/settings/api-keys (or export FACTORY_API_KEY)."
            : "Not connected — sign in with `droid` (or set a Factory API key).",
        ),
      };
    }

    // Auth first: the subscription label, and the userId the legacy usage
    // endpoint scopes to. A rejected key ends here — no point probing further.
    const auth = await getJson(deps, `${APP_BASE}/api/app/auth/me`, key, signal);
    if (auth.status === 401 || auth.status === 403) {
      return {
        report: emptyReport("droid", "terminalFailure", "Factory rejected this API key — check it at https://app.factory.ai/settings/api-keys."),
      };
    }
    if (auth.status === 429) {
      return {
        report: { ...emptyReport("droid", "transientFailure", "Factory is rate-limiting us — backing off."), rateLimited: true },
        retryAfterSeconds: Math.max(auth.retryAfterSeconds ?? 300, 60),
      };
    }
    if (auth.status !== 200) return { report: emptyReport("droid", "transientFailure", `Factory's API returned ${auth.status}.`) };

    // The billing-limits payload is authoritative when the account is on
    // token-rate-limit billing; anything else falls back to the legacy usage
    // endpoint.
    let windows: QuotaWindow[] | null = null;
    const billing = await getJson(deps, `${API_BASE}/api/billing/limits`, key, signal);
    if (billing.status === 200 && apiRecord(billing.body)?.usesTokenRateLimitsBilling === true) {
      windows = decodeBillingLimits(billing.body, deps.now());
    }
    if (windows === null || windows.length === 0) {
      const userId = userIdFromAuth(auth.body);
      const usageUrl = `${API_BASE}/api/organization/subscription/usage?useCache=true${userId ? `&userId=${encodeURIComponent(userId)}` : ""}`;
      const usage = await getJson(deps, usageUrl, key, signal);
      if (usage.status !== 200) {
        return { report: emptyReport("droid", "transientFailure", `Factory's usage endpoint returned ${usage.status}.`) };
      }
      const legacy = decodeLegacyUsage(usage.body, deps.now());
      if (legacy.length > 0) windows = legacy;
    }
    if (windows === null || windows.length === 0) {
      return {
        report: emptyReport("droid", "transientFailure", "Factory's limits response didn't include usable pools."),
      };
    }

    return {
      report: {
        provider: "droid",
        connection: "connected",
        primary: windows.find((window) => window.id === "droid-weekly") ?? windows[0] ?? null,
        windows,
        spend: [],
        trend: [],
        planLabel: planLabelFromAuth(auth.body),
        excludedModels: [],
        fetchedAt: deps.now(),
      },
    };
  } catch (error) {
    console.warn(`[quota] Droid quota unavailable: ${sanitizeError(error)}`);
    return { report: emptyReport("droid", "transientFailure", "Something went wrong reading Factory Droid's limits.") };
  }
}
