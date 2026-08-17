import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";

import { killTree } from "./spawn.js";

// Generic bidirectional JSON-RPC 2.0 client over a persistent child process's
// stdio — newline-delimited, one JSON value per line, in both directions. This
// is the transport `codex app-server` speaks: unlike spawn.ts's runStreaming
// (one-shot, buffered, print-mode CLIs), this process stays alive for the life
// of a session, and the server can itself send requests back to us (approval
// prompts), not just responses/notifications.

type JsonRpcId = number | string;

type JsonRpcRequest = { jsonrpc: "2.0"; id: JsonRpcId; method: string; params?: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/** A usable inbound frame must be a JSON-RPC-shaped envelope: a request or
 *  notification carrying a `method`, or a response carrying `id` plus
 *  `result`/`error`. Anything else is leaked subprocess/hook output that
 *  merely parses as JSON — the child's tool subprocesses share its stdout
 */
function isJsonRpcEnvelope(value: Record<string, unknown>): boolean {
  if (typeof value.method === "string") return true;
  return (
    Object.prototype.hasOwnProperty.call(value, "id") &&
    (Object.prototype.hasOwnProperty.call(value, "result") ||
      Object.prototype.hasOwnProperty.call(value, "error"))
  );
}

export class JsonRpcError extends Error {
  constructor(
    message: string,
    readonly code: number,
    readonly data?: unknown,
  ) {
    super(message);
    this.name = "JsonRpcError";
  }
}

/** Handles a server→client request; the returned/thrown value becomes the
 *  response result/error sent back over stdin. */
export type JsonRpcRequestHandler = (params: unknown) => Promise<unknown>;

/** A persistent JSON-RPC-over-stdio child process. */
export class JsonRpcClient {
  private readonly child: ChildProcessWithoutNullStreams;
  private nextId = 1;
  private readonly pending = new Map<
    JsonRpcId,
    { resolve: (v: unknown) => void; reject: (e: unknown) => void }
  >();
  private readonly notificationHandlers = new Map<string, Set<(params: unknown) => void>>();
  private readonly requestHandlers = new Map<string, JsonRpcRequestHandler>();
  private readonly exitHandlers = new Set<(code: number | null) => void>();
  private readonly stderrHandlers = new Set<(line: string) => void>();
  private exited = false;

  constructor(command: string, args: string[], opts: { cwd?: string; env: NodeJS.ProcessEnv }) {
    this.child = spawn(command, args, {
      cwd: opts.cwd,
      env: opts.env,
      windowsHide: true,
      // Own process group on POSIX so kill() can signal the whole tree — the
      // app-server forks its own tool subprocesses (shell commands, etc.).
      detached: process.platform !== "win32",
      stdio: ["pipe", "pipe", "pipe"],
    });

    const outRl = createInterface({ input: this.child.stdout });
    outRl.on("line", (line) => this.handleLine(line));

    const errRl = createInterface({ input: this.child.stderr });
    errRl.on("line", (line) => {
      for (const handler of this.stderrHandlers) handler(line);
    });

    this.child.on("error", () => this.handleExit(null));
    this.child.on("close", (code) => this.handleExit(code));

    // A write landing between the child's pipe breaking and its `close` event
    // emits an error on the stdin stream itself, not on the child handle. With
    // no listener that error is uncaught and kills the main process, so treat a
    // broken pipe as the child being gone: reject in-flight calls and exit.
    this.child.stdin.on("error", () => this.handleExit(null));
  }

  private handleExit(code: number | null): void {
    if (this.exited) return;
    this.exited = true;
    const error = new Error("codex app-server process exited");
    for (const { reject } of this.pending.values()) reject(error);
    this.pending.clear();
    for (const handler of this.exitHandlers) handler(code);
  }

  private handleLine(line: string): void {
    if (!line.trim()) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Not a protocol line. The child's tool subprocesses and hooks leak
      // arbitrary output (including fragments that begin like JSON-RPC) onto
      // the same stdout pipe — an unparseable line cannot be a usable frame.
      // Log and ignore it: any request that was waiting on it fails through
      // its normal timeout instead of poisoning the session.
      console.warn("[jsonrpc] ignoring non-protocol stdout line (invalid JSON):", {
        preview: line.slice(0, 160),
        length: line.length,
      });
      return;
    }

    const msg = asRecord(parsed);
    if (!msg || !isJsonRpcEnvelope(msg)) {
      // Valid JSON but not a JSON-RPC-shaped envelope (`{}`, `[]`, `null`,
      // bare strings and numbers — command output can be any of these). Only
      // app-server frames belong on this pipe; ignore the rest.
      console.warn("[jsonrpc] ignoring non-protocol stdout line (not a JSON-RPC envelope):", {
        preview: line.slice(0, 160),
        length: line.length,
      });
      return;
    }

    if (typeof msg.method === "string") {
      if ("id" in msg) {
        void this.handleIncomingRequest(msg as unknown as JsonRpcRequest);
        return;
      }
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) for (const handler of handlers) handler(msg.params);
      return;
    }
    if ("id" in msg) {
      const id = msg.id as JsonRpcId;
      const pending = this.pending.get(id);
      if (!pending) return;
      this.pending.delete(id);
      if ("error" in msg) {
        const rawError = asRecord(msg.error);
        pending.reject(
          new JsonRpcError(
            rawError && typeof rawError.message === "string" ? rawError.message : "Unknown JSON-RPC error",
            rawError && typeof rawError.code === "number" ? rawError.code : -32000,
            rawError?.data,
          ),
        );
      } else {
        pending.resolve(msg.result);
      }
    }
  }

  private async handleIncomingRequest(req: JsonRpcRequest): Promise<void> {
    const handler = this.requestHandlers.get(req.method);
    if (!handler) {
      this.writeRaw({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32601, message: `Method not found: ${req.method}` },
      });
      return;
    }
    try {
      const result = await handler(req.params);
      this.writeRaw({ jsonrpc: "2.0", id: req.id, result });
    } catch (error) {
      this.writeRaw({
        jsonrpc: "2.0",
        id: req.id,
        error: { code: -32000, message: error instanceof Error ? error.message : String(error) },
      });
    }
  }

  private writeRaw(msg: object): void {
    if (this.exited) return;
    const stdin = this.child.stdin;
    if (!stdin.writable || stdin.destroyed) return;
    // The callback swallows a late EPIPE; the stream's `error` listener above is
    // the real guard, but a terminating write can still surface the error here.
    stdin.write(`${JSON.stringify(msg)}\n`, () => {});
  }

  /** Send a request; resolves with its result. Rejects on an error response,
   *  process exit, or timeout. */
  call<T = unknown>(method: string, params?: unknown, timeoutMs = 30_000): Promise<T> {
    if (this.exited) return Promise.reject(new Error("codex app-server process has exited"));
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Timed out waiting for ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e as Error);
        },
      });
      this.writeRaw({ jsonrpc: "2.0", id, method, params });
    });
  }

  /** Send a one-way notification — no response expected. */
  notify(method: string, params?: unknown): void {
    this.writeRaw({ jsonrpc: "2.0", method, params });
  }

  /** Register a handler for a server→client notification. Returns an
   *  unsubscribe fn. Multiple handlers per method are allowed. */
  onNotification(method: string, handler: (params: unknown) => void): () => void {
    let set = this.notificationHandlers.get(method);
    if (!set) {
      set = new Set();
      this.notificationHandlers.set(method, set);
    }
    set.add(handler);
    return () => set.delete(handler);
  }

  /** Register the handler for a server→client request (approval prompts etc).
   *  One handler per method — the latest registration wins. */
  onRequest(method: string, handler: JsonRpcRequestHandler): void {
    this.requestHandlers.set(method, handler);
  }

  /** Fires once, when the child process exits for any reason. */
  onExit(handler: (code: number | null) => void): () => void {
    this.exitHandlers.add(handler);
    return () => this.exitHandlers.delete(handler);
  }

  onStderrLine(handler: (line: string) => void): () => void {
    this.stderrHandlers.add(handler);
    return () => this.stderrHandlers.delete(handler);
  }

  /** Terminate the child process (and its process group). Idempotent.
   *  Resolves only once the process is confirmed gone, so a caller that
   *  awaits this before starting a replacement session doesn't spawn the new
   *  child while the old one still holds the CLI's on-disk session store. */
  async kill(): Promise<void> {
    if (this.exited) return;
    await killTree(this.child.pid);
  }
}
