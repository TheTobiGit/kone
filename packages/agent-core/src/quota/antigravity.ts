import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { quotaRequestSignal, sanitizeError } from "./security.js";
import { emptyReport, percent as percentValue } from "./types.js";
import type { QuotaProviderReport, QuotaWindow, QuotaWindowState } from "./types.js";

// Antigravity's own quota pools, read from the language server the Antigravity
// *credential* — what the Limits pane's offline presence check calls
// "something to connect to" — is the CLI's own OAuth login on disk
// (~/.gemini/antigravity-cli/antigravity-oauth-token, presence only, never
// read), exactly like claude/cursor detect their credential files. The
// the app's `language_server` process (CSRF token + port flags in its argv),
// then the bare `agy` process, which hosts the same RPC in-process with no
// CSRF at all (ports resolved via lsof). kone never touches Antigravity's
// it needs the OAuth client secret and the Keychain, and the local sources
// cover every case kone cares about).
//
// Quota shape (since Antigravity's 2026-05-19 pool merge): two shared pools —
// Gemini (Pro + Flash draw from one) and every non-Gemini model (Claude,
// GPT-OSS, …) — each with a rolling 5-hour window and a weekly window. The
// summary reports each as a `remainingFraction` (1 = full), so kone derives
// the consumed fraction, exactly like its Claude window handling.

/** Test override for the CLI's state dir (mirrors droidScan's env-override
 *  pattern so detect can be exercised without touching a real ~/.gemini). */
export const ANTIGRAVITY_CLI_DIR_ENV = "ANTIGRAVITY_CLI_DIR";

function antigravityCliDir(): string {
  return process.env[ANTIGRAVITY_CLI_DIR_ENV]?.trim() || path.join(os.homedir(), ".gemini", "antigravity-cli");
}

/** The four pool buckets `RetrieveUserQuotaSummary` reports, matched by exact
 *  bucketId only — a future bucket must never silently join a pool. */
const SUMMARY_BUCKETS: ReadonlyArray<{ bucketId: string; label: string }> = [
  { bucketId: "gemini-5h", label: "Session" },
  { bucketId: "gemini-weekly", label: "Weekly" },
  { bucketId: "3p-5h", label: "Claude" },
  { bucketId: "3p-weekly", label: "Claude Weekly" },
];

const LS_SERVICE = "exa.language_server_pb.LanguageServerService";
const LS_METADATA = {
  ideName: "antigravity",
  extensionName: "antigravity",
  ideVersion: "unknown",
  locale: "en",
};
const LS_TIMEOUT_MS = 10_000;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;

/** The loopback language server: CSRF token + candidate ports. The CSRF token
 *  is optional — the `agy` CLI hosts the same RPC in its own process without
 */
export type AntigravityLanguageServer = {
  csrfToken?: string;
  /** Candidate listening ports, from `--https_server_port` /
   *  `--extension_server_port` flags or lsof on the owning pid. */
  ports: number[];
  /** The pid the ports were resolved from (agy path) — informational. */
  pid?: number;
};

const execFileAsync = promisify(execFile);

/** A usable CSRF token is any non-empty one — the app writes tokens of varied
 *  shapes. */
function isLikelyCsrfToken(value: string): boolean {
  return value.trim().length > 0;
}

/** Split a command line into tokens, honoring quoted values (`--flag "a b"`). */
function tokenize(command: string): string[] {
  const tokens: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(command)) !== null) {
    tokens.push(match[1] ?? match[2] ?? match[3]!);
  }
  return tokens;
}

/** Parse `--flag value` / `--flag=value` from a process command line. */
export function cliFlagValue(command: string, flag: string): string | null {
  const tokens = tokenize(command);
  const flagEq = `${flag}=`;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i]!;
    if (token.startsWith(flagEq)) {
      const value = token.slice(flagEq.length);
      if (value && !value.startsWith("--")) return value;
      continue;
    }
    if (token === flag && i + 1 < tokens.length) {
      const value = tokens[i + 1]!;
      if (value && !value.startsWith("--")) return value;
    }
  }
  return null;
}

function parseIntFlag(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65535 ? parsed : undefined;
}

/** Extract the app language server's pid + CSRF token + port flags from one
 *  process command line, when it is one (contains `language_server` and an
 *  antigravity marker). Ports may be empty — newer app builds pass neither
 *  port flag, and discovery fills them from lsof on the pid. Export for tests. */
