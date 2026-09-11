import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

import { killTree } from "../spawn.js";
import { decodeDiagnostic } from "./decode.js";
import { isJsonList, isJsonNumber, isRecord, jsonText, positiveInt } from "./json.js";
import type {
  LspClientHandle,
  LspDiagnostic,
  LspJsonObject,
  LspJsonValue,
  LspRequestOptions,
} from "./types.js";

// Framed stdio client for one language server process.
//
// runStreaming in spawn.ts cannot carry this traffic: it closes stdin and
// delivers whole buffered runs, while a server needs an open stdin pipe for
// the session's lifetime. So this client spawns with piped stdio directly and
// frames every message with Content-Length headers, per the protocol.
// Shutdown reuses the shared tree-kill, so a server (and anything it forked)
// never outlives its client.

// How long one request waits for its response when the caller names no
// timeout. Language servers usually answer in milliseconds; fifteen seconds
// is room for a cold index without hanging a tool call past its own budget.
export const DEFAULT_LSP_REQUEST_TIMEOUT_MS = 15_000;

// A frame bigger than this is not a frame: without a ceiling, garbage bytes
// with no header terminator would grow the read buffer without bound.
const MAX_FRAME_BYTES = 8 * 1024 * 1024;

// Server-to-client request that cancels one in-flight client request.
const CANCEL_METHOD = "$/cancelRequest";

// How long close waits for the server to exit on its own after the exit
// notification before the tree-kill fires. The server needs a turn to read
// exit and stop itself; killing first strands the notification unread in
// the pipe and turns a graceful shutdown into a signal every time.
const EXIT_GRACE_MS = 1500;

// ── errors ───────────────────────────────────────────────────────────────────

export class LspClientError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LspClientError";
  }
}

// The server answered with an error object instead of a result.
export class LspRequestError extends LspClientError {
  readonly method: string;
  readonly code: number;

  constructor(method: string, code: number, message: string) {
    super(`lsp request "${method}" failed: ${message}`);
    this.name = "LspRequestError";
    this.method = method;
    this.code = code;
  }
}

// No response arrived before the per-request budget ran out.
export class LspTimeoutError extends LspClientError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`lsp request "${method}" timed out after ${timeoutMs}ms`);
    this.name = "LspTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
  }
}

// The caller's AbortSignal fired: the server got $/cancelRequest and the
// pending promise rejects instead of resolving late. Named AbortError so the
// gateway registry's cancellation passthrough recognizes it without any
// per-call-site rewrap: a cancelled call vanishes with the caller rather
// than reading as a crash.
export class LspAbortError extends LspClientError {
  readonly method: string;

  constructor(method: string) {
    super(`lsp request "${method}" was aborted`);
    this.name = "AbortError";
    this.method = method;
  }
}

// A request (or document open) landed while the server was not up: never
// started, already closed, or its process gone.
export class LspNotRunningError extends LspClientError {
  constructor(serverName: string, detail: string) {
    super(`language server "${serverName}" is not running (${detail})`);
    this.name = "LspNotRunningError";
  }
}

// ── json-rpc ids ─────────────────────────────────────────────────────────────

// A json-rpc id is a string or a number; anything else (null included) cannot
// address a pending request.
function asRpcId(value: LspJsonValue | undefined): string | number | null {
  const text = jsonText(value);
  if (text !== null) return text;
  return isJsonNumber(value) ? value : null;
}

// ── client ───────────────────────────────────────────────────────────────────

export interface LspClientStartOptions {
  initializationOptions?: LspJsonObject;
  // Answers for the server's workspace/configuration requests. The
  // integration never applies edits, so configuration is the only
  // server-to-client question with a useful answer.
  settings?: LspJsonObject;
  initializeTimeoutMs?: number;
}

// Test seam around process creation: the default spawns a real child with
// piped stdio in its own process group, so the tree-kill reaches servers the
// binary forks. Tests use the default and drive a fake server script.
export type LspSpawnFn = (
  binary: string,
  args: readonly string[],
  opts: { cwd: string },
) => ChildProcessWithoutNullStreams;

