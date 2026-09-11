import { existsSync as fsExistsSync, readFileSync } from "node:fs";
import path from "node:path";

import { findOnPath } from "../antigravityAcpBinary.js";
import { userDataPath } from "../userDataDir.js";
import { LspAbortError, LspClient } from "./client.js";
import type { LspSpawnFn } from "./client.js";
import { clampInt, isJsonList, isRecord, jsonText, positiveInt } from "./json.js";
import {
  languageIdForFile as registryLanguageIdForFile,
  localBinCandidates,
  LSP_GLOBAL_CONFIG_FILENAME,
  mergeServerConfig,
  projectLspConfigPath,
  resolveServerBinary,
  serversForFile,
  TS_DEFAULT_SERVERS,
} from "./serverRegistry.js";
import type { ServerBinaryDeps } from "./serverRegistry.js";
import type {
  LspClientHandle,
  LspJsonObject,
  LspJsonValue,
  ServerConfig,
} from "./types.js";

// Pooled language-server processes: one client per `${command}:${cwd}`,
// started lazily on first use and reaped when idle.
//
// Config layers mirror the registry: bundled defaults, then the global file
// under the user-data directory, then the project file at .kone/lsp.json.
// Files are read through injected readers, so tests never touch the real
// machine; only the default readers hit the filesystem.

// Idle clients die after five minutes without traffic. Zero or a negative
// value disables reaping entirely.
export const DEFAULT_LSP_IDLE_TIMEOUT_MS = 5 * 60 * 1000;

// How long project-load and reference retries wait overall when the caller
// names no budget. Long enough for a cold index, short enough to stay inside
// a tool call.
export const DEFAULT_LSP_WARMUP_TIMEOUT_MS = 15_000;

// One settle probe runs this long at most; probes repeat with a short sleep
// between them until the overall budget is spent.
const SETTLE_PROBE_TIMEOUT_MS = 2000;
const SETTLE_PROBE_MIN_TIMEOUT_MS = 250;
const SETTLE_POLL_MS = 200;
const SETTLE_MAX_ATTEMPTS = 10;

// A references answer that names only the queried declaration usually means
// the server indexed it but has not finished the project yet: wait briefly
// and ask again, a few times at most, then return whatever the last answer
// held. A slow server delays the answer; it never fails it.
const REFERENCES_MAX_ATTEMPTS = 3;
const REFERENCES_RETRY_DELAY_MS = 250;

// The reaper wakes at half the idle timeout so a client idle just past the
// limit is collected promptly, but never more often than every 25ms and
// never less often than every 30s.
const REAP_INTERVAL_MIN_MS = 25;
const REAP_INTERVAL_MAX_MS = 30_000;

// ── errors ───────────────────────────────────────────────────────────────────

export class LspManagerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspManagerError";
  }
}

// No enabled server claims the file's extension. `disabledNames` names the
// servers that would have owned it had no config file switched them off, so
// the message can tell "nothing handles .md" apart from "you disabled it".
export class LspNoServerError extends LspManagerError {
  readonly filePath: string;
  readonly disabledNames: readonly string[];

  constructor(filePath: string, disabledNames: readonly string[]) {
    const disabled =
      disabledNames.length > 0 ? ` (disabled by config: ${disabledNames.join(", ")})` : "";
    super(`no language server handles "${filePath}"${disabled}`);
    this.name = "LspNoServerError";
    this.filePath = filePath;
    this.disabledNames = disabledNames;
  }
}

// The server's binary resolves nowhere. `searchedPaths` holds every local
// .bin slot that was checked (nearest first); PATH was checked after those,
// and the message says so.
export class LspServerStartError extends LspManagerError {
  readonly serverName: string;
  readonly command: string;
  readonly searchedPaths: readonly string[];

  constructor(serverName: string, command: string, searchedPaths: readonly string[]) {
    super(
      `language server "${serverName}" is not installed: ` +
        `binary "${command}" was not found in ${searchedPaths.length} local ` +
        `node_modules/.bin directories or on PATH`,
    );
    this.name = "LspServerStartError";
    this.serverName = serverName;
    this.command = command;
    this.searchedPaths = searchedPaths;
  }
}

