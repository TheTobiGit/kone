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
type JsonRpcNotification = { jsonrpc: "2.0"; method: string; params?: unknown };
type JsonRpcSuccess = { jsonrpc: "2.0"; id: JsonRpcId; result: unknown };
type JsonRpcFailure = {
  jsonrpc: "2.0";
  id: JsonRpcId;
  error: { code: number; message: string; data?: unknown };
};
type JsonRpcInbound = JsonRpcRequest | JsonRpcNotification | JsonRpcSuccess | JsonRpcFailure;

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
    let msg: JsonRpcInbound;
    try {
      msg = JSON.parse(line);
    } catch {
      // Not a protocol line. app-server writes only JSON-RPC on stdout, but be
      // defensive rather than crash the session on a stray line.
      return;
    }

    if ("method" in msg && "id" in msg) {
      void this.handleIncomingRequest(msg);
      return;
    }
    if ("method" in msg) {
      const handlers = this.notificationHandlers.get(msg.method);
      if (handlers) for (const handler of handlers) handler(msg.params);
      return;
    }
    if ("id" in msg) {
      const pending = this.pending.get(msg.id);
      if (!pending) return;
      this.pending.delete(msg.id);
      if ("error" in msg) pending.reject(new JsonRpcError(msg.error.message, msg.error.code, msg.error.data));
      else pending.resolve(msg.result);
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
    this.child.stdin.write(`${JSON.stringify(msg)}\n`);
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

  /** Terminate the child process (and its process group). Idempotent. */
  kill(): void {
    if (this.exited) return;
    killTree(this.child.pid);
  }
}