export function parseAntigravityLanguageServerLine(
  line: string,
): AntigravityLanguageServer | null {
  const lower = line.toLowerCase();
  // Both spellings exist in the wild: the app spawns `language_server` (with
  // an underscore) as the process name; `agy language-server` (hyphenated) is
  // the CLI's own subcommand spelling.
  if (
    !(lower.includes("language_server") || lower.includes("language-server")) ||
    !(lower.includes("antigravity") || lower.includes("agy"))
  ) {
    return null;
  }
  const csrfToken = cliFlagValue(line, "--csrf_token");
  if (!csrfToken || !isLikelyCsrfToken(csrfToken)) return null;
  const ports = [
    parseIntFlag(cliFlagValue(line, "--https_server_port")),
    parseIntFlag(cliFlagValue(line, "--extension_server_port")),
  ].filter((port): port is number => port !== undefined);
  const match = line.trim().match(/^(\d+)\s+(.+)$/);
  const pid = match ? Number(match[1]) : undefined;
  const server: AntigravityLanguageServer = { csrfToken, ports };
  if (pid !== undefined && Number.isInteger(pid) && pid > 0) server.pid = pid;
  return server;
}

/** Parse `ps` output into the first matching app language server. */
export function parseAntigravityLanguageServerLines(lines: readonly string[]): AntigravityLanguageServer | null {
  for (const line of lines) {
    const server = parseAntigravityLanguageServerLine(line);
    if (server) return server;
  }
  return null;
}

/** The executable name of a process command line's argv0, honoring quotes. */
function processExecutableName(command: string): string {
  const trimmed = command.trimStart();
  let token: string;
  if (trimmed.startsWith('"') || trimmed.startsWith("'")) {
    const quote = trimmed[0]!;
    const end = trimmed.indexOf(quote, 1);
    token = end < 0 ? trimmed : trimmed.slice(1, end);
  } else {
    token = trimmed.split(/\s+/, 1)[0] ?? "";
  }
  return token.split("/").pop() ?? token;
}

/** The Antigravity CLI process names that host the language-server RPC
 *  in-process with no CSRF token. */
const CLI_PROCESS_NAMES = new Set(["agy", "agy.exe", "antigravity-cli", "antigravity_cli"]);

/** Find a bare Antigravity CLI process (`agy` / `antigravity-cli`) — it hosts
 *  the same language-server RPC in its own process, with no CSRF token and no
 *  port flags; the listening ports come from lsof on the pid. */
function findAgyProcess(lines: readonly string[]): { pid: number; command: string } | null {
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = processExecutableName(match[2]!).toLowerCase();
    if (CLI_PROCESS_NAMES.has(name) || name.endsWith("/agy")) {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) return { pid, command: match[2]! };
    }
  }
  return null;
}

/** The TCP ports one pid is listening on, via lsof. Empty when the pid has
 *  none (or lsof is missing). */
async function listeningPortsForPid(pid: number): Promise<number[]> {
  const lsof = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)]);
  return lsof === null ? [] : parseListeningPorts(lsof);
}

/** Parse `lsof -nP -iTCP -sTCP:LISTEN` output into listening ports. */
export function parseListeningPorts(output: string): number[] {
  const ports = new Set<number>();
  for (const line of output.split(/\r?\n/)) {
    if (!line.includes("LISTEN")) continue;
    for (const token of line.split(/\s+/).reverse()) {
      const colon = token.lastIndexOf(":");
      if (colon < 0) continue;
      const port = Number(token.slice(colon + 1));
      if (Number.isInteger(port) && port > 0 && port <= 65535) {
        ports.add(port);
        break;
      }
    }
  }
  return [...ports].sort((a, b) => a - b);
}

async function runCommand(command: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync(command, args, { timeout: 5_000, windowsHide: true });
    return stdout;
  } catch {
    return null;
  }
}

/** The loopback server to ask. Order matters: the app's `language_server`
 *  processes first (richest — csrf + explicit ports), then the bare
 *  Antigravity CLI process (in-process RPC, ports via lsof). Every candidate's
 *  ports are resolved from its argv flags when present, falling back to lsof
 *  on its pid — newer app builds pass neither port flag, so the listening
 *  ports are read from the pid rather than trusting argv. The first candidate
 *  with a CSRF token and at least one listening port wins; a tokenless match
 *  is skipped so a later valid server can still be found. */
