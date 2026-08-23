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

type CodexTokens = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
  account_id?: string;
};

type AuthDoc = {
  auth_mode?: string;
  tokens?: CodexTokens | null;
  last_refresh?: string;
};

// chatgpt.com's payload mixes encodings inside one response — the same slot
// can carry a number, a numeric string, an explicit null, or be absent — so
// spend-control scalars decode through num(), and the percent/window fields
// through fraction()'s own finite gate, rather than trusting shapes alone.
type UsageScalar = number | string | null | undefined;

type RateLimitWindowRow = {
  used_percent?: number;
  limit_window_seconds?: number;
  reset_at?: number;
};

type RateLimitGroup = {
  primary_window?: RateLimitWindowRow | null;
  secondary_window?: RateLimitWindowRow | null;
  individual_limit?: SpendControlRow | null;
  individualLimit?: SpendControlRow | null;
};

type AdditionalRateLimit = {
  limit_name?: string;
  rate_limit?: RateLimitGroup | null;
};

type SpendControlRow = {
  limit?: UsageScalar;
  remaining_percent?: UsageScalar;
  remainingPercent?: UsageScalar;
  used?: UsageScalar;
  used_percent?: UsageScalar;
  usedPercent?: UsageScalar;
  reset_at?: UsageScalar;
  resets_at?: UsageScalar;
  resetsAt?: UsageScalar;
};

type SpendControl = {
  reached?: boolean;
  individual_limit?: SpendControlRow | null;
  individualLimit?: SpendControlRow | null;
};

type UsagePayload = {
  plan_type?: string;
  rate_limit?: RateLimitGroup | null;
  additional_rate_limits?: AdditionalRateLimit[] | null;
  spend_control?: SpendControl | null;
  individual_limit?: SpendControlRow | null;
  individualLimit?: SpendControlRow | null;
};

type TokenResponse = {
  access_token?: string;
  refresh_token?: string;
  id_token?: string;
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
  if (!raw) return null;
  // Malformed JSON throws into the caller's catch — a corrupt auth file must
  // read as "no credential", never take down the poll.
  const doc: AuthDoc = JSON.parse(raw);
  return doc;
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

function labelForSeconds(seconds: number | null | undefined): string {
  const total = seconds != null && Number.isFinite(seconds) ? Math.max(0, Math.trunc(seconds)) : 0;
  if (total < 3600) return "Hourly";
  if (total < 7200) return "Hour";
  if (total >= 18_000 && total < 19_000) return "5-hour";
  if (total >= 86_400 && total < 87_000) return "Daily";
  if (total >= 604_800 && total < 605_000) return "Weekly";
  const hours = Math.floor(total / 3600);
  return hours < 24 ? `${hours}-hour` : `${Math.floor(hours / 24)}-day`;
}

// Codex's rate-limit windows only ever publish a used_percent, never a raw
// used/limit count — so `used` is derived from that same fraction and
// `limit` stays null (there's no provider unit to put there).
function windowState(frac: number, resetsAt: string | null): QuotaWindowState {
  return frac === 0 && resetsAt === null ? "notStarted" : "active";
}

function windowOf(id: string, value: RateLimitWindowRow | null | undefined, override?: string): QuotaWindow | null {
  if (!value) return null;
  const frac = fraction(value.used_percent);
  if (frac === null) return null;
  // Number.isFinite rejects every non-number without coercing, so string or
  // null garbage degrades to "no reset time" exactly like a missing field.
  const reset = value.reset_at != null && Number.isFinite(value.reset_at) ? new Date(value.reset_at * 1000).toISOString() : null;
  return {
    id,
    label: override ?? labelForSeconds(value.limit_window_seconds),
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
function num(value: UsageScalar): number | null {
  if (value == null || value === "") return null;
  const text = String(value).trim();
  if (!text) return null;
  const parsed = Number(text);
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

function planLabel(planType: string | null | undefined): string | null {
  if (!planType?.trim()) return null;
  const raw = planType.trim();
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
function spendControlWindow(data: UsagePayload): QuotaWindow | null {
  // `find`/`num` per alias, not `??`: a non-null garbage value would stop `??`
  // and mask a valid alias further down. The first candidate present wins the
  // position — commit to it even if its own fields fail to decode.
  const row = [
    data.spend_control?.individual_limit,
    data.spend_control?.individualLimit,
    data.individual_limit,
    data.individualLimit,
    data.rate_limit?.individual_limit,
    data.rate_limit?.individualLimit,
  ].find((candidate) => candidate != null);
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

/** Decodes the wham/usage payload into a report. The payload type carries
 *  optional fields everywhere, so absent or null forward-compat slots decode
 *  as missing rather than crashing the poll. */
function decodeCodexUsage(data: UsagePayload): QuotaProviderReport {
  const primaryRaw = windowOf("primary", data.rate_limit?.primary_window);
  const secondaryRaw = windowOf("secondary", data.rate_limit?.secondary_window);
  const primary = primaryRaw ?? secondaryRaw;
  const windows: QuotaWindow[] = [];
  if (primaryRaw) windows.push(primaryRaw);
  if (secondaryRaw && secondaryRaw !== primary) windows.push(secondaryRaw);
  else if (!primaryRaw && secondaryRaw) windows.push(secondaryRaw);
  for (const additional of data.additional_rate_limits ?? []) {
    if (!additional?.limit_name) continue;
    for (const key of ["primary_window", "secondary_window"] as const) {
      const raw = additional.rate_limit?.[key];
      const base = windowOf(`${slug(additional.limit_name)}_${key}`, raw);
      if (base && base.percent !== null && base.percent > 0) {
        windows.push({ ...base, label: `${additional.limit_name} · ${base.label}` });
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
  const next: TokenResponse = JSON.parse(await response.text());
  if (!next.access_token) return null;
  const latest = await readAuth(deps);
  if (!latest || latest.auth_mode !== "chatgpt") return null;
  latest.tokens = { ...latest.tokens, access_token: next.access_token };
  if (next.refresh_token) latest.tokens.refresh_token = next.refresh_token;
  if (next.id_token) latest.tokens.id_token = next.id_token;
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
      const refreshedAt = auth.last_refresh ? Date.parse(auth.last_refresh) : NaN;
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
    return { report: decodeCodexUsage(JSON.parse(await response.text())) };
  } catch (error) {
    console.warn(`Codex quota unavailable: ${sanitizeError(error)}`);
    return { report: emptyReport("codex", "transientFailure", "Could not reach Codex's usage endpoint.") };
  }
}
