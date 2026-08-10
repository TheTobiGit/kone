import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";

import { OPENCODE_BINARY } from "./opencodeHome.js";

export type OpenCodeServer = {
  baseUrl: string;
  child: ChildProcess;
  dispose: () => Promise<void>;
};

/** Bounded retry delays for a transient opencode/kilo server startup failure
 *  KILO_CREDENTIAL_STARTUP_RETRY_DELAYS_MS (commit d7b6fdf1b). */
export const OPENCODE_SERVER_RETRY_DELAYS_MS = [500, 1_500] as const;

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

async function reservePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("Could not reserve an OpenCode server port.");
  return port;
}

async function startOpenCodeServerOnce(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** CLI executable to serve from; defaults to `opencode` on PATH. */
  binary?: string;
}): Promise<OpenCodeServer> {
  // Reserve a fresh port per attempt: the failed child may still hold the
  // previous one while it winds down.
  const port = await reservePort();
  const child = spawn(input.binary || OPENCODE_BINARY, ["serve", `--hostname=127.0.0.1`, `--port=${port}`], {
    cwd: input.cwd,
    env: input.env,
    detached: process.platform !== "win32",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  let stdout = "";
  let stderr = "";
  let disposed = false;
  let ready = false;
  const dispose = async () => {
    if (disposed) return;
    disposed = true;
    input.signal?.removeEventListener("abort", abort);
    if (child.pid) {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* already gone */ }
      await new Promise((resolve) => setTimeout(resolve, 1_000));
      try { process.kill(process.platform === "win32" ? child.pid! : -child.pid!, "SIGKILL"); } catch { /* already gone */ }
    }
  };
  const abort = () => { void dispose(); };
  input.signal?.addEventListener("abort", abort, { once: true });

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
  }).catch(async (error) => { await dispose(); throw error; });
  return { baseUrl: url, child, dispose };
}

export async function startOpenCodeServer(input: {
  cwd: string;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  /** CLI executable to serve from; defaults to `opencode` on PATH. */
  binary?: string;
}): Promise<OpenCodeServer> {
  let lastError: Error | undefined;
  for (let attempt = 0; ; attempt += 1) {
    if (attempt > 0) {
      const delayMs = OPENCODE_SERVER_RETRY_DELAYS_MS[attempt - 1];
      if (delayMs === undefined) throw lastError;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
    if (input.signal?.aborted) {
      throw new Error("OpenCode server start aborted.");
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