async function discoverLanguageServer(): Promise<AntigravityLanguageServer | null> {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and ($_.CommandLine -like '*antigravity*' -or $_.CommandLine -like '*agy*') } | ForEach-Object { \"$($_.ProcessId) $($_.CommandLine)\" }",
    ].join("; ");
    const output = await runCommand("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ]);
    for (const line of output?.split(/\r?\n/) ?? []) {
      const ls = parseAntigravityLanguageServerLine(line);
      if (!ls) continue;
      let ports = ls.ports;
      if (ports.length === 0 && ls.pid !== undefined) {
        ports = await windowsPortsForPid(ls.pid);
      }
      if (ports.length === 0) continue;
      return { csrfToken: ls.csrfToken, ports, pid: ls.pid };
    }
    // Windows CLI: name-query for the process, then its listening ports.
    const cliScript = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agy.exe' -or $_.Name -eq 'agy' -or $_.Name -eq 'antigravity-cli.exe' -or $_.Name -eq 'antigravity_cli.exe' } | ForEach-Object { $_.ProcessId }",
    ].join("; ");
    const cliOutput = await runCommand("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", cliScript,
    ]);
    const pid = Number(cliOutput?.trim().split(/\r?\n/)[0] ?? "");
    if (Number.isInteger(pid) && pid > 0) {
      const ports = await windowsPortsForPid(pid);
      if (ports.length > 0) return { ports, pid };
    }
    return null;
  }

  const psOutput = await runCommand("ps", ["-ax", "-o", "pid=,command="]);
  if (psOutput === null) return null;
  const lines = psOutput.split("\n");

  for (const line of lines) {
    const ls = parseAntigravityLanguageServerLine(line);
    if (!ls) continue;
    let ports = ls.ports;
    if (ports.length === 0 && ls.pid !== undefined) {
      ports = await listeningPortsForPid(ls.pid);
    }
    if (ports.length === 0) continue;
    return { csrfToken: ls.csrfToken, ports, pid: ls.pid };
  }

  const cli = findAgyProcess(lines);
  if (cli) {
    const ports = await listeningPortsForPid(cli.pid);
    if (ports.length > 0) return { ports, pid: cli.pid };
  }
  return null;
}

/** The TCP ports one pid is listening on, via PowerShell (Windows lsof
 *  equivalent). Empty when the pid has none. */
async function windowsPortsForPid(pid: number): Promise<number[]> {
  const portScript = `Get-NetTCPConnection -State Listen -OwningProcess ${pid} | Select-Object -ExpandProperty LocalPort`;
  const portsOutput = await runCommand("powershell.exe", [
    "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", portScript,
  ]);
  return (portsOutput ?? "")
    .split(/\r?\n/)
    .map((line) => Number(line.trim()))
    .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
}

// ── the quota RPC ────────────────────────────────────────────────────────────

function postLsRpc(
  server: AntigravityLanguageServer,
  scheme: "https" | "http",
  port: number,
  method: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string } | null> {
  const body = JSON.stringify({ metadata: LS_METADATA });
  return new Promise((resolve) => {
    const requestOptions: https.RequestOptions = {
      hostname: "127.0.0.1",
      port,
      path: `/${LS_SERVICE}/${method}`,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Connect-Protocol-Version": "1",
        "Content-Length": Buffer.byteLength(body),
      },
      timeout: LS_TIMEOUT_MS,
    };
    if (server.csrfToken) {
      // The agy in-process server needs no CSRF token — only the app's
      // language_server process has one.
      requestOptions.headers = {
        ...requestOptions.headers,
        "x-codeium-csrf-token": server.csrfToken,
      };
    }
    // The language server serves a self-signed cert; the endpoint is
    // loopback-only, so trusting it is the point.
    if (scheme === "https") requestOptions.rejectUnauthorized = false;
    const req = (scheme === "https" ? https : http).request(requestOptions, (res) => {
      const chunks: Buffer[] = [];
      let total = 0;
      res.on("data", (chunk: Buffer) => {
        total += chunk.length;
        if (total > MAX_RESPONSE_BYTES) {
          res.destroy();
          resolve(null);
          return;
        }
        chunks.push(chunk);
      });
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString("utf8") });
      });
      res.on("error", () => resolve(null));
    });
    req.on("error", () => resolve(null));
    req.on("timeout", () => {
      req.destroy();
      resolve(null);
    });
    const onAbort = () => req.destroy();
    if (signal?.aborted) {
      req.destroy();
      resolve(null);
      return;
    }
    signal?.addEventListener("abort", onAbort);
    req.on("close", () => signal?.removeEventListener("abort", onAbort));
    req.write(body);
    req.end();
  });
}

