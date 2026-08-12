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
export type AntigravityLanguageServer = {
  csrfToken?: string;
  /** Candidate listening ports, from `--https_server_port` /
   *  `--extension_server_port` flags or lsof on the owning pid. */
  ports: number[];
  /** The pid the ports were resolved from (agy path) — informational. */
  pid?: number;
};

const execFileAsync = promisify(execFile);

function isLikelyCsrfToken(value: string): boolean {
  return value.length >= 16 && /^[A-Za-z0-9._~:/+=-]+$/.test(value);
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

/** Extract the app language server's CSRF token + port flags from one process
 *  command line, when it is one (contains `language_server` and an
 *  antigravity marker). Export for tests. */
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
  if (ports.length === 0) return null;
  return { csrfToken, ports };
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

/** Find the bare `agy` CLI process — it hosts the same language-server RPC
 *  port flags; the listening ports come from lsof on the pid. */
function findAgyProcess(lines: readonly string[]): { pid: number; command: string } | null {
  for (const line of lines) {
    const match = line.trim().match(/^(\d+)\s+(.+)$/);
    if (!match) continue;
    const name = processExecutableName(match[2]!).toLowerCase();
    if (name === "agy" || name.endsWith("/agy") || name === "agy.exe") {
      const pid = Number(match[1]);
      if (Number.isInteger(pid) && pid > 0) return { pid, command: match[2]! };
    }
  }
  return null;
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

 *  app's `language_server` process first (richest — csrf + explicit ports),
 *  then the bare `agy` process (in-process RPC, ports via lsof). */
async function discoverLanguageServer(): Promise<AntigravityLanguageServer | null> {
  if (process.platform === "win32") {
    const script = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
      "Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -and $_.CommandLine -like '*language_server*' -and ($_.CommandLine -like '*antigravity*' -or $_.CommandLine -like '*agy*') } | ForEach-Object { $_.CommandLine }",
    ].join("; ");
    const output = await runCommand("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script,
    ]);
    const ls = parseAntigravityLanguageServerLines(output?.split(/\r?\n/) ?? []);
    if (ls) return ls;
    // Windows agy: name-query for the process, then its listening ports.
    const agyScript = [
      "$ErrorActionPreference = 'SilentlyContinue'",
      "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'agy.exe' -or $_.Name -eq 'agy' } | ForEach-Object { $_.ProcessId }",
    ].join("; ");
    const agyOutput = await runCommand("powershell.exe", [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", agyScript,
    ]);
    const pid = Number(agyOutput?.trim().split(/\r?\n/)[0] ?? "");
    if (Number.isInteger(pid) && pid > 0) {
      const portScript = `Get-NetTCPConnection -State Listen -OwningProcess ${pid} | Select-Object -ExpandProperty LocalPort`;
      const portsOutput = await runCommand("powershell.exe", [
        "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", portScript,
      ]);
      const ports = (portsOutput ?? "")
        .split(/\r?\n/)
        .map((line) => Number(line.trim()))
        .filter((port) => Number.isInteger(port) && port > 0 && port <= 65535);
      if (ports.length > 0) return { ports, pid };
    }
    return null;
  }

  const psOutput = await runCommand("ps", ["-ax", "-o", "pid=,command="]);
  if (psOutput === null) return null;
  const lines = psOutput.split("\n");

  const ls = parseAntigravityLanguageServerLines(lines);
  if (ls) return ls;

  const agy = findAgyProcess(lines);
  if (!agy) return null;
  const lsof = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(agy.pid)]);
  const ports = lsof === null ? [] : parseListeningPorts(lsof);
  if (ports.length === 0) return null;
  return { ports, pid: agy.pid };
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
    const req = (scheme === "https" ? https : http).request(
      {
        hostname: "127.0.0.1",
        port,
        path: `/${LS_SERVICE}/${method}`,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Connect-Protocol-Version": "1",
          // The agy in-process server needs no CSRF token — only the app's
          // language_server process has one.
          ...(server.csrfToken ? { "x-codeium-csrf-token": server.csrfToken } : {}),
          "Content-Length": Buffer.byteLength(body),
        },
        // The language server serves a self-signed cert; the endpoint is
        // loopback-only, so trusting it is the point.
        ...(scheme === "https" ? { rejectUnauthorized: false } : {}),
        timeout: LS_TIMEOUT_MS,
      },
      (res) => {
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
      },
    );
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

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
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
 *  (`{"groups": …}`). Nil means "not a summary" — the caller reports failure
 *  rather than fabricating. */