function defaultSpawn(
  binary: string,
  args: readonly string[],
  opts: { cwd: string },
): ChildProcessWithoutNullStreams {
  return spawn(binary, args, {
    cwd: opts.cwd,
    env: process.env,
    windowsHide: true,
    // Own process group on POSIX so shutdown signals the whole tree, not
    // just the server parent.
    detached: process.platform !== "win32",
    stdio: ["pipe", "pipe", "pipe"],
  });
}

export interface LspClientOptions {
  serverName: string;
  defaultTimeoutMs?: number;
  spawnProcess?: LspSpawnFn;
  killPid?: (pid: number | undefined) => Promise<void>;
  // Fires after every request and notification the client sends, so the
  // manager pooling this client can stamp activity without wrapping it.
  onActivity?: () => void;
}

interface PendingLspRequest {
  method: string;
  resolve: (value: LspJsonValue) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  signal: AbortSignal | null;
  onAbort: (() => void) | null;
}

// A named contract rather than an inline literal, so the narrowing work
// above is not discarded at the return boundary.
interface LspResponseErrorText {
  code: number;
  message: string;
}

// The settled per-call plan for one request: how long to wait and which
// signal cancels it. Named so the split below keeps its return contract.
interface LspRequestPlan {
  timeoutMs: number;
  signal: AbortSignal | null;
}

// Split the request()'s third argument into its two meanings: a bare number
// is a timeout, a record carries a timeout plus an abort signal. The branch
// is decided by constructor because the union's members share no tag.
function splitRequestOptions(
  timeoutMsOrOptions: number | LspRequestOptions | undefined,
  fallbackMs: number,
): LspRequestPlan {
  if (timeoutMsOrOptions instanceof Object) {
    return {
      timeoutMs: positiveInt(timeoutMsOrOptions.timeoutMs, fallbackMs),
      signal: timeoutMsOrOptions.signal ?? null,
    };
  }
  return { timeoutMs: positiveInt(timeoutMsOrOptions, fallbackMs), signal: null };
}

function errorMessageOf(responseError: LspJsonObject): LspResponseErrorText {
  const code = isJsonNumber(responseError.code) ? responseError.code : -32000;
  const messageRaw = jsonText(responseError.message);
  return { code, message: messageRaw ?? "unknown language-server error" };
}

export class LspClient implements LspClientHandle {
  readonly serverName: string;
  private readonly defaultTimeoutMs: number;
  private readonly spawnProcess: LspSpawnFn;
  private readonly killPid: (pid: number | undefined) => Promise<void>;
  private readonly onActivity: (() => void) | null;

  private child: ChildProcessWithoutNullStreams | null = null;
  private projectRoot: string | null = null;
  private settings: LspJsonObject | null = null;
  private initializeResult: LspJsonObject | null = null;
  private nextId = 1;
  private readonly pending = new Map<string | number, PendingLspRequest>();
  private incoming = Buffer.alloc(0);
  private closed = false;
  private exited = false;
  private spawnFailure: string | null = null;
  private closePromise: Promise<void> | null = null;
  private readonly openedVersions = new Map<string, number>();
  private readonly diagnostics = new Map<string, readonly LspDiagnostic[]>();
  private readonly registeredMethods = new Set<string>();
  private droppedFrames = 0;

  constructor(options: LspClientOptions) {
    this.serverName = options.serverName;
    this.defaultTimeoutMs = positiveInt(options.defaultTimeoutMs, DEFAULT_LSP_REQUEST_TIMEOUT_MS);
    this.spawnProcess = options.spawnProcess ?? defaultSpawn;
    this.killPid = options.killPid ?? ((pid) => killTree(pid));
    this.onActivity = options.onActivity ?? null;
  }

  get rootPath(): string {
    return this.projectRoot ?? "";
  }