async function callLs(
  server: AntigravityLanguageServer,
  method: string,
  signal?: AbortSignal,
): Promise<{ status: number; body: string } | null> {
  // HTTPS first (the app server serves a self-signed cert), then HTTP on the
  // same port, then HTTP on any further port (agy's in-process server answers
  // plain HTTP reliably; its TLS handshake is flaky).
  const endpoints: Array<[scheme: "https" | "http", port: number]> = [];
  for (const port of server.ports) {
    endpoints.push(["https", port], ["http", port]);
  }
  for (const [scheme, port] of endpoints) {
    const response = await postLsRpc(server, scheme, port, method, signal);
    if (response !== null) return response;
  }
  return null;
}

// ── decoding ─────────────────────────────────────────────────────────────────

/** One decoded language-server document. The RPC layer parses bytes once at
 *  its boundary; everything downstream branches on these domain values, so no
 *  step has to interrogate a representation. */
type AntigravityApiValue =
  | string
  | number
  | boolean
  | null
  | AntigravityApiValue[]
  | { [key: string]: AntigravityApiValue };

type AntigravityApiRecord = { [key: string]: AntigravityApiValue };

/** Decoded JSON numbers are always finite, so finiteness separates the number
 *  variant from every other JSON variant without inspecting representations. */
function isApiNumber(value: AntigravityApiValue | undefined): value is number {
  return Number.isFinite(value);
}

function isApiRecord(value: AntigravityApiValue | undefined): value is AntigravityApiRecord {
  return value instanceof Object && !Array.isArray(value);
}

function apiRecord(value: AntigravityApiValue | undefined): AntigravityApiRecord | undefined {
  return isApiRecord(value) ? value : undefined;
}

function apiArray(value: AntigravityApiValue | undefined): AntigravityApiValue[] {
  return Array.isArray(value) ? value : [];
}

/** Text is the one JSON variant left after every other variant is excluded by
 *  identity — booleans by value, numbers by finiteness, composites by their
 *  constructors. */
function apiText(value: AntigravityApiValue | undefined): string | null {
  if (value === undefined || value === null || value === true || value === false) return null;
  if (Array.isArray(value) || value instanceof Object || isApiNumber(value)) return null;
  return value;
}

function readNumber(value: AntigravityApiValue | undefined): number | null {
  return isApiNumber(value) ? value : null;
}

function windowState(frac: number, resetsAt: string | null): QuotaWindowState {
  return frac === 0 && resetsAt === null ? "notStarted" : "active";
}

/** Normalize a raw plan/tier string to a short label — "Google AI Pro" → "Pro",
 *  "Gemini Code Assist in Google One AI Pro" → "Pro". */
export function formatAntigravityPlan(raw: string | null | undefined): string | null {
  const trimmed = raw?.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("Google AI ")) {
    const tail = trimmed.slice("Google AI ".length).trim();
    return tail.length > 0 ? tail : null;
  }
  for (const keyword of ["Ultra", "Pro", "Free"]) {
    if (trimmed.toLowerCase().includes(keyword.toLowerCase())) return keyword;
  }
  return trimmed.length > 0 && trimmed.length <= 32 ? trimmed : null;
}

/** `RetrieveUserQuotaSummary` body → the four pool windows. Accepts both the
 *  LS envelope (`{"response": {"groups": …}}`) and the bare remote payload
 *  (`{"groups": …}`).
 *
 *  Nil means "not a summary" (no `groups` anywhere) — the caller falls back
 *  to the legacy per-model endpoints. An **empty array** is different and
 *  load-bearing: groups existed but none carried a usable, known bucket — a
 *  *parsed* summary, authoritative, and never to be replaced by the legacy
 *  chain's fabricated "fully used" numbers. */