export function parseAntigravityQuotaSummary(body: unknown): QuotaWindow[] | null {
  const envelope = asRecord(body);
  const groups = envelope ? (asArray(envelope.groups).length > 0 ? asArray(envelope.groups) : asArray(asRecord(envelope.response)?.groups)) : [];
  if (groups.length === 0) return null;

  const pooled = new Map<string, { consumed: number; resetsAt: string | null }>();
  for (const group of groups) {
    for (const bucket of asArray(asRecord(group)?.buckets)) {
      const record = asRecord(bucket);
      if (!record) continue;
      const bucketId = typeof record.bucketId === "string" ? record.bucketId : undefined;
      if (!bucketId || !SUMMARY_BUCKETS.some((spec) => spec.bucketId === bucketId)) continue;
      if (pooled.has(bucketId)) continue; // duplicate id — first one wins
      const remaining = readNumber(record.remainingFraction);
      if (remaining === null) continue;
      const clamped = Math.max(0, Math.min(1, remaining));
      const resetsAt =
        typeof record.resetTime === "string" && !Number.isNaN(Date.parse(record.resetTime))
          ? new Date(record.resetTime).toISOString()
          : null;
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

/** `GetUserStatus` → the plan label (prefers Google's own `userTier`). */
export function parseAntigravityUserStatus(body: unknown): string | null {
  const envelope = asRecord(body);
  const userStatus = asRecord(envelope?.userStatus);
  const tier = asRecord(userStatus?.userTier);
  const planInfo = asRecord(asRecord(userStatus?.planStatus)?.planInfo);
  const plan =
    typeof tier?.name === "string"
      ? tier.name
      : typeof planInfo?.planName === "string"
        ? (planInfo.planName as string)
        : null;
  return formatAntigravityPlan(plan);
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
    if (summary.status !== 200) {
      return {
        report: emptyReport(
          "antigravity",
          summary.status >= 400 && summary.status < 500 ? "terminalFailure" : "transientFailure",
          `Antigravity's language server returned ${summary.status}.`,
        ),
      };
    }
    let windows: QuotaWindow[];
    try {
      const parsed = parseAntigravityQuotaSummary(JSON.parse(summary.body) as unknown);
      if (parsed === null) {
        return {
          report: emptyReport(
            "antigravity",
            "transientFailure",
            "Antigravity's quota response didn't include usable pools.",
          ),
        };
      }
      windows = parsed;
    } catch {
      return {
        report: emptyReport(
          "antigravity",
          "transientFailure",
          "Antigravity's quota response wasn't valid JSON.",
        ),
      };
    }

    // The plan comes from an independent GetUserStatus call; a failed plan
    // lookup just leaves the label blank.
    let planLabel: string | null = null;
    const status = await callLs(server, "GetUserStatus", signal);
    if (status !== null && status.status === 200) {
      try {
        planLabel = parseAntigravityUserStatus(JSON.parse(status.body) as unknown);
      } catch {
        planLabel = null;
      }
    }

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
  } catch (error) {
    console.warn(`[quota] Antigravity quota unavailable: ${sanitizeError(error)}`);
    return {
      report: emptyReport("antigravity", "transientFailure", "Something went wrong reading Antigravity's limits."),
    };
  }
}