  // The server's answer to initialize, when it was a record. Slice 3 reads
  // capabilities off this instead of re-asking.
  get serverCapabilities(): LspJsonObject | null {
    return this.initializeResult;
  }

  get droppedFrameCount(): number {
    return this.droppedFrames;
  }

  // Method names the server registered via client/registerCapability, kept
  // so later slices can tell which dynamic features the server claimed.
  get serverRegisteredMethods(): readonly string[] {
    return [...this.registeredMethods];
  }

  isRunning(): boolean {
    return !this.closed && !this.exited && this.child !== null;
  }

  // Spawn the server and run the initialize handshake. A failed handshake
  // tears the child down before throwing, so a half-started server never
  // lingers past the rejection.
  async start(
    binary: string,
    args: readonly string[],
    rootPath: string,
    init?: LspClientStartOptions,
  ): Promise<void> {
    if (this.child !== null) {
      throw new LspClientError(`language server "${this.serverName}" is already started`);
    }
    const child = this.spawnProcess(binary, args, { cwd: rootPath });
    this.child = child;
    this.projectRoot = rootPath;
    this.settings = init?.settings ?? null;
    child.stdout.on("data", (chunk: Buffer) => this.handleStdoutChunk(chunk));
    // Stderr carries server logs, never frames: drain it so a chatty server
    // cannot block on a full pipe, and keep nothing.
    child.stderr.on("data", () => {
      // Drained and discarded; the comment above is the whole policy.
    });
    child.stdin.on("error", () => this.handleExit());
    child.on("error", (error: Error) => {
      this.spawnFailure = error.message;
      this.handleExit();
    });
    child.on("close", () => this.handleExit());

    const rootUri = pathToFileURL(rootPath).toString();
    const capabilities: LspJsonObject = {
      textDocument: {
        hover: { contentFormat: ["markdown", "plaintext"] },
        definition: { linkSupport: true },
        references: {},
        documentSymbol: { hierarchicalDocumentSymbolSupport: true },
        rename: { prepareSupport: true },
        publishDiagnostics: { relatedInformation: true },
      },
      workspace: {
        // Configuration is advertised because the client answers
        // workspace/configuration from its stored settings below.
        configuration: true,
        workspaceFolders: true,
        fileOperations: { dynamicRegistration: false, willRename: true, didRename: true },
      },
    };
    const params: LspJsonObject = {
      processId: process.pid,
      rootUri,
      capabilities,
      workspaceFolders: [{ uri: rootUri, name: basename(rootPath) }],
    };
    if (init?.initializationOptions !== undefined) {
      params.initializationOptions = init.initializationOptions;
    }
    try {
      const timeoutMs = positiveInt(init?.initializeTimeoutMs, this.defaultTimeoutMs);
      const result = await this.sendRequest("initialize", params, timeoutMs, null);
      this.initializeResult = isRecord(result) ? result : null;
      this.sendNotification("initialized", {});
    } catch (error) {
      // The handshake failed (timeout, error response, dead child): kill the
      // process before surfacing, so the caller never inherits an orphan.
      await this.close();
      const detail = error instanceof Error ? error.message : "unknown error";
      const spawnDetail = this.spawnFailure ?? detail;
      throw new LspClientError(
        `language server "${this.serverName}" failed to initialize: ${spawnDetail}`,
      );
    }
  }

  request(method: string, params: LspJsonValue, timeoutMs: number): Promise<LspJsonValue>;
  request(method: string, params: LspJsonValue, options?: LspRequestOptions): Promise<LspJsonValue>;
  async request(
    method: string,
    params: LspJsonValue,
    timeoutMsOrOptions?: number | LspRequestOptions,
  ): Promise<LspJsonValue> {
    if (!this.isRunning()) {
      throw new LspNotRunningError(this.serverName, this.describeDown());
    }
    const split = splitRequestOptions(timeoutMsOrOptions, this.defaultTimeoutMs);
    if (split.signal?.aborted === true) {
      throw new LspAbortError(method);
    }
    return this.sendRequest(method, params, split.timeoutMs, split.signal);
  }