export function parseAntigravityQuotaSummary(body: AntigravityApiValue | undefined): QuotaWindow[] | null {
  const envelope = apiRecord(body);
  const rawGroups = envelope ? envelope.groups : undefined;
  const groups = apiArray(rawGroups).length > 0 ? apiArray(rawGroups) : apiArray(apiRecord(envelope?.response)?.groups);
  if (groups.length === 0) return null;

  const pooled = new Map<string, { consumed: number; resetsAt: string | null }>();
  for (const group of groups) {
    for (const bucket of apiArray(apiRecord(group)?.buckets)) {
      const record = apiRecord(bucket);
      if (!record) continue;
      const bucketId = apiText(record.bucketId);
      if (!bucketId || !SUMMARY_BUCKETS.some((spec) => spec.bucketId === bucketId)) continue;
      if (pooled.has(bucketId)) continue; // duplicate id — first one wins
      const remaining = readNumber(record.remainingFraction);
      if (remaining === null) continue;
      const clamped = Math.max(0, Math.min(1, remaining));
      const resetsAt = isoResetTime(record.resetTime);
      pooled.set(bucketId, { consumed: 1 - clamped, resetsAt });
    }
  }

  const windows: QuotaWindow[] = [];
  for (const spec of SUMMARY_BUCKETS) {
    const entry = pooled.get(spec.bucketId);
    if (!entry) continue;
    windows.push({
      id: spec.bucketId,
      label: spec.label,
      used: percentValue(entry.consumed),
      limit: null,
      percent: entry.consumed,
      state: windowState(entry.consumed, entry.resetsAt),
      resetsAt: entry.resetsAt,
    });
  }
  return windows;
}

/** A timestamp the server may send in any textual form, kept only when it
 *  parses; normalized to ISO so downstream comparisons see one shape. */
function isoResetTime(value: AntigravityApiValue | undefined): string | null {
  const text = apiText(value);
  return text !== null && !Number.isNaN(Date.parse(text)) ? new Date(text).toISOString() : null;
}

/** `GetUserStatus` → the plan label (prefers Google's own `userTier`). */
export function parseAntigravityUserStatus(body: AntigravityApiValue | undefined): string | null {
  const envelope = apiRecord(body);
  const userStatus = apiRecord(envelope?.userStatus);
  const tier = apiRecord(userStatus?.userTier);
  const planInfo = apiRecord(apiRecord(userStatus?.planStatus)?.planInfo);
  const plan = apiText(tier?.name) ?? apiText(planInfo?.planName);
  return formatAntigravityPlan(plan);
}

// ── the legacy per-model fallback ───────────────────────────────────────────

/** One model's quota from the legacy endpoints. A model with no quotaInfo is
 *  treated as depleted — the legacy path's known fabrication, acceptable only
 *  because a *parsed summary* never reaches it. */
type LegacyModelConfig = {
  label: string;
  modelID?: string;
  remainingFraction: number;
  resetTime: string | null;
};

/** Internal/duplicate model ids that must never surface as a meter. */
const LEGACY_MODEL_BLACKLIST = new Set([
  "MODEL_CHAT_20706",
  "MODEL_CHAT_23310",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING",
  "MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE",
  "MODEL_GOOGLE_GEMINI_2_5_PRO",
  "MODEL_PLACEHOLDER_M19",
  "MODEL_PLACEHOLDER_M9",
  "MODEL_PLACEHOLDER_M12",
]);

/** "Gemini 3 Pro (High)" → "Gemini 3 Pro" — strip a trailing parenthetical
 *  variant before pooling. */
export function normalizeAntigravityModelLabel(label: string): string {
  return label.trim().replace(/\s*\([^)]*\)\s*$/, "").trim();
}

/** Every Gemini model maps to the shared "Session" pool; every other model
 *  (Claude, GPT-OSS, …) to the "Claude" pool. */
export function antigravityPoolLabel(normalizedLabel: string): "Session" | "Claude" {
  return normalizedLabel.toLowerCase().includes("gemini") ? "Session" : "Claude";
}

function readLegacyConfig(value: AntigravityApiValue | undefined): LegacyModelConfig | null {
  const record = apiRecord(value);
  if (!record) return null;
  const labelText = apiText(record.label);
  const label = labelText !== null ? labelText.trim() : "";
  if (!label) return null;
  const modelOrAlias = apiRecord(record.modelOrAlias);
  const modelID = apiText(modelOrAlias?.model) ?? undefined;
  const quotaInfo = apiRecord(record.quotaInfo);
  const remaining = readNumber(quotaInfo?.remainingFraction);
  const resetTime = isoResetTime(quotaInfo?.resetTime);
  return {
    label,
    modelID,
    remainingFraction: remaining === null ? 0 : Math.max(0, Math.min(1, remaining)),
    resetTime,
  };
}

