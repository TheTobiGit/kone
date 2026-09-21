import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";
import { createInterface } from "node:readline";

import { OPENCODE_BINARY } from "./opencodeHome.js";

export type OpenCodeServer = {
  baseUrl: string;
  child: ChildProcess;
  dispose: () => Promise<void>;
};

/** Bounded retry delays for a transient opencode/kilo server startup failure. */
export const OPENCODE_SERVER_RETRY_DELAYS_MS = [500, 1_500] as const;

/** How long a ready server without a session is parked before it is closed.
 *  Long enough to cover back-to-back thread starts, short enough that an idle
 *  headless server never lingers. */
export const OPENCODE_SERVER_SPARE_TTL_MS = 30_000;

/** Matches the failure class that is safe to retry: kilo's credential
 *  reconciliation colliding with another process's write to its sqlite store
 *  ("database is locked" / sqlite_busy). A fresh server attempt re-runs the
 *  reconciliation, so a retry is not ambiguous — unlike resume/load, which
 *  must never be repeated (repeating it makes delivery ambiguous). */
export function isRetryableOpenCodeServerFailure(detail: string): boolean {
  const text = detail.toLowerCase();
  return (
    text.includes("sqlite_busy") ||
    text.includes("database is busy") ||
    text.includes("database is locked") ||
    /failed query: update [`'"]?credential/.test(text)
  );
}

export function parseOpenCodeServerUrl(line: string): string | undefined {
  if (!line.startsWith("opencode server listening")) return undefined;
  return line.match(/on\s+(https?:\/\/[^\s]+)/)?.[1];
}

async function startOpenCodeServerOnce(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** CLI executable to serve from; defaults to `opencode` on PATH. */
  binary?: string;
  /** Invoked synchronously with the child right after spawn, so a background
   *  boot can be tracked (and torn down) before it becomes ready. */
  onChild?: (child: ChildProcess) => void;
}): Promise<OpenCodeServer> {
  // Port 0 asks the OS for an ephemeral port at bind time and the server
  // prints the bound URL on its listening line (parsed below). Reserving a
  // port up front instead — bind, read, close, re-bind — leaves a window
  // where anything else can take the port, turning a routine start into an
  // EADDRINUSE failure and a full retry cycle.
  const child = spawn(input.binary || OPENCODE_BINARY, ["serve", `--hostname=127.0.0.1`, `--port=0`], {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  input.onChild?.(child);
  let stdout = "";
  let stderr = "";
  let disposed = false;
  let ready = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    if (child.pid) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  };

  const url = await new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("Timed out waiting for OpenCode server start after 30000ms.")), 30_000);
    const settle = (error?: Error, value?: string) => {
      clearTimeout(timer);
      if (error) reject(error); else if (value) { ready = true; resolve(value); }
    };
    const out = createInterface({ input: child.stdout! });
    out.on("line", (line) => {
      stdout += `${line}\n`;
      const parsed = parseOpenCodeServerUrl(line);
      if (parsed && !ready) settle(undefined, parsed);
    });
    createInterface({ input: child.stderr! }).on("line", (line) => { stderr += `${line}\n`; });
    child.once("error", (error) => settle(error instanceof Error ? error : new Error(String(error))));
    child.once("exit", (code, signal) => {
      if (!ready) settle(new Error(`OpenCode server exited before readiness (${code ?? signal ?? "unknown"}).\nstdout:\n${stdout}\nstderr:\n${stderr}`));
    });
  }).catch(async (error) => { await disposeUnready(child); throw error; });
  return { baseUrl: url, child, dispose };
}

/** Tear down a server that never became ready. Unlike the graceful dispose
 *  above this pays no polite-shutdown wait: the process never served a
 *  session, so there is nothing to drain — and this runs on the startup
 *  failure path (including before a retry), where a full second of waiting
 *  is pure added latency on every transient failure. */
async function disposeUnready(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const pid = child.pid;
  if (pid !== undefined) {
    // Signal the group first (serve runs detached so this reaches the
    // children it forked during startup), falling back to the bare pid.
    let groupSignaled = false;
    if (process.platform !== "win32") {
      try { process.kill(-pid, "SIGKILL"); groupSignaled = true; } catch { /* fall through to the bare pid */ }
    }
    if (!groupSignaled) {
      try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ }
    }
  }
  // Bounded reap wait so a retry (or a background prewarm) never outruns the
  // dead child and collides with it — SIGKILL is unblockable, so anything
  // past this is a reused-PID mirage, not a live process.
  const deadline = Date.now() + 500;
  while (child.exitCode === null && child.signalCode === null && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

type SpareEntry = { server: OpenCodeServer; idleTimer: ReturnType<typeof setTimeout> };

/** Everything a launch key is made of. */
type LaunchInput = {
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** CLI executable to serve from; defaults to `opencode` on PATH. */
  binary?: string;
};

/** A stable digest of the environment a server was booted with. Hashed rather
 *  than carried whole: the key is compared on every start, and an environment
 *  is hundreds of entries long. */
function envFingerprint(env: NodeJS.ProcessEnv): string {
  const hash = createHash("sha1");
  for (const key of Object.keys(env).sort()) hash.update(`${key}=${env[key] ?? ""}\0`);
  return hash.digest("hex");
}

function spareKey(input: LaunchInput): string {
  // The server's cwd fixes its sessions' directory, so it is part of the
  // key. Resolved against symlinks (`/tmp` vs `/private/tmp` on macOS)
  // so one directory never parks two spares.
  let dir: string;
  try {
    dir = realpathSync(input.cwd);
  } catch {
    dir = path.resolve(input.cwd);
  }
  // The environment is part of what a server IS — credentials, home, model
  // config all ride it — so a spare booted under one is not a server started
  // under another. Without this, a start would be handed a server carrying a
  // previous call's environment and its own `env` would be silently dropped.
  return `${input.binary || OPENCODE_BINARY}\0${dir}\0${envFingerprint(input.env)}`;
}

async function startWithRetries(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  binary?: string;
}): Promise<OpenCodeServer> {
  let lastError: Error | undefined;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const delayMs = OPENCODE_SERVER_RETRY_DELAYS_MS[attempt - 1];
      if (delayMs === undefined) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    try {
      return await startOpenCodeServerOnce(input);
    } catch (error) {
      const failure = error instanceof Error ? error : new Error(String(error));
      lastError = failure;
      const retryDelayMs = OPENCODE_SERVER_RETRY_DELAYS_MS[attempt];
      if (retryDelayMs === undefined || !isRetryableOpenCodeServerFailure(failure.message)) {
        throw failure;
      }
      console.warn(
        `[opencode] server startup failed transiently (${failure.message}); retrying in ${retryDelayMs}ms`,
      );
    }
  }
}


/**
 * Booted servers kept ready for the next thread.
 *
 * `opencode serve` takes roughly half a second to reach its listening line,
 * and that half second sits in front of the user every time a thread starts.
 * This pays it in the background instead: a start hands back a server that is
 * already up and immediately boots its replacement, so the wait is only ever
 * paid by the first start on a launch key.
 *
 * Only session-less servers are ever parked. The MCP registry is
 * process-global under one name carrying a per-thread token, so two live
 * threads must never share a process — but a server that has never held a
 * session carries no registration and is safe to hand to any thread whose
 * launch key matches.
 *
 * An instance, not module state, so the thing that owns the servers owns the
 * pool: the adapter disposes its own on shutdown, and a test gets a pool of
 * its own rather than resetting a global between cases.
 */
export class OpenCodeServerPool {
  /** Ready servers parked for the next session, by launch key. At most one per
   *  key, each closed after the spare TTL. */
  readonly #spares = new Map<string, SpareEntry>();
  /** Launch keys with a background boot already in flight — one at a time. */
  readonly #warming = new Set<string>();
  /** Children of background boots not yet ready: tracked so a shutdown can
   *  tear them down instead of orphaning a detached server past quit. */
  readonly #warmingChildren = new Set<ChildProcess>();
  /** Set for good by `dispose`. A boot that reaches readiness after that is
   *  closed rather than parked — otherwise a server would appear in a pool
   *  that has already been emptied, and outlive the shutdown that emptied it. */
  #disposed = false;

  /** Start a server for this launch: a parked spare when one matches, else a
   *  boot with the full retry ladder. Either way a replacement is booted in
   *  the background, so the next start on this key is a checkout. */
  async start(input: LaunchInput): Promise<OpenCodeServer> {
    const key = spareKey(input);
    const spare = this.#takeSpare(key);
    if (spare) {
      this.#prewarm(key, input);
      return spare;
    }
    const server = await startWithRetries(input);
    this.#prewarm(key, input);
    return server;
  }

  /** How many ready servers are parked for reuse. */
  get spareCount(): number {
    return this.#spares.size;
  }

  /** Close every parked spare and tear down in-flight background boots. Live
   *  sessions own their servers outright and are unaffected. */
  async dispose(): Promise<void> {
    this.#disposed = true;
    const parked = [...this.#spares.values()];
    this.#spares.clear();
    const warmingChildren = [...this.#warmingChildren];
    this.#warmingChildren.clear();
    this.#warming.clear();
    await Promise.all([
      ...parked.map((entry) => {
        clearTimeout(entry.idleTimer);
        return entry.server.dispose();
      }),
      ...warmingChildren.map((child) => disposeUnready(child)),
    ]);
  }

  #takeSpare(key: string): OpenCodeServer | undefined {
    const entry = this.#spares.get(key);
    if (!entry) return undefined;
    this.#spares.delete(key);
    clearTimeout(entry.idleTimer);
    if (entry.server.child.exitCode !== null || entry.server.child.signalCode !== null) {
      // Died while parked. The exit watcher below evicts asynchronously; this
      // synchronous check keeps a dead spare off the hot path.
      void entry.server.dispose();
      return undefined;
    }
    return entry.server;
  }

  #park(key: string, server: OpenCodeServer): void {
    if (this.#disposed || this.#spares.has(key)) {
      // Either the pool is gone, or a checkout raced the background boot and
      // the parked spare wins. Close this one rather than leaving it running
      // with nothing holding it.
      void server.dispose();
      return;
    }
    const idleTimer = setTimeout(() => {
      if (this.#spares.get(key)?.server === server) {
        this.#spares.delete(key);
        void server.dispose();
      }
    }, OPENCODE_SERVER_SPARE_TTL_MS);
    // A parked spare must never keep the event loop alive on its own.
    idleTimer.unref?.();
    server.child.once("exit", () => {
      if (this.#spares.get(key)?.server === server) {
        this.#spares.delete(key);
        clearTimeout(idleTimer);
      }
    });
    this.#spares.set(key, { server, idleTimer });
  }

  /** Boot one server in the background and park it for the next start. Never
   *  rejects and never retries: a transient failure here just means no spare,
   *  and the next start boots inline with the full retry ladder. */
  #prewarm(key: string, input: LaunchInput): void {
    if (this.#disposed || this.#spares.has(key) || this.#warming.has(key)) return;
    this.#warming.add(key);
    let booted: ChildProcess | undefined;
    void startOpenCodeServerOnce({
      ...input,
      onChild: (child) => {
        booted = child;
        this.#warmingChildren.add(child);
      },
    })
      .then((server) => {
        this.#warming.delete(key);
        this.#warmingChildren.delete(server.child);
        this.#park(key, server);
      })
      .catch((error) => {
        this.#warming.delete(key);
        // The boot's own failure path already tore its child down; this only
        // catches a teardown that never ran. Scoped to this boot's child —
        // concurrent prewarms own theirs.
        if (booted) {
          this.#warmingChildren.delete(booted);
          void disposeUnready(booted);
        }
        console.warn(
          `[opencode] spare server prewarm failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }
}