  // One-way message: never throws, never waits. Drops silently when the
  // server is gone — a notification carries no promise to break.
  notify(method: string, params: LspJsonValue): void {
    if (!this.isRunning()) return;
    this.sendNotification(method, params);
  }

  // Tell the server a document is open at a version the integration owns.
  // Versions only move forward per uri, so a reopened document never reuses
  // a version the server already saw.
  openDocument(uri: string, languageId: string, text: string): void {
    if (!this.isRunning()) return;
    const version = (this.openedVersions.get(uri) ?? 0) + 1;
    this.openedVersions.set(uri, version);
    this.sendNotification("textDocument/didOpen", {
      textDocument: { uri, languageId, version, text },
    });
  }

  // The latest pushed diagnostics for a uri, or an empty list when the
  // server never reported any. A copy, so callers cannot mutate the cache.
  getDiagnostics(uri: string): readonly LspDiagnostic[] {
    return [...(this.diagnostics.get(uri) ?? [])];
  }

  // Shutdown handshake then process teardown, safe to call any number of
  // times. The shutdown request gets a short budget of its own and never
  // blocks teardown: a hung server still meets the tree-kill.
  close(): Promise<void> {
    if (this.closePromise === null) {
      this.closePromise = this.doClose();
    }
    return this.closePromise;
  }

  private async doClose(): Promise<void> {
    this.closed = true;
    if (this.child !== null && !this.exited) {
      try {
        await this.sendRequest("shutdown", null, 2000, null);
      } catch {
        // A dead or hung server skips the polite handshake; the exit
        // notification and tree-kill below finish the job.
      }
      this.sendNotification("exit", null);
      await this.waitForExit(EXIT_GRACE_MS);
    }
    await this.killPid(this.child?.pid);
    this.failAllPending(new LspNotRunningError(this.serverName, "client closed"));
  }

  // Resolve when the child closes, or after the grace budget — whichever
  // comes first — so close never hangs on a server that ignores exit.
  private waitForExit(timeoutMs: number): Promise<void> {
    const stopped = this.child;
    if (stopped === null || this.exited) return Promise.resolve();
    const live: ChildProcessWithoutNullStreams = stopped;
    return new Promise((resolve) => {
      const timer = setTimeout(finish, timeoutMs);
      function finish(): void {
        clearTimeout(timer);
        live.off("close", finish);
        resolve();
      }
      live.on("close", finish);
    });
  }

  private describeDown(): string {
    if (this.closed) return "client closed";
    if (this.spawnFailure !== null) return this.spawnFailure;
    if (this.exited || this.child === null) return "process exited";
    return "not started";
  }

  private sendRequest(
    method: string,
    params: LspJsonValue,
    timeoutMs: number,
    signal: AbortSignal | null,
  ): Promise<LspJsonValue> {
    const id = this.nextId++;
    return new Promise<LspJsonValue>((resolve, reject) => {
      const entry: PendingLspRequest = {
        method,
        resolve: (value) => {
          this.settlePending(id, entry);
          resolve(value);
        },
        reject: (error) => {
          this.settlePending(id, entry);
          reject(error);
        },
        timer: setTimeout(() => {
          if (this.pending.delete(id)) {
            this.detachAbort(signal, entry);
            reject(new LspTimeoutError(method, timeoutMs));
          }
        }, timeoutMs),
        signal,
        onAbort: null,
      };
      entry.timer.unref();
      if (signal !== null) {
        entry.onAbort = () => {
          if (this.pending.delete(id)) {
            clearTimeout(entry.timer);
            this.sendNotification(CANCEL_METHOD, { id });
            reject(new LspAbortError(method));
          }
        };
        signal.addEventListener("abort", entry.onAbort, { once: true });
      }
      this.pending.set(id, entry);
      if (!this.writeFrame({ jsonrpc: "2.0", id, method, params })) {
        this.settlePending(id, entry);
        reject(new LspNotRunningError(this.serverName, this.describeDown()));
        return;
      }
      this.noteActivity();
    });
  }