/** `GetUserStatus` → the per-model configs (`cascadeModelConfigData`), nil
 *  when absent. Exported for tests. */
export function parseAntigravityUserStatusConfigs(body: AntigravityApiValue | undefined): LegacyModelConfig[] | null {
  const envelope = apiRecord(body);
  const cascade = apiRecord(apiRecord(envelope?.userStatus)?.cascadeModelConfigData);
  const configs = apiArray(cascade?.clientModelConfigs);
  if (configs.length === 0) return null;
  const parsed = configs.map(readLegacyConfig).filter((config): config is LegacyModelConfig => config !== null);
  return parsed.length > 0 ? parsed : null;
}

/** `GetCommandModelConfigs` → the per-model configs (`clientModelConfigs`),
 *  nil when absent. Exported for tests. */
export function parseAntigravityCommandModelConfigs(body: AntigravityApiValue | undefined): LegacyModelConfig[] | null {
  const envelope = apiRecord(body);
  const configs = apiArray(envelope?.clientModelConfigs);
  if (configs.length === 0) return null;
  const parsed = configs.map(readLegacyConfig).filter((config): config is LegacyModelConfig => config !== null);
  return parsed.length > 0 ? parsed : null;
}

/** Collapse the legacy per-model configs into the two 5-hour pool meters,
 *  keeping each pool's worst remaining fraction — "Session" (Gemini) first,
 *  then "Claude". Empty when nothing usable pooled;
 *  the weekly meters are simply absent (legacy data is 5h-only). */
export function buildAntigravityLegacyWindows(configs: readonly LegacyModelConfig[]): QuotaWindow[] {
  const pooled = new Map<"Session" | "Claude", { consumed: number; resetsAt: string | null }>();
  for (const config of configs) {
    if (config.modelID && LEGACY_MODEL_BLACKLIST.has(config.modelID)) continue;
    const pool = antigravityPoolLabel(normalizeAntigravityModelLabel(config.label));
    const consumed = 1 - config.remainingFraction;
    const existing = pooled.get(pool);
    if (!existing || consumed > existing.consumed) {
      pooled.set(pool, { consumed, resetsAt: config.resetTime });
    }
  }
  const windows: QuotaWindow[] = [];
  for (const pool of ["Session", "Claude"] as const) {
    const entry = pooled.get(pool);
    if (!entry) continue;
    windows.push({
      id: pool === "Session" ? "legacy-gemini-5h" : "legacy-3p-5h",
      label: pool,
      used: percentValue(entry.consumed),
      limit: null,
      percent: entry.consumed,
      state: windowState(entry.consumed, entry.resetsAt),
      resetsAt: entry.resetsAt,
    });
  }
  return windows;
}

// ── the provider surface ─────────────────────────────────────────────────────

/** Offline presence check: is the user logged in? Login ≠ the language server
 *  running — the CLI's own OAuth token file on disk is the login signal
 *  (presence only, never read; a running language server also counts, since
 *  the app can be signed in without the CLI having written a token). The
 *  fetch itself still needs the server running and says so when it isn't. */
export async function detectAntigravityCredential(): Promise<boolean> {
  try {
    await fs.access(path.join(antigravityCliDir(), "antigravity-oauth-token"));
    return true;
  } catch {
    // No CLI token — fall through to the running-process signal.
  }
  return (await discoverLanguageServer()) !== null;
}

