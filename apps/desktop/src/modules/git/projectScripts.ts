import { spawn } from "node:child_process";
import { killProcessTree } from "@kone/git-core/processTree.js";

// Per-project scripts: the setup command run once after a worktree is built,
// and the settle command run when a thread settles. Both are the user's own
// shell commands stored against the project (see ProjectScriptRepo), executed
// in the thread's directory with the login shell so the PATH/aliases a person
// gets in a terminal are the ones their script gets.
//
// Output is streamed to a caller (the worktree-setup tracker shows it live) and
// also returned as a bounded tail, because a script that fails is diagnosed
// from its last lines. A non-zero exit is DATA, not an exception: the caller
// decides whether a failed settle script matters (it never fails the settle),
// while a spawn failure or timeout is a real error.

/** The most output kept after a run finishes. Setup logs can be long; the tail
 *  is what a reader needs. */
export const PROJECT_SCRIPT_TAIL_CHARS = 8_000;
/** The default settle-script timeout — a cleanup command, not a build. */
export const SETTLE_SCRIPT_TIMEOUT_MS = 2 * 60_000;
/** The default setup-script timeout — installs and builds can take a while. */
export const SETUP_SCRIPT_TIMEOUT_MS = 15 * 60_000;

export interface ProjectScriptRunInput {
  cwd: string;
  command: string;
  timeoutMs?: number;
  env?: NodeJS.ProcessEnv;
  /** Called with each stdout/stderr chunk as it arrives, for live display. */
  onOutput?: (chunk: string) => void;
}

export interface ProjectScriptRunResult {
  /** Process exit code; null when it was killed by a signal. */
  code: number | null;
  signal: NodeJS.Signals | null;
  /** Bounded tail of combined stdout+stderr. */
  output: string;
  timedOut: boolean;
}

/** Keep the last `maxChars` of `text`, marking the cut so a reader knows
 *  something was dropped. */
export function tailOutput(text: string, maxChars = PROJECT_SCRIPT_TAIL_CHARS): string {
  if (text.length <= maxChars) return text;
  return `…[earlier output truncated]\n${text.slice(-maxChars)}`;
}

/** Run one project script in `cwd`. Resolves with the exit code and output;
 *  rejects only when the process could not be spawned at all. A timeout kills
 *  the process and resolves with `timedOut: true`. */
export function runProjectScript(input: ProjectScriptRunInput): Promise<ProjectScriptRunResult> {
  const command = input.command.trim();
  if (!command) return Promise.resolve({ code: 0, signal: null, output: "", timedOut: false });
  return new Promise((resolve, reject) => {
    const child = spawn(process.env.SHELL ?? "/bin/sh", ["-lc", command], {
      cwd: input.cwd,
      env: input.env ?? process.env,
      windowsHide: true,
      // Timeout must reach commands forked by the login shell as well. Their
      // inherited stdout/stderr otherwise keep `close` pending after it dies.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    let timedOut = false;
    let escalationTimer: ReturnType<typeof setTimeout> | null = null;
    const stop = (signal: "SIGTERM" | "SIGKILL") => {
      if (child.pid === undefined) return;
      if (process.platform === "win32") {
        killProcessTree(child.pid, signal);
      } else {
        try {
          process.kill(-child.pid, signal);
        } catch {
          // The process group may already have exited.
        }
      }
    };
    const timer =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            stop("SIGTERM");
            // A process that ignores SIGTERM gets a hard stop shortly after.
            escalationTimer = setTimeout(() => {
              stop("SIGKILL");
              // A descendant that left the group (setsid, a daemonizer) is out
              // of reach and may still hold our pipes; stop reading so `close`
              // can follow the shell's exit instead of waiting on it forever.
              child.stdout.destroy();
              child.stderr.destroy();
            }, 5_000);
            escalationTimer.unref?.();
          }, input.timeoutMs)
        : null;
    timer?.unref?.();

    const collect = (chunk: string) => {
      combined += chunk;
      input.onOutput?.(chunk);
    };
    child.stdout.on("data", (buf: Buffer) => collect(buf.toString()));
    child.stderr.on("data", (buf: Buffer) => collect(buf.toString()));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      if (escalationTimer) clearTimeout(escalationTimer);
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      // Redirected descendants may keep running after the shell has closed
      // all its pipes. Finish timeout cleanup synchronously before settling;
      // leaving a delayed group kill behind could target a later reused id.
      // POSIX only: a live group keeps its id reserved, but on Windows the
      // shell's pid is free once it exits, and the timeout's taskkill already
      // forced the tree down.
      if (timedOut && process.platform !== "win32") stop("SIGKILL");
      if (escalationTimer) clearTimeout(escalationTimer);
      resolve({ code, signal, output: tailOutput(combined), timedOut });
    });
  });
}
