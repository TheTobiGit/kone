import os from "node:os";
import path from "node:path";

import { atomicWriteSecureFile, fraction, quotaRequestSignal, readSecureFile, sanitizeError } from "./security.js";
import { count, emptyReport, percent as percentValue } from "./types.js";
import type { QuotaProviderReport, QuotaWindow, QuotaWindowState } from "./types.js";

// Codex's own ChatGPT-backend usage endpoint — the same one the Codex CLI's
// own `/status` reads. Credential discovery order matches Codex's own home
// resolution (see ../codexHome.ts): `~/.codex/auth.json` first (kone owns
// rotation there — the CLI writes it, we may refresh + write it back), then
// the read-only com.openai.codex App Support copy, and ONLY if it holds a
// plaintext access_token — a Safe-Storage-encrypted copy has none, and this
// module must never attempt to decrypt one. Endpoint, refresh flow and decode
// are ported minus the keychain source, which has no kone equivalent.

const USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const TOKEN_ENDPOINT = "https://auth.openai.com/oauth/token";
const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const EIGHT_DAYS = 8 * 24 * 60 * 60_000;

type AuthDoc = Record<string, any> & {
  auth_mode?: string;
  tokens?: { access_token?: string; refresh_token?: string; id_token?: string; account_id?: string; [key: string]: unknown };
  last_refresh?: string;
};

export type CodexDeps = {
  fetch: typeof fetch;
  authPath: string;
  openaiAuthPath: string;
  readFile: typeof readSecureFile;
  writeFile: typeof atomicWriteSecureFile;
  now: () => number;
};

const defaults: CodexDeps = {
  fetch: globalThis.fetch,
  authPath: path.join(os.homedir(), ".codex", "auth.json"),
  openaiAuthPath: path.join(os.homedir(), "Library", "Application Support", "com.openai.codex", "auth.json"),
  readFile: readSecureFile,
  writeFile: atomicWriteSecureFile,
  now: Date.now,
};

/** A resolved Codex credential plus how much of its lifecycle we own. Only
 *  the Codex CLI's own `auth.json` is `writable` — we may rotate and write it
 *  back; the OpenAI App Support copy is read-only, and this module never
 *  writes there. */
type CodexSource = {
  name: "authFile" | "openaiAppSupport";
  auth: AuthDoc;
  writable: boolean;
  reread: () => Promise<AuthDoc | null>;
};

async function readAuth(deps: CodexDeps, filePath: string = deps.authPath): Promise<AuthDoc | null> {
  const raw = await deps.readFile(filePath, 64 * 1024);
  return raw ? (JSON.parse(raw) as AuthDoc) : null;
}

async function discoverSource(deps: CodexDeps): Promise<CodexSource | null> {
  // (a) The Codex CLI's own ~/.codex/auth.json. We own rotation + write-back.
  const fileAuth = await readAuth(deps);
  if (fileAuth) return { name: "authFile", auth: fileAuth, writable: true, reread: () => readAuth(deps) };
  // (b) com.openai.codex App Support, only if it holds a plaintext auth JSON
  // with a usable token. Tokens encrypted via "Codex Safe Storage" have no
  // plaintext access_token here, so they fall through — we never decrypt.
  const openaiAuth = await readAuth(deps, deps.openaiAuthPath).catch(() => null);
  if (openaiAuth?.tokens?.access_token) {
    return { name: "openaiAppSupport", auth: openaiAuth, writable: false, reread: () => readAuth(deps, deps.openaiAuthPath).catch(() => null) };
  }
  return null;
}

function labelForSeconds(value: unknown): string {
  const seconds = typeof value === "number" ? Math.max(0, Math.trunc(value)) : 0;
  if (seconds < 3600) return "Hourly";
  if (seconds < 7200) return "Hour";
  if (seconds >= 18_000 && seconds < 19_000) return "5-hour";
  if (seconds >= 86_400 && seconds < 87_000) return "Daily";
  if (seconds >= 604_800 && seconds < 605_000) return "Weekly";
  const hours = Math.floor(seconds / 3600);
  return hours < 24 ? `${hours}-hour` : `${Math.floor(hours / 24)}-day`;
}