export async function fetchAntigravityQuota(options: {
  signal?: AbortSignal;
} = {}): Promise<{ report: QuotaProviderReport; retryAfterSeconds?: number }> {
  const signal = quotaRequestSignal(options.signal);
  try {
    const server = await discoverLanguageServer();
    if (!server) {
      return {
        report: emptyReport(
          "antigravity",
          "disconnected",
          "Antigravity is signed in, but its app isn't running right now — start the Antigravity app (or run `agy`) and try again.",
        ),
      };
    }

    // The quota summary is authoritative (merged pools + weekly windows), so
    // it goes first. A parsed summary — even one with zero usable buckets —
    // ends the probe: the legacy endpoints fabricate "fully used" from missing
    // quota info, so an authoritative answer must never fall through to them.
    // A 404 (build without the RPC) and a 2xx that isn't a summary payload are
    // the expected triggers for the legacy fallback.
    const summary = await callLs(server, "RetrieveUserQuotaSummary", signal);
    if (summary === null) {
      return {
        report: emptyReport(
          "antigravity",
          "transientFailure",
          "Couldn't reach Antigravity's language server on loopback.",
        ),
      };
    }
    if (summary.status >= 200 && summary.status < 300) {
      let windows: QuotaWindow[] | null = null;
      try {
        // SAFETY: the RPC layer hands back arbitrary JSON; every field is
        // revalidated through the decoders above before use.
        windows = parseAntigravityQuotaSummary(JSON.parse(summary.body) as AntigravityApiValue);
      } catch {
        windows = null;
      }
      if (windows !== null) {
        const planLabel = await fetchPlanLabel(server, signal);
        return {
          report: {
            provider: "antigravity",
            connection: "connected",
            primary: windows.find((window) => window.id === "gemini-weekly") ?? windows[0] ?? null,
            windows,
            spend: [],
            trend: [],
            planLabel,
            excludedModels: [],
            fetchedAt: Date.now(),
          },
        };
      }
    }

    // Legacy flow — the per-model endpoints collapse into the two 5-hour pool
    // meters; the weekly meters read "No data" on builds that only get here.
    const legacyWindows = await fetchLegacyWindows(server, signal);
    if (legacyWindows) {
      return {
        report: {
          provider: "antigravity",
          connection: "connected",
          primary: legacyWindows.windows.find((window) => window.id === "legacy-gemini-5h") ?? legacyWindows.windows[0] ?? null,
          windows: legacyWindows.windows,
          spend: [],
          trend: [],
          planLabel: legacyWindows.planLabel,
          excludedModels: [],
          fetchedAt: Date.now(),
        },
      };
    }

    return {
      report: emptyReport(
        "antigravity",
        "connected",
        "Antigravity exposed no quota pools for this build — updating the app (or `agy`) usually restores limits.",
      ),
    };
  } catch (error) {
    console.warn(`[quota] Antigravity quota unavailable: ${sanitizeError(error)}`);
    return {
      report: emptyReport("antigravity", "transientFailure", "Something went wrong reading Antigravity's limits."),
    };
  }
}

/** The plan label from GetUserStatus — independent of the window flow, so a
 *  failed plan lookup never voids a good quota read. */
async function fetchPlanLabel(
  server: AntigravityLanguageServer,
  signal?: AbortSignal,
): Promise<string | null> {
  const status = await callLs(server, "GetUserStatus", signal);
  if (status === null || status.status !== 200) return null;
  try {
    // SAFETY: the RPC layer hands back arbitrary JSON; every field is
    // revalidated through the decoders above before use.
    return parseAntigravityUserStatus(JSON.parse(status.body) as AntigravityApiValue);
  } catch {
    return null;
  }
}

/** The legacy per-model quota chain: `GetUserStatus`
 *  (`cascadeModelConfigData.clientModelConfigs`), then `GetCommandModelConfigs`
 *  (`clientModelConfigs`). Nil when neither yielded a usable pool. */
async function fetchLegacyWindows(
  server: AntigravityLanguageServer,
  signal?: AbortSignal,
): Promise<{ windows: QuotaWindow[]; planLabel: string | null } | null> {
  const status = await callLs(server, "GetUserStatus", signal);
  if (status !== null && status.status === 200) {
    let body: AntigravityApiValue | null = null;
    let planLabel: string | null = null;
    let configs: LegacyModelConfig[] | null = null;
    try {
      // SAFETY: the RPC layer hands back arbitrary JSON; every field is
      // revalidated through the decoders above before use.
      body = JSON.parse(status.body) as AntigravityApiValue;
      planLabel = parseAntigravityUserStatus(body);
      configs = parseAntigravityUserStatusConfigs(body);
    } catch {
      body = null;
    }
    if (body !== null && configs) {
      const windows = buildAntigravityLegacyWindows(configs);
      if (windows.length > 0) return { windows, planLabel };
    }
  }

  const commandConfigs = await callLs(server, "GetCommandModelConfigs", signal);
  if (commandConfigs === null || commandConfigs.status !== 200) return null;
  try {
    // SAFETY: the RPC layer hands back arbitrary JSON; every field is
    // revalidated through the decoders above before use.
    const configs = parseAntigravityCommandModelConfigs(JSON.parse(commandConfigs.body) as AntigravityApiValue);
    if (!configs) return null;
    const windows = buildAntigravityLegacyWindows(configs);
    return windows.length > 0 ? { windows, planLabel: null } : null;
  } catch {
    return null;
  }
}
