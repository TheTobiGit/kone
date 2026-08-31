// ── process supervisor (launch) gateway tools ──────────────────────────────
// Manages long-running project background processes (dev servers, test watchers,
// compilers) with in-memory state tracking, cursor-based log ring buffers, TCP
// and regex log readiness probing, full process-tree termination via
// killProcessTree, and turn-bound mutating actions.

import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createConnection, type Socket } from "node:net";
import path from "node:path";
import { killProcessTree } from "@kone/git-core/processTree.js";
import type { GatewayRecord, GatewayToolContext, GatewayToolResult, ToolEntry } from "../schemas.js";
import { GatewayToolError, LaunchInputSchema, LAUNCH_JSON_SCHEMA } from "../schemas.js";
import { gatewayToolErrorResult, mcpToolResultText } from "../registry.js";
export interface LogLine {
  cursor: number;
  stream: "stdout" | "stderr";
  text: string;
  timestamp: number;
}

export interface SupervisedProcessInfo {
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  status: "running" | "stopped" | "failed";
  pid?: number;
  exitCode: number | null;
  startedAt: number;
  stoppedAt: number | null;
}

export interface SupervisedProcessState {
  scope: string;
  name: string;
  command: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  status: "running" | "stopped" | "failed";
  pid?: number;
  exitCode: number | null;
  startedAt: number;
  stoppedAt: number | null;
  process?: ChildProcess;
  logs: LogLine[];
  nextCursor: number;
  readyPromise?: Promise<void>;
  readyResolved: boolean;
  readyConfig?: { port?: number; log?: string; timeout?: number };
}