// Codex's rate-limit windows only ever publish a used_percent, never a raw
// used/limit count — so `used` is derived from that same fraction and
// `limit` stays null (there's no provider unit to put there).
function windowState(frac: number, resetsAt: string | null): QuotaWindowState {
  return frac === 0 && resetsAt === null ? "notStarted" : "active";
}

function windowOf(id: string, value: unknown, override?: string): QuotaWindow | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const frac = fraction(row.used_percent);
  if (frac === null) return null;
  const reset = typeof row.reset_at === "number" && Number.isFinite(row.reset_at) ? new Date(row.reset_at * 1000).toISOString() : null;
  return {
    id,
    label: override ?? labelForSeconds(row.limit_window_seconds),
    used: percentValue(frac),
    limit: null,
    percent: frac,
    state: windowState(frac, reset),
    resetsAt: reset,
  };
}

/** Machine id for an additional named rate limit (e.g. "gpt-5.1-codex" ·
 *  "primary_window" → "gpt_5_1_codex_primary_window"). */
function slug(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "") || "window"
  );
}

// chatgpt.com mixes encodings inside one payload. `Number('')` is 0, not NaN,
// so a blank string must be rejected explicitly or an absent `used` decodes
// as a confident zero.
function num(value: unknown): number | null {
  if (typeof value === "string" && !value.trim()) return null;
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

// Credit-based-pricing tiers arrive composite (`enterprise_cbp_usage_based`).
function normalizePlanType(value: string): string {
  return value
    .replace(/[_-]usage[_-]based$/, "")
    .replace(/^self[_-]serve[_-]/, "")
    .replace(/[_-]cbp$/, "")
    .replace(/[_-]cbp[_-]/g, "_");
}

function planLabel(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  const raw = value.trim();
  const lower = normalizePlanType(raw.toLowerCase());
  const known: Record<string, string> = {
    guest: "Guest",
    free: "Free",
    go: "Go",
    plus: "Plus",
    pro: "Pro",
    prolite: "Pro Lite",
    pro_lite: "Pro Lite",
    "pro-lite": "Pro Lite",
    free_workspace: "Free Workspace",
    team: "Team",
    business: "Business",
    education: "Education",
    quorum: "Quorum",
    k12: "K-12",
    enterprise: "Enterprise",
    edu: "Edu",
  };
  return known[lower] ?? lower.replace(/(^|[_-])\w/g, (match) => match.replace(/[_-]/, " ").toUpperCase());
}

// The admin-set monthly allowance, the only limit a credit-metered workspace
// has. `spend_control` is the live position, the others forward-compat. `any`
// because this walks six optional-chained hops, all validated by `num()`.
function spendControlWindow(data: Record<string, any>): QuotaWindow | null {
  // `find`/`num` per alias, not `??`: a non-null garbage value would stop `??`
  // and mask a valid alias further down. Object-shaped garbage still wins the
  // position — commit to the first candidate that decodes.
  const row = [
    data.spend_control?.individual_limit,
    data.spend_control?.individualLimit,
    data.individual_limit,
    data.individualLimit,
    data.rate_limit?.individual_limit,
    data.rate_limit?.individualLimit,
  ].find((candidate) => candidate && typeof candidate === "object");
  if (!row) return null;
  const limit = num(row.limit);
  if (limit === null || limit <= 0) return null;
  const remainingPercent = num(row.remaining_percent) ?? num(row.remainingPercent);
  const used = num(row.used);
  const rawPercent =
    num(row.used_percent) ??
    num(row.usedPercent) ??
    (remainingPercent === null ? null : 100 - remainingPercent) ??
    (used === null ? null : (used / limit) * 100);
  if (rawPercent === null) return null;
  const percent = Math.min(1, Math.max(0, rawPercent / 100));
  const resetRaw = num(row.reset_at) ?? num(row.resets_at) ?? num(row.resetsAt);
  // Past 8.64e15 ms `toISOString()` throws RangeError.
  const resetsAt = resetRaw !== null && resetRaw > 0 && resetRaw * 1000 <= 8.64e15 ? new Date(resetRaw * 1000).toISOString() : null;
  // Unclamped percent, so a 120% draw still reports 12,000 of 10,000.
  const spent = used ?? (limit * Math.max(0, rawPercent)) / 100;
  const round = (n: number) => Math.round(n).toLocaleString("en-US");
  const reached = data.spend_control?.reached === true;
  const label = `Monthly usage limit · ${round(spent)} / ${round(limit)} credits`;
  // Unlike the rate-limit windows, this one has a real used/limit count in the
  // provider's own unit (credits), not just a percentage — so `used`/`limit`
  // carry that count rather than being derived from `percent`.
  return {
    id: "monthly_credits",
    label: reached ? `${label} · limit reached` : label,
    used: count(spent, "credits"),
    limit: count(limit, "credits"),
    percent,
    state: windowState(percent, resetsAt),
    resetsAt,
  };
}

/** Decodes the wham/usage payload into a report. Exported for tests — the
 *  window/spend-control shape is worth locking down independent of the
 *  network. */
export function decodeCodexUsage(body: unknown): QuotaProviderReport {
  const data = body && typeof body === "object" ? (body as Record<string, any>) : {};
  const primaryRaw = windowOf("primary", data.rate_limit?.primary_window);
  const secondaryRaw = windowOf("secondary", data.rate_limit?.secondary_window);
  const primary = primaryRaw ?? secondaryRaw;
  const windows: QuotaWindow[] = [];
  if (primaryRaw) windows.push(primaryRaw);
  if (secondaryRaw && secondaryRaw !== primary) windows.push(secondaryRaw);
  else if (!primaryRaw && secondaryRaw) windows.push(secondaryRaw);
  if (Array.isArray(data.additional_rate_limits)) {
    for (const additional of data.additional_rate_limits) {
      if (!additional || typeof additional !== "object" || typeof additional.limit_name !== "string") continue;
      for (const key of ["primary_window", "secondary_window"] as const) {
        const raw = additional.rate_limit?.[key];
        const base = windowOf(`${slug(additional.limit_name)}_${key}`, raw);
        if (base && base.percent !== null && base.percent > 0) {
          windows.push({ ...base, label: `${additional.limit_name} · ${base.label}` });
        }
      }
    }
  }
  const credits = spendControlWindow(data);
  if (credits) windows.push(credits);
  return {
    provider: "codex",
    connection: "connected",
    primary: primary ?? credits,
    windows,
    spend: [],
    trend: [],
    planLabel: planLabel(data.plan_type),
    excludedModels: [],
    fetchedAt: Date.now(),
  };
}

async function refresh(auth: AuthDoc, deps: CodexDeps, signal?: AbortSignal): Promise<AuthDoc | null> {
  const refreshToken = auth.tokens?.refresh_token;
  if (!refreshToken) return null;
  const response = await deps.fetch(TOKEN_ENDPOINT, {
    method: "POST",
    signal: quotaRequestSignal(signal),
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: CLIENT_ID, grant_type: "refresh_token", refresh_token: refreshToken, scope: "openid profile email" }),
  });
  if (!response.ok) return null;
  const next = (await response.json()) as Record<string, unknown>;
  if (typeof next.access_token !== "string" || !next.access_token) return null;
  const latest = await readAuth(deps);
  if (!latest || latest.auth_mode !== "chatgpt") return null;
  latest.tokens = {
    ...latest.tokens,
    access_token: next.access_token,
    ...(typeof next.refresh_token === "string" ? { refresh_token: next.refresh_token } : {}),
    ...(typeof next.id_token === "string" ? { id_token: next.id_token } : {}),
  };
  latest.last_refresh = new Date(deps.now()).toISOString();
  // The only place this module ever writes a token to disk — and only back to
  // the source (the Codex CLI's own auth.json) whose rotation kone owns.
  await deps.writeFile(deps.authPath, `${JSON.stringify(latest, null, 2)}\n`);
  return latest;
}