  private settlePending(id: string | number, entry: PendingLspRequest): void {
    if (this.pending.get(id) !== entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    this.detachAbort(entry.signal, entry);
  }

  private detachAbort(signal: AbortSignal | null, entry: PendingLspRequest): void {
    if (signal !== null && entry.onAbort !== null) {
      signal.removeEventListener("abort", entry.onAbort);
      entry.onAbort = null;
    }
  }

  private sendNotification(method: string, params: LspJsonValue): void {
    if (this.writeFrame({ jsonrpc: "2.0", method, params })) {
      this.noteActivity();
    }
  }

  private noteActivity(): void {
    this.onActivity?.();
  }

  private writeFrame(message: LspJsonObject): boolean {
    const child = this.child;
    if (child === null || this.exited) return false;
    const stdin = child.stdin;
    if (stdin.destroyed || stdin.writable !== true) return false;
    const body = Buffer.from(JSON.stringify(message), "utf8");
    const header = Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "utf8");
    // The write callback swallows a late EPIPE; the stdin error listener is
    // the real guard, but a terminating write can surface the error here.
    stdin.write(Buffer.concat([header, body]), () => {});
    return true;
  }

  private handleExit(): void {
    if (this.exited) return;
    this.exited = true;
    this.failAllPending(new LspNotRunningError(this.serverName, this.describeDown()));
  }

  private failAllPending(error: Error): void {
    if (this.pending.size === 0) return;
    const waiting = [...this.pending.values()];
    this.pending.clear();
    for (const entry of waiting) {
      clearTimeout(entry.timer);
      this.detachAbort(entry.signal, entry);
      entry.reject(error);
    }
  }

  private handleStdoutChunk(chunk: Buffer): void {
    this.incoming = Buffer.concat([this.incoming, chunk]);
    try {
      this.drainFrames();
    } catch {
      // The drain guards every parse step, so this is unreachable in
      // practice; resetting keeps one poisoned buffer from wedging the
      // reader loop forever.
      this.incoming = Buffer.alloc(0);
      this.droppedFrames += 1;
    }
  }

  // Pull whole frames off the read buffer and dispatch them. Every malformed
  // step drops that frame and continues with the next; nothing here throws.
  private drainFrames(): void {
    for (;;) {
      const headerEnd = this.incoming.indexOf("\r\n\r\n");
      if (headerEnd < 0) {
        if (this.incoming.length > MAX_FRAME_BYTES) {
          this.incoming = Buffer.alloc(0);
          this.droppedFrames += 1;
        }
        return;
      }
      const headerText = this.incoming.subarray(0, headerEnd).toString("utf8");
      const lengthMatch = /Content-Length:\s*(\d+)/i.exec(headerText);
      const bodyLength = lengthMatch?.[1] === undefined ? null : Number(lengthMatch[1]);
      if (bodyLength === null || !Number.isInteger(bodyLength) || bodyLength < 0 || bodyLength > MAX_FRAME_BYTES) {
        this.incoming = this.incoming.subarray(headerEnd + 4);
        this.droppedFrames += 1;
        continue;
      }
      if (this.incoming.length < headerEnd + 4 + bodyLength) return;
      const bodyText = this.incoming.subarray(headerEnd + 4, headerEnd + 4 + bodyLength).toString("utf8");
      this.incoming = this.incoming.subarray(headerEnd + 4 + bodyLength);
      let body: LspJsonValue;
      try {
        // SAFETY: the parsed body is narrowed by isRecord and the field
        // decoders before any field is read.
        body = JSON.parse(bodyText) as LspJsonValue;
      } catch {
        this.droppedFrames += 1;
        continue;
      }
      try {
        this.dispatch(body);
      } catch {
        this.droppedFrames += 1;
      }
    }
  }