// ── options ──────────────────────────────────────────────────────────────────

export interface LspGetClientOptions {
  cwd: string;
  filePath: string;
}

export interface LspEnsureLoadedOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface LspDeclarationTarget {
  uri: string;
  // Zero-based utf-16 offsets, exactly as the protocol reports them.
  line: number;
  character: number;
}

export interface LspReferencesRetryOptions {
  // Budget for each references request, not for the whole retry loop.
  timeoutMs?: number;
  signal?: AbortSignal;
  maxAttempts?: number;
  delayMs?: number;
}

export interface LspManagerOptions {
  defaults?: readonly ServerConfig[];
  binaryDeps?: ServerBinaryDeps;
  readTextFile?: (filePath: string) => string | null;
  userDataPathFn?: (...segments: string[]) => string;
  spawnProcess?: LspSpawnFn;
  killPid?: (pid: number | undefined) => Promise<void>;
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  defaultTimeoutMs?: number;
  idleTimeoutMs?: number;
}

interface LspPoolEntry {
  client: LspClient;
  lastActivity: number;
}

function defaultReadTextFile(filePath: string): string | null {
  try {
    return readFileSync(filePath, "utf8");
  } catch {
    // A missing or unreadable config file means "no overrides", not failure.
    return null;
  }
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export class LspManager {
  private readonly defaults: readonly ServerConfig[];
  private readonly binaryDeps: ServerBinaryDeps;
  private readonly readTextFile: (filePath: string) => string | null;
  private readonly userDataPathFn: (...segments: string[]) => string;
  private readonly spawnProcess: LspSpawnFn | undefined;
  private readonly killPid: ((pid: number | undefined) => Promise<void>) | undefined;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly defaultTimeoutMs: number | undefined;
  private idleTimeoutMs: number;
  private readonly pool = new Map<string, LspPoolEntry>();
  private readonly starting = new Map<string, Promise<LspPoolEntry>>();
  private reapTimer: ReturnType<typeof setInterval> | null = null;
  private disposed = false;

  constructor(options: LspManagerOptions = {}) {
    this.defaults = options.defaults ?? TS_DEFAULT_SERVERS;
    // findOnPath is the shared PATH search; the local .bin walk stays in the
    // registry's resolver, which receives these deps.
    this.binaryDeps = options.binaryDeps ?? {
      existsSync: fsExistsSync,
      lookupOnPath: (command) => findOnPath(command),
    };
    this.readTextFile = options.readTextFile ?? defaultReadTextFile;
    this.userDataPathFn = options.userDataPathFn ?? userDataPath;
    this.spawnProcess = options.spawnProcess;
    this.killPid = options.killPid;
    this.clock = options.clock ?? Date.now;
    this.sleep = options.sleep ?? defaultSleep;
    this.defaultTimeoutMs = options.defaultTimeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DEFAULT_LSP_IDLE_TIMEOUT_MS;
  }

  // Resolve, start (lazily), and return the pooled client for a file. Two
  // callers naming the same command and directory share one process; the
  // first call starts it and concurrent calls join the same startup.
  async getClient(options: LspGetClientOptions): Promise<LspClient> {
    if (this.disposed) {
      throw new LspManagerError("language-server manager is shut down");
    }
    const cwd = path.resolve(options.cwd);
    const servers = this.effectiveServers(cwd);
    const candidates = serversForFile(servers, options.filePath);
    const server = candidates.find((candidate) => candidate.disabled !== true);
    if (server === undefined) {
      throw new LspNoServerError(
        options.filePath,
        candidates.map((candidate) => candidate.name),
      );
    }
    const rootPath = discoverProjectRoot(
      cwd,
      options.filePath,
      server.rootMarkers,
      this.binaryDeps.existsSync,
    );
    return this.pooledClient(server, cwd, rootPath);
  }

  // The pooled client for project-wide work that names no file, such as a
  // workspace/symbol search. The first enabled server serves it; nothing is
  // probed on disk to pick one, since ownership is already answered by the
  // registry's extension map.
  async getWorkspaceClient(cwd: string): Promise<LspClient> {
    if (this.disposed) {
      throw new LspManagerError("language-server manager is shut down");
    }
    const root = path.resolve(cwd);
    const servers = this.effectiveServers(root);
    const server = servers.find((candidate) => candidate.disabled !== true);
    if (server === undefined) {
      throw new LspNoServerError(
        root,
        servers.map((candidate) => candidate.name),
      );
    }
    const rootPath = discoverProjectRootFromDir(root, server.rootMarkers, this.binaryDeps.existsSync);
    return this.pooledClient(server, root, rootPath);
  }

  // The didOpen language tag for a file, from the registry's extension
  // ownership over the effective servers — the same servers startup resolves
  // against, so the tag and the owner never disagree.
  languageIdForFile(cwd: string, filePath: string): string {
    return registryLanguageIdForFile(this.effectiveServers(path.resolve(cwd)), filePath);
  }

  // One pooled client per command plus directory: the first call starts it
  // and concurrent calls join the same startup.
  private async pooledClient(
    server: ServerConfig,
    cwd: string,
    rootPath: string,
  ): Promise<LspClient> {
    const key = `${server.command}:${cwd}`;
    const live = this.pool.get(key);
    if (live !== undefined) {
      live.lastActivity = this.clock();
      return live.client;
    }
    const inFlight = this.starting.get(key);
    if (inFlight !== undefined) {
      const entry = await inFlight;
      entry.lastActivity = this.clock();
      return entry.client;
    }
    const started = this.startClient(key, server, cwd, rootPath);
    this.starting.set(key, started);
    try {
      const entry = await started;
      return entry.client;
    } finally {
      this.starting.delete(key);
    }
  }

  // Wait for a freshly started server to finish its initial index pass. The
  // probe is a cheap workspace/symbol query: success means the server is
  // answering from a settled index. An unsettled server burns the whole
  // budget and then proceeds anyway — slowness delays, never fails — while
  // an aborted wait rejects immediately.
  async ensureProjectLoaded(
    client: LspClientHandle,
    options: LspEnsureLoadedOptions = {},
  ): Promise<void> {
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_LSP_WARMUP_TIMEOUT_MS);
    // Bounded attempts that fit inside the budget: at most one probe per
    // second of budget (capped), each probe timed so attempts plus sleeps
    // land near the budget instead of multiplying past it.
    const attempts = Math.min(
      SETTLE_MAX_ATTEMPTS,
      Math.max(1, Math.ceil(timeoutMs / 1000)),
    );
    const probeTimeoutMs = Math.min(
      SETTLE_PROBE_TIMEOUT_MS,
      Math.max(SETTLE_PROBE_MIN_TIMEOUT_MS, Math.floor(timeoutMs / attempts)),
    );
    await this.withPoll(
      { signal: options.signal, attempts, delayMs: SETTLE_POLL_MS, abortMethod: "workspace/symbol" },
      async () => {
        try {
          await client.request("workspace/symbol", { query: "" }, probeTimeoutMs);
          return true;
        } catch {
          // Any failure (timeout, unsupported method, dead server) reads as
          // "not settled yet": the poll sleeps and probes again. The loop is
          // bounded by the attempt count, so a server that never settles
          // still returns.
          return false;
        }
      },
      (settled) => settled,
    );
  }

  // Ask for references, retrying when the answer holds only the queried
  // declaration: on a project-aware server that shape usually means the file
  // is indexed but the project pass has not reached it yet. Answers with any
  // other item count return immediately; after the last attempt the final
  // answer returns whatever it holds.
  async referencesWithRetry(
    client: LspClientHandle,
    params: LspJsonObject,
    declaration: LspDeclarationTarget,
    options: LspReferencesRetryOptions = {},
  ): Promise<LspJsonValue> {
    const attempts = clampInt(options.maxAttempts, REFERENCES_MAX_ATTEMPTS, 1, 10);
    const delayMs = positiveInt(options.delayMs, REFERENCES_RETRY_DELAY_MS);
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_LSP_WARMUP_TIMEOUT_MS);
    return this.withPoll(
      { signal: options.signal, attempts, delayMs, abortMethod: "textDocument/references" },
      () => client.request("textDocument/references", params, timeoutMs),
      (value) => !isOnlyDeclaration(value, declaration),
    );
  }

  // One bounded poll for the two waits above: run the attempt, stop when it
  // settles, sleep between attempts. Abortion rejects immediately; anything
  // else returns the last answer once the attempts run out.
  private async withPoll<T>(
    plan: { signal?: AbortSignal; attempts: number; delayMs: number; abortMethod: string },
    run: () => Promise<T>,
    done: (value: T) => boolean,
  ): Promise<T> {
    let last: T | undefined = undefined;
    for (let attempt = 1; attempt <= plan.attempts; attempt += 1) {
      if (plan.signal?.aborted === true) {
        throw new LspAbortError(plan.abortMethod);
      }
      const value = await run();
      last = value;
      if (attempt >= plan.attempts || done(value)) return value;
      await this.sleep(plan.delayMs);
    }
    // Every call site clamps attempts to at least one, so falling out means
    // the plan itself named no attempts — a caller bug, not a server outcome.
    if (last === undefined) {
      throw new LspManagerError("poll ran no attempts");
    }
    return last;
  }

  // Start the single idle-reap timer with a fresh timeout. Zero or a
  // negative value clears the timer and disables reaping. Repeated calls
  // replace the timer; there is only ever one.
  reap(idleTimeoutMs: number = DEFAULT_LSP_IDLE_TIMEOUT_MS): void {
    this.stopReapTimer();
    this.idleTimeoutMs = idleTimeoutMs;
    if (!Number.isFinite(idleTimeoutMs) || idleTimeoutMs <= 0) return;
    const interval = Math.min(
      Math.max(Math.floor(idleTimeoutMs / 2), REAP_INTERVAL_MIN_MS),
      REAP_INTERVAL_MAX_MS,
    );
    const timer = setInterval(() => {
      void this.sweepIdle();
    }, interval);
    // The timer must never hold the process open on its own: shutdown paths
    // call disposeAll, but a forgotten manager should still let go.
    timer.unref();
    this.reapTimer = timer;
  }

  // Collect every client idle longer than the reap timeout. Stale entries
  // leave the pool before their close runs, so a slow shutdown cannot hand a
  // dying client to a concurrent caller.
  async sweepIdle(now?: number): Promise<void> {
    if (!Number.isFinite(this.idleTimeoutMs) || this.idleTimeoutMs <= 0) return;
    const at = now ?? this.clock();
    const stale: LspPoolEntry[] = [];
    for (const [key, entry] of this.pool) {
      if (at - entry.lastActivity >= this.idleTimeoutMs) {
        this.pool.delete(key);
        stale.push(entry);
      }
    }
    await this.closeEntries(stale);
  }

  // Shut everything down: stop the reap timer and close every pooled client.
  // Safe to call more than once; later getClient calls are refused.
  async disposeAll(): Promise<void> {
    this.disposed = true;
    this.stopReapTimer();
    const entries = [...this.pool.values()];
    this.pool.clear();
    await this.closeEntries(entries);
  }

  // Best-effort close over pooled entries: a wedged server already met the
  // tree-kill inside close, so there is nothing left to report either way.
  private async closeEntries(entries: Iterable<LspPoolEntry>): Promise<void> {
    for (const entry of entries) {
      try {
        await entry.client.close();
      } catch {
        // Best effort, as above: close owns the tree-kill fallback.
      }
    }
  }

  private stopReapTimer(): void {
    if (this.reapTimer !== null) {
      clearInterval(this.reapTimer);
      this.reapTimer = null;
    }
  }

  private effectiveServers(cwd: string): readonly ServerConfig[] {
    return mergeServerConfig(this.defaults, this.readGlobalRaw(), this.readProjectRaw(cwd));
  }

  private readGlobalRaw(): LspJsonValue {
    let configPath: string;
    try {
      configPath = this.userDataPathFn(LSP_GLOBAL_CONFIG_FILENAME);
    } catch {
      // No user-data directory was injected (or it is unreadable): behave as
      // if the global file were absent rather than failing startup.
      return null;
    }
    return this.readJsonFile(configPath);
  }

  private readProjectRaw(cwd: string): LspJsonValue {
    return this.readJsonFile(projectLspConfigPath(cwd));
  }

  private readJsonFile(filePath: string): LspJsonValue {
    const text = this.readTextFile(filePath);
    if (text === null) return null;
    try {
      // SAFETY: the parsed document is treated as untrusted data; the
      // registry's decoders validate its structure before any field is used.
      return JSON.parse(text) as LspJsonValue;
    } catch {
      // A corrupt config file disables no server and enables none: fall back
      // to the lower layers rather than refusing to start.
      return null;
    }
  }

  private async startClient(
    key: string,
    server: ServerConfig,
    cwd: string,
    rootPath: string,
  ): Promise<LspPoolEntry> {
    const binary = resolveServerBinary(server, cwd, this.binaryDeps);
    if (binary === null) {
      throw new LspServerStartError(server.name, server.command, searchedBinaryPaths(server, cwd));
    }
    let entry: LspPoolEntry | null = null;
    const client = new LspClient({
      serverName: server.name,
      defaultTimeoutMs: this.defaultTimeoutMs,
      spawnProcess: this.spawnProcess,
      killPid: this.killPid,
      onActivity: () => {
        if (entry !== null) entry.lastActivity = this.clock();
      },
    });
    await client.start(binary, [...server.args], rootPath, {
      initializationOptions: server.initOptions,
      settings: server.settings,
    });
    entry = { client, lastActivity: this.clock() };
    if (this.disposed) {
      // Lost a race with shutdown: close the newcomer instead of pooling it.
      await entry.client.close();
      throw new LspManagerError("language-server manager is shut down");
    }
    this.pool.set(key, entry);
    return entry;
  }
}