async function usage(auth: AuthDoc, deps: CodexDeps, signal?: AbortSignal): Promise<Response | null> {
  const token = auth.tokens?.access_token;
  if (!token) return null;
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", "User-Agent": "kone/quota" };
  if (auth.tokens?.account_id) headers["ChatGPT-Account-Id"] = auth.tokens.account_id;
  return deps.fetch(USAGE_ENDPOINT, { method: "GET", headers, signal: quotaRequestSignal(signal) });
}

export type CodexQuotaResult = { report: QuotaProviderReport; retryAfterSeconds?: number };

/** Fetches Codex's own usage report for whichever credential source resolves
 *  first (see discoverSource). Never throws — every path resolves to a
 *  report; the caller (index.ts) layers the cache/backoff on top of this. */
export async function fetchCodexQuota(options: Partial<CodexDeps> & { signal?: AbortSignal } = {}): Promise<CodexQuotaResult> {
  const deps = { ...defaults, ...options };
  try {
    const source = await discoverSource(deps);
    if (!source) return { report: emptyReport("codex", "disconnected", "Not connected — run `codex login` first.") };
    let auth = source.auth;
    if (auth.auth_mode !== "chatgpt") {
      return { report: emptyReport("codex", "terminalFailure", "Codex is signed in with an API key, not a ChatGPT subscription — no usage quota to report.") };
    }
    if (!auth.tokens?.access_token) return { report: emptyReport("codex", "disconnected", "Not connected — run `codex login` first.") };

    // Proactive staleness refresh only for the source whose rotation we own.
    if (source.writable) {
      const refreshedAt = typeof auth.last_refresh === "string" ? Date.parse(auth.last_refresh) : NaN;
      if (!Number.isFinite(refreshedAt) || deps.now() - refreshedAt > EIGHT_DAYS) {
        const next = await refresh(auth, deps, options.signal);
        if (next) auth = next;
      }
    }
    let response = await usage(auth, deps, options.signal);
    if (!response) return { report: emptyReport("codex", "disconnected", "Not connected — run `codex login` first.") };
    if (response.status === 401) {
      const reread = await source.reread();
      if (reread?.tokens?.access_token && reread.tokens.access_token !== auth.tokens?.access_token) {
        auth = reread;
      } else if (source.writable) {
        const next = await refresh(reread ?? auth, deps, options.signal);
        if (!next) return { report: emptyReport("codex", "transientFailure", "Codex rejected the saved login and it could not be refreshed.") };
        auth = next;
      } else {
        // Read-only source: nothing here owns rotation, so re-read once and
        // otherwise wait for the next poll.
        return { report: emptyReport("codex", "transientFailure", "Codex rejected the saved login.") };
      }
      response = await usage(auth, deps, options.signal);
      if (!response) return { report: emptyReport("codex", "transientFailure", "Could not reach Codex's usage endpoint.") };
    }
    if (response.status === 429) {
      const raw = response.headers.get("Retry-After");
      let seconds = raw === null ? NaN : Number(raw);
      if (!Number.isFinite(seconds) && raw) seconds = (Date.parse(raw) - deps.now()) / 1000;
      return {
        report: { ...emptyReport("codex", "transientFailure", "Codex's usage endpoint is rate-limiting us — backing off."), rateLimited: true },
        retryAfterSeconds: Math.max(Number.isFinite(seconds) ? Math.ceil(seconds) : 300, 60),
      };
    }
    if (!response.ok) {
      return {
        report: emptyReport(
          "codex",
          response.status >= 400 && response.status < 500 ? "terminalFailure" : "transientFailure",
          `Codex's usage endpoint returned ${response.status}.`,
        ),
      };
    }
    return { report: decodeCodexUsage(await response.json()) };
  } catch (error) {
    console.warn(`Codex quota unavailable: ${sanitizeError(error)}`);
    return { report: emptyReport("codex", "transientFailure", "Could not reach Codex's usage endpoint.") };
  }
}