function parseSafeRegex(pattern: string, fieldName: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch (err) {
    throw new GatewayToolError(
      "invalid_input",
      `Invalid regular expression in ${fieldName}: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const MAX_SUPERVISED_PROCESSES = 32;

export class ProcessSupervisor {
  /**
   * Supervised processes, keyed by (scope, name) rather than name alone.
   *
   * One supervisor is shared by every thread in the app, so a bare name would
   * put every project in the same namespace: one project's "dev" would collide
   * with another's, and any thread could read the logs of, write stdin to, or
   * kill a process it never started. `scope` is the caller's project root.
   */
  private readonly processes = new Map<string, SupervisedProcessState>();
  private readonly listeners = new Map<string, Set<(line: LogLine) => void>>();

  private static key(scope: string, name: string): string {
    return `${scope}\u0000${name}`;
  }

  async start(options: {
    scope: string;
    name: string;
    command: string;
    args?: string[];
    cwd?: string;
    env?: Record<string, string>;
    ready?: { port?: number; log?: string; timeout?: number };
  }): Promise<{ status: string; pid?: number; ready: boolean }> {
    const key = ProcessSupervisor.key(options.scope, options.name);
    const existing = this.processes.get(key);
    if (existing && existing.status === "running") {
      throw new GatewayToolError(
        "invalid_input",
        `Process "${options.name}" is already running with PID ${existing.pid}.`,
      );
    }

    let runningCount = 0;
    for (const p of this.processes.values()) {
      if (p.status === "running") runningCount++;
    }
    if (runningCount >= MAX_SUPERVISED_PROCESSES) {
      throw new GatewayToolError(
        "capability_denied",
        `Maximum number of supervised processes (${MAX_SUPERVISED_PROCESSES}) reached. Stop existing processes before starting new ones.`,
      );
    }

    const state: SupervisedProcessState = {
      scope: options.scope,
      name: options.name,
      command: options.command,
      args: options.args ?? [],
      cwd: options.cwd,
      env: options.env,
      status: "running",
      exitCode: null,
      startedAt: Date.now(),
      stoppedAt: null,
      logs: [],
      nextCursor: 1,
      readyResolved: !options.ready || (!options.ready.port && !options.ready.log),
      readyConfig: options.ready,
    };

    const child = spawn(options.command, options.args ?? [], {
      cwd: options.cwd,
      env: options.env ? { ...process.env, ...options.env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    state.pid = child.pid;
    state.process = child;

    let stdoutBuf = "";
    let stderrBuf = "";

    const appendLines = (stream: "stdout" | "stderr", text: string) => {
      const lines = text.split("\n");
      for (let i = 0; i < lines.length; i++) {
        const lineText = lines[i] ?? "";
        const line: LogLine = {
          cursor: state.nextCursor++,
          stream,
          text: lineText,
          timestamp: Date.now(),
        };
        state.logs.push(line);
        if (state.logs.length > 5000) {
          state.logs.splice(0, state.logs.length - 5000);
        }
        const set = this.listeners.get(key);
        if (set) {
          for (const listener of set) {
            listener(line);
          }
        }
      }
    };

    const handleChunk = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const str = (stream === "stdout" ? stdoutBuf : stderrBuf) + chunk.toString();
      const lastNewline = str.lastIndexOf("\n");
      if (lastNewline >= 0) {
        const complete = str.slice(0, lastNewline);
        const remainder = str.slice(lastNewline + 1);
        if (stream === "stdout") stdoutBuf = remainder;
        else stderrBuf = remainder;
        appendLines(stream, complete);
      } else {
        if (stream === "stdout") stdoutBuf = str;
        else stderrBuf = str;
      }
    };

    child.stdout?.on("data", (chunk) => handleChunk("stdout", chunk));
    child.stderr?.on("data", (chunk) => handleChunk("stderr", chunk));

    child.on("error", (err) => {
      state.status = "failed";
      state.stoppedAt = Date.now();
      appendLines("stderr", `Process spawn error: ${err.message}`);
    });

    child.on("exit", (code, signal) => {
      if (stdoutBuf.length > 0) appendLines("stdout", stdoutBuf);
      if (stderrBuf.length > 0) appendLines("stderr", stderrBuf);
      stdoutBuf = "";
      stderrBuf = "";
      state.status = code === 0 || signal !== null ? "stopped" : "failed";
      state.exitCode = code;
      state.stoppedAt = Date.now();
    });

    this.processes.set(key, state);

    // Catch early spawn failures (e.g. ENOENT)
    const { promise: spawnPromise, resolve: resolveSpawn, reject: rejectSpawn } = Promise.withResolvers<void>();
    child.once("spawn", () => resolveSpawn());
    child.once("error", (err) => {
      state.status = "failed";
      state.stoppedAt = Date.now();
      rejectSpawn(
        new GatewayToolError(
          "internal",
          `Failed to spawn process "${options.name}": ${err.message}`,
        ),
      );
    });

    try {
      await spawnPromise;
    } catch (spawnErr) {
      await this.stop(options.scope, options.name, "SIGKILL", 1).catch(() => {});
      state.status = "failed";
      state.stoppedAt = Date.now();
      throw spawnErr;
    }

    const hasReadyCondition = Boolean(options.ready && (options.ready.port || options.ready.log));
    if (hasReadyCondition && options.ready) {
      const readyTimeoutMs = (options.ready.timeout ?? 30) * 1000;
      const { promise: readyPromise, resolve: resolveReady, reject: rejectReady } = Promise.withResolvers<void>();
      state.readyPromise = readyPromise;

      let settled = false;
      let timer: NodeJS.Timeout | undefined;
      let logListener: ((line: LogLine) => void) | null = null;
      let activeSocket: Socket | null = null;

      const cleanup = () => {
        clearTimeout(timer);
        child.removeListener("exit", onEarlyExit);
        child.removeListener("error", onEarlyError);
        if (logListener) {
          this.removeListener(key, logListener);
          logListener = null;
        }
        if (activeSocket) {
          activeSocket.destroy();
          activeSocket = null;
        }
      };
      const onEarlyExit = (code: number | null) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectReady(
          new GatewayToolError(
            "internal",
            `Process "${options.name}" exited prematurely with code ${code} before readiness condition was met.`,
          ),
        );
      };

      const onEarlyError = (err: Error) => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectReady(
          new GatewayToolError(
            "internal",
            `Process "${options.name}" failed to spawn: ${err.message}`,
          ),
        );
      };

      child.once("exit", onEarlyExit);
      child.once("error", onEarlyError);

      timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        cleanup();
        rejectReady(
          new GatewayToolError(
            "internal",
            `Readiness condition timed out after ${options.ready?.timeout ?? 30}s`,
          ),
        );
      }, readyTimeoutMs);

      let portSatisfied = !options.ready.port;
      let logSatisfied = !options.ready.log;

      const checkBoth = () => {
        if (portSatisfied && logSatisfied && !settled) {
          settled = true;
          cleanup();
          state.readyResolved = true;
          resolveReady();
        }
      };

      if (options.ready.port) {
        const port = options.ready.port;
        const checkPort = () => {
          if (settled || portSatisfied) return;
          const socket = createConnection({ port, host: "127.0.0.1" }, () => {
            socket.destroy();
            if (activeSocket === socket) activeSocket = null;
            if (!settled) {
              portSatisfied = true;
              checkBoth();
            }
          });
          activeSocket = socket;
          socket.on("error", () => {
            socket.destroy();
            if (activeSocket === socket) activeSocket = null;
            if (!settled && !portSatisfied) setTimeout(checkPort, 200);
          });
        };
        checkPort();
      }

      if (options.ready.log) {
        const pattern = parseSafeRegex(options.ready.log, "ready.log");
        for (const line of state.logs) {
          if (pattern.test(line.text)) {
            logSatisfied = true;
            break;
          }
        }
        if (logSatisfied) {
          checkBoth();
        } else {
          logListener = (line: LogLine) => {
            if (settled || logSatisfied) return;
            if (pattern.test(line.text)) {
              logSatisfied = true;
              checkBoth();
            }
          };
          this.addListener(key, logListener);
        }
      }

      try {
        await readyPromise;
      } catch (err) {
        cleanup();
        const stopped = await this.stop(options.scope, options.name, "SIGKILL", 2).catch(() => false);
        if (stopped) {
          state.status = "failed";
          state.stoppedAt = Date.now();
        }
        throw err instanceof GatewayToolError ? err : new GatewayToolError("internal", String(err));
      }
    }

    return {
      status: state.status,
      pid: state.pid,
      ready: state.readyResolved,
    };
  }

  private addListener(key: string, listener: (line: LogLine) => void): void {
    let set = this.listeners.get(key);
    if (!set) {
      set = new Set();
      this.listeners.set(key, set);
    }
    set.add(listener);
  }

  private removeListener(key: string, listener: (line: LogLine) => void): void {
    const set = this.listeners.get(key);
    if (set) {
      set.delete(listener);
      if (set.size === 0) {
        this.listeners.delete(key);
      }
    }
  }

  async stop(
    scope: string,
    name: string,
    signal: NodeJS.Signals = "SIGTERM",
    timeoutSeconds = 5,
  ): Promise<boolean> {
    const state = this.processes.get(ProcessSupervisor.key(scope, name));
    if (!state || !state.process || state.status !== "running") {
      return false;
    }

    const pid = state.pid;
    if (!pid || state.process.exitCode !== null || state.process.signalCode !== null || state.status !== "running") {
      if (state.status === "running") {
        state.status = state.exitCode === 0 || state.process?.signalCode !== null ? "stopped" : "failed";
        state.stoppedAt = Date.now();
      }
      return true;
    }

    const { promise, resolve } = Promise.withResolvers<boolean>();
    let escalationTimer: NodeJS.Timeout | undefined;
    let hardCeilingTimer: NodeJS.Timeout | undefined;

    const onExit = () => {
      if (escalationTimer) clearTimeout(escalationTimer);
      if (hardCeilingTimer) clearTimeout(hardCeilingTimer);
      if (state.status === "running") {
        state.status = state.exitCode === 0 || state.process?.signalCode !== null ? "stopped" : "failed";
        state.stoppedAt = Date.now();
      }
      resolve(true);
    };
    state.process.once("exit", onExit);

    if (signal === "SIGKILL") {
      try {
        killProcessTree(pid, "SIGKILL");
      } catch {
        try {
          state.process.kill("SIGKILL");
        } catch {}
      }
      hardCeilingTimer = setTimeout(() => {
        state.process?.removeListener("exit", onExit);
        resolve(state.status !== "running");
      }, Math.max(timeoutSeconds, 1) * 1000);
    } else {
      try {
        state.process.kill(signal);
      } catch {}
      try {
        killProcessTree(pid, "SIGTERM");
      } catch {}

      escalationTimer = setTimeout(() => {
        if (state.status === "running" && pid) {
          try {
            killProcessTree(pid, "SIGKILL");
          } catch {
            try {
              state.process?.kill("SIGKILL");
            } catch {}
          }
        }
        hardCeilingTimer = setTimeout(() => {
          state.process?.removeListener("exit", onExit);
          resolve(state.status !== "running");
        }, 2000);
      }, timeoutSeconds * 1000);
    }

    return promise;
  }

  /** Shutdown path: stops every supervised process across all scopes. */
  async stopAll(timeoutSeconds = 3): Promise<void> {
    const running: Array<{ scope: string; name: string }> = [];
    for (const state of this.processes.values()) {
      if (state.status === "running") {
        running.push({ scope: state.scope, name: state.name });
      }
    }
    await Promise.all(
      running.map((r) => this.stop(r.scope, r.name, "SIGTERM", timeoutSeconds)),
    );
  }

  async restart(scope: string, name: string, timeoutSeconds = 5): Promise<{ status: string; pid?: number; ready: boolean }> {
    const state = this.processes.get(ProcessSupervisor.key(scope, name));
    if (!state) {
      throw new GatewayToolError("not_found", `No supervised process named "${name}".`);
    }

    if (state.status === "running") {
      await this.stop(scope, name, "SIGTERM", timeoutSeconds);
    }

    return this.start({
      scope: state.scope,
      name: state.name,
      command: state.command,
      args: state.args,
      cwd: state.cwd,
      env: state.env,
      ready: state.readyConfig,
    });
  }

  async logs(options: {
    scope: string;
    name: string;
    lines?: number;
    cursor?: number;
    grep?: string;
    follow?: boolean;
    timeout?: number;
  }): Promise<{ logs: LogLine[]; nextCursor: number }> {
    const key = ProcessSupervisor.key(options.scope, options.name);
    const state = this.processes.get(key);
    if (!state) {
      throw new GatewayToolError("not_found", `No supervised process named "${options.name}".`);
    }

    const maxLines = options.lines ?? 100;
    const grepRegex = options.grep ? parseSafeRegex(options.grep, "grep") : null;

    if (options.follow) {
      const { promise, resolve } = Promise.withResolvers<{ logs: LogLine[]; nextCursor: number }>();
      const collected: LogLine[] = [];
      const followTimeout = (options.timeout ?? 10) * 1000;
      const startCursor = options.cursor ?? state.nextCursor;
      const seenCursors = new Set<number>();

      let settled = false;
      let timer: NodeJS.Timeout;

      const cleanup = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        this.removeListener(key, onLine);
      };

      const onLine = (line: LogLine) => {
        if (settled) return;
        if (line.cursor >= startCursor && !seenCursors.has(line.cursor)) {
          seenCursors.add(line.cursor);
          if (!grepRegex || grepRegex.test(line.text)) {
            collected.push(line);
          }
          if (collected.length >= maxLines) {
            cleanup();
            resolve({ logs: collected, nextCursor: state.nextCursor });
          }
        }
      };

      // 1. Attach listener FIRST so no concurrent line can be missed
      this.addListener(key, onLine);

      // 2. Replay existing lines at or above startCursor
      for (const line of state.logs) {
        if (line.cursor >= startCursor && !seenCursors.has(line.cursor)) {
          seenCursors.add(line.cursor);
          if (!grepRegex || grepRegex.test(line.text)) {
            collected.push(line);
            if (collected.length >= maxLines) break;
          }
        }
      }

      if (collected.length >= maxLines) {
        cleanup();
        return { logs: collected, nextCursor: state.nextCursor };
      }

      timer = setTimeout(() => {
        cleanup();
        resolve({ logs: collected, nextCursor: state.nextCursor });
      }, followTimeout);

      return promise;
    }

    let filtered = state.logs;
    if (options.cursor !== undefined) {
      filtered = filtered.filter((l) => l.cursor >= (options.cursor ?? 0));
    }
    if (grepRegex) {
      filtered = filtered.filter((l) => grepRegex.test(l.text));
    }

    if (filtered.length > maxLines) {
      filtered = filtered.slice(filtered.length - maxLines);
    }

    return {
      logs: filtered,
      nextCursor: state.nextCursor,
    };
  }

  send(scope: string, name: string, text: string, enter = true): boolean {
    const state = this.processes.get(ProcessSupervisor.key(scope, name));
    if (!state || !state.process || state.status !== "running") {
      throw new GatewayToolError("invalid_input", `Process "${name}" is not running.`);
    }

    if (!state.process.stdin || state.process.stdin.destroyed || !state.process.stdin.writable) {
      throw new GatewayToolError("internal", `Process "${name}" stdin is not writable.`);
    }

    const payload = enter ? `${text}\n` : text;
    return state.process.stdin.write(payload);
  }

  /** Only the processes started under `scope` — never another project's. */
  list(scope: string): SupervisedProcessInfo[] {
    return Array.from(this.processes.values()).filter((p) => p.scope === scope).map((p) => ({
      name: p.name,
      command: p.command,
      args: p.args,
      cwd: p.cwd,
      status: p.status,
      pid: p.pid,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      stoppedAt: p.stoppedAt,
    }));
  }

  get(scope: string, name: string): SupervisedProcessInfo | undefined {
    const p = this.processes.get(ProcessSupervisor.key(scope, name));
    if (!p) return undefined;
    return {
      name: p.name,
      command: p.command,
      args: p.args,
      cwd: p.cwd,
      status: p.status,
      pid: p.pid,
      exitCode: p.exitCode,
      startedAt: p.startedAt,
      stoppedAt: p.stoppedAt,
    };
  }
}

export function createLaunchTools(input?: { supervisor?: ProcessSupervisor }): ToolEntry[] {
  const supervisor = input?.supervisor ?? new ProcessSupervisor();

  return [
    {
      name: "kone_launch",
      description:
        "Supervise and control long-running background processes, watchers, or dev servers. " +
        "Supports operations: start, stop, restart, logs, send, status, list.",
      inputSchema: LaunchInputSchema,
      jsonSchema: LAUNCH_JSON_SCHEMA,
      // This tool spawns whatever binary the caller names, so it is the one
      // gateway tool a human has to clear. Every other tool here is thread
      // bookkeeping.
      permission: "ask",
      requiresActiveTurn: false,
      promptSnippet:
        "Start, stop, inspect and talk to long-running background processes — dev servers, watchers, builds.",
      handler: async (ctx: GatewayToolContext, rawInput: GatewayRecord): Promise<GatewayToolResult> => {
        const parsed = LaunchInputSchema.safeParse(rawInput);
        if (!parsed.success) {
          return gatewayToolErrorResult(
            new GatewayToolError("invalid_input", parsed.error.message),
          );
        }
        const data = parsed.data;

        // Path sandbox validation: resolve cwd relative to ctx.cwd
        const projectRoot = ctx.cwd ? path.resolve(ctx.cwd) : process.cwd();
        let targetCwd = projectRoot;
        if (data.cwd) {
          const resolved = path.resolve(projectRoot, data.cwd);
          if (resolved !== projectRoot && !resolved.startsWith(projectRoot + path.sep)) {
            return gatewayToolErrorResult(
              new GatewayToolError(
                "permission_denied",
                `Working directory "${data.cwd}" escapes project root "${projectRoot}".`,
              ),
            );
          }
          targetCwd = resolved;
        }

        // Enforce active turn for mutating actions
        const isMutating =
          data.op === "start" || data.op === "stop" || data.op === "restart" || data.op === "send";
        if (isMutating && !ctx.turnId) {
          return gatewayToolErrorResult(
            new GatewayToolError(
              "capability_denied",
              `Operation "${data.op}" requires an active turn.`,
            ),
          );
        }

        try {
          switch (data.op) {
            case "start": {
              if (!data.command) {
                throw new GatewayToolError("invalid_input", "'command' is required for op: 'start'.");
              }
              const procName = data.name ?? `${data.command}-${randomUUID().slice(0, 8)}`;
              const result = await supervisor.start({
                scope: projectRoot,
                name: procName,
                command: data.command,
                args: data.args,
                cwd: targetCwd,
                env: data.env,
                ready: data.ready,
              });
              return {
                content: [
                  {
                    type: "text",
                    text: `Started process "${procName}" (PID ${result.pid ?? "unknown"}, ready: ${result.ready}).`,
                  },
                ],
                structuredContent: {
                  name: procName,
                  pid: result.pid ?? null,
                  status: result.status,
                  ready: result.ready,
                },
              };
            }

            case "stop": {
              if (!data.name) {
                throw new GatewayToolError("invalid_input", "'name' is required for op: 'stop'.");
              }
              // SAFETY: data.signal string value is cast to NodeJS.Signals or defaults to SIGTERM
              const stopped = await supervisor.stop(
                projectRoot,
                data.name,
                (data.signal as NodeJS.Signals) ?? "SIGTERM",
                data.timeout ?? 5,
              );
              return mcpToolResultText(
                stopped
                  ? `Stopped process "${data.name}".`
                  : `Process "${data.name}" was not running or not found.`,
              );
            }

            case "restart": {
              if (!data.name) {
                throw new GatewayToolError("invalid_input", "'name' is required for op: 'restart'.");
              }
              const result = await supervisor.restart(projectRoot, data.name, data.timeout ?? 5);
              return {
                content: [
                  {
                    type: "text",
                    text: `Restarted process "${data.name}" (PID ${result.pid ?? "unknown"}).`,
                  },
                ],
                structuredContent: {
                  name: data.name,
                  pid: result.pid ?? null,
                  status: result.status,
                  ready: result.ready,
                },
              };
            }

            case "logs": {
              if (!data.name) {
                throw new GatewayToolError("invalid_input", "'name' is required for op: 'logs'.");
              }
              const logResult = await supervisor.logs({
                scope: projectRoot,
                name: data.name,
                lines: data.lines,
                cursor: data.cursor,
                grep: data.grep,
                follow: data.follow,
                timeout: data.timeout,
              });
              const formatted = logResult.logs
                .map((l) => `[${l.cursor}] ${l.stream === "stderr" ? "(stderr) " : ""}${l.text}`)
                .join("\n");
              return {
                content: [
                  {
                    type: "text",
                    text: formatted.length > 0 ? formatted : "(No log output matching query)",
                  },
                ],
                structuredContent: {
                  name: data.name,
                  nextCursor: logResult.nextCursor,
                  count: logResult.logs.length,
                },
              };
            }

            case "send": {
              if (!data.name) {
                throw new GatewayToolError("invalid_input", "'name' is required for op: 'send'.");
              }
              if (data.text === undefined) {
                throw new GatewayToolError("invalid_input", "'text' is required for op: 'send'.");
              }
              supervisor.send(projectRoot, data.name, data.text, data.enter ?? true);
              return mcpToolResultText(`Sent input to process "${data.name}".`);
            }

            case "status": {
              if (!data.name) {
                throw new GatewayToolError("invalid_input", "'name' is required for op: 'status'.");
              }
              const proc = supervisor.get(projectRoot, data.name);
              if (!proc) {
                throw new GatewayToolError("not_found", `Process "${data.name}" not found.`);
              }
              return {
                content: [
                  {
                    type: "text",
                    text: `Process "${proc.name}": status=${proc.status}, pid=${proc.pid ?? "none"}, uptime=${
                      proc.stoppedAt ? proc.stoppedAt - proc.startedAt : Date.now() - proc.startedAt
                    }ms`,
                  },
                ],
                structuredContent: {
                  name: proc.name,
                  status: proc.status,
                  pid: proc.pid ?? null,
                  exitCode: proc.exitCode,
                },
              };
            }

            case "list": {
              const list = supervisor.list(projectRoot);
              const text =
                list.length === 0
                  ? "No supervised processes."
                  : list.map((p) => `- ${p.name} [${p.status}] (PID ${p.pid ?? "none"})`).join("\n");
              return {
                content: [{ type: "text", text }],
                structuredContent: {
                  processes: list.map((p) => ({
                    name: p.name,
                    status: p.status,
                    pid: p.pid ?? null,
                    command: p.command,
                  })),
                },
              };
            }
          }
        } catch (err) {
          if (err instanceof GatewayToolError) {
            return gatewayToolErrorResult(err);
          }
          return gatewayToolErrorResult(
            new GatewayToolError("internal", err instanceof Error ? err.message : String(err)),
          );
        }
      },
    },
  ];
}