// Every place the resolver looked for a bare command: the local .bin walk,
// nearest first. Path-shaped commands never consult that walk — they name
// one file — so the single resolved candidate is the whole story.
function searchedBinaryPaths(server: ServerConfig, cwd: string): readonly string[] {
  if (server.command.includes("/") || server.command.includes(path.sep)) {
    const candidate = path.isAbsolute(server.command)
      ? server.command
      : path.join(path.resolve(cwd), server.command);
    return [candidate];
  }
  return localBinCandidates(cwd, server.command, process.platform);
}

// Walk up from the queried file to the nearest directory holding a root
// marker; fall back to the caller's directory when nothing marks a root.
function discoverProjectRoot(
  cwd: string,
  filePath: string,
  markers: readonly string[],
  existsSync: (candidatePath: string) => boolean,
): string {
  return walkUpForMarkers(path.dirname(path.resolve(filePath)), markers, existsSync, cwd);
}

// Walk up from the project directory itself, for work that names no file:
// the nearest marked ancestor wins, else the directory itself.
function discoverProjectRootFromDir(
  cwd: string,
  markers: readonly string[],
  existsSync: (candidatePath: string) => boolean,
): string {
  const root = path.resolve(cwd);
  return walkUpForMarkers(root, markers, existsSync, root);
}

function walkUpForMarkers(
  startDir: string,
  markers: readonly string[],
  existsSync: (candidatePath: string) => boolean,
  fallback: string,
): string {
  if (markers.length === 0) return fallback;
  let dir = startDir;
  for (;;) {
    for (const marker of markers) {
      if (existsSync(path.join(dir, marker))) return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return fallback;
    dir = parent;
  }
}

// True only for the "indexed file, unindexed project" shape: exactly one
// location, and it is the declaration that was asked about. Anything else —
// empty, several, or one elsewhere — is a complete answer already.
function isOnlyDeclaration(value: LspJsonValue, declaration: LspDeclarationTarget): boolean {
  if (!isJsonList(value) || value.length !== 1) return false;
  const only = value[0];
  if (!isRecord(only)) return false;
  if (jsonText(only.uri) !== declaration.uri) return false;
  const range = isRecord(only.range) ? only.range : null;
  const start = range !== null && isRecord(range.start) ? range.start : null;
  if (start === null) return false;
  return start.line === declaration.line && start.character === declaration.character;
}