  private dispatch(body: LspJsonValue): void {
    if (!isRecord(body)) {
      this.droppedFrames += 1;
      return;
    }
    const method = jsonText(body.method);
    const id = asRpcId(body.id);
    if (method !== null && id !== null) {
      void this.answerServerRequest(id, method, body.params);
      return;
    }
    if (method !== null) {
      this.handleNotification(method, body.params);
      return;
    }
    if (id !== null) {
      this.handleResponse(id, body);
      return;
    }
    this.droppedFrames += 1;
  }

  private handleResponse(id: string | number, body: LspJsonObject): void {
    const entry = this.pending.get(id);
    // Not ours: a stale or unsolicited response. Ignore it rather than
    // failing a live request that happens to share nothing with it.
    if (entry === undefined) return;
    this.settlePending(id, entry);
    if (body.error !== undefined) {
      if (isRecord(body.error)) {
        const decoded = errorMessageOf(body.error);
        entry.reject(new LspRequestError(entry.method, decoded.code, decoded.message));
      } else {
        entry.reject(new LspRequestError(entry.method, -32000, "unknown language-server error"));
      }
      return;
    }
    entry.resolve(body.result ?? null);
  }

  private handleNotification(method: string, params: LspJsonValue | undefined): void {
    if (method === "textDocument/publishDiagnostics") {
      this.cacheDiagnostics(params);
    }
    // Every other server notification (progress, log messages) has no reader
    // in this slice; ignoring keeps the loop honest about what it owns.
  }

  private cacheDiagnostics(params: LspJsonValue | undefined): void {
    if (!isRecord(params)) {
      this.droppedFrames += 1;
      return;
    }
    const uri = jsonText(params.uri);
    const rawList = params.diagnostics;
    if (uri === null || !isJsonList(rawList)) {
      this.droppedFrames += 1;
      return;
    }
    const kept: LspDiagnostic[] = [];
    for (const raw of rawList) {
      const diagnostic = decodeDiagnostic(raw);
      if (diagnostic !== null) kept.push(diagnostic);
    }
    this.diagnostics.set(uri, kept);
  }

  // The minimal server-to-client surface this slice owns: configuration comes
  // from the stored settings, progress creation is acknowledged, capability
  // registration is tracked, and edits are refused — the integration only
  // ever previews them, so applying would bypass the write tools' gating.
  private async answerServerRequest(
    id: string | number,
    method: string,
    params: LspJsonValue | undefined,
  ): Promise<void> {
    switch (method) {
      case "workspace/configuration": {
        const items = isRecord(params) && isJsonList(params.items) ? params.items : [];
        const answers: LspJsonValue[] = items.map(() => this.settings);
        this.writeFrame({ jsonrpc: "2.0", id, result: answers });
        return;
      }
      case "workspace/applyEdit": {
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: "workspace/applyEdit is not supported" },
        });
        return;
      }
      case "window/workDoneProgress/create": {
        this.writeFrame({ jsonrpc: "2.0", id, result: null });
        return;
      }
      case "client/registerCapability": {
        this.trackRegistrations(params, true);
        this.writeFrame({ jsonrpc: "2.0", id, result: null });
        return;
      }
      case "client/unregisterCapability": {
        this.trackRegistrations(params, false);
        this.writeFrame({ jsonrpc: "2.0", id, result: null });
        return;
      }
      default: {
        this.writeFrame({
          jsonrpc: "2.0",
          id,
          error: { code: -32601, message: `method not found: ${method}` },
        });
      }
    }
  }

  private trackRegistrations(params: LspJsonValue | undefined, add: boolean): void {
    if (!isRecord(params) || !isJsonList(params.registrations)) return;
    for (const raw of params.registrations) {
      if (!isRecord(raw)) continue;
      const name = jsonText(raw.method);
      if (name === null) continue;
      if (add) {
        this.registeredMethods.add(name);
      } else {
        this.registeredMethods.delete(name);
      }
    }
  }
}
