import { spawn } from "node:child_process";

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
      stdio: ["ignore", "pipe", "pipe"],
    });
    let combined = "";
    let timedOut = false;
    const timer =
      input.timeoutMs && input.timeoutMs > 0
        ? setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
            // A process that ignores SIGTERM gets a hard stop shortly after.
            setTimeout(() => child.kill("SIGKILL"), 5_000).unref?.();
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
      reject(err);
    });
    child.on("close", (code, signal) => {
      if (timer) clearTimeout(timer);
      resolve({ code, signal, output: tailOutput(combined), timedOut });
    });
  });
}
