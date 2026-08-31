import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Shared subprocess plumbing for agent adapters — the agent-layer analogue of
// git/core.ts. Agent CLIs are long-lived and spawn their own child tools, so we
// need line-oriented streaming and whole-tree teardown, not just a buffered run.

// Grace period between the polite SIGTERM group-kill and escalating to SIGKILL.
const KILL_ESCALATION_MS = 1_500;

// How long to keep polling for proof of death after SIGKILL before giving up.
// SIGKILL is unblockable, so this only guards against polling past a reused
// PID or a permission error masking the check — it should rarely be reached.
const KILL_FORCE_WAIT_MS = 2_000;

const KILL_POLL_MS = 50;

// Per-stream cap on probe output accumulation; beyond this we keep draining but
// stop appending, so a chatty CLI can't balloon memory over a long probe window.
const PROBE_OUTPUT_CAP_BYTES = 1024 * 1024;

/** A running agent invocation and the plumbing to observe/stop it. */
export type StreamingRun = {
  /** Resolves when the process exits — never rejects; inspect `code`. `stdout`
   *  / `stderr` are the fully accumulated streams. Some agent CLIs exit
   *  non-zero yet still produce their real answer on stdout, so the caller
   *  decides success from `stdout`, not `code` alone. */
  done: Promise<{ code: number | null; stdout: string; stderr: string }>;
  /** Terminate the process (and its children). Idempotent. */
  kill: () => void;
};

/** Spawn `command args` in `cwd`, streaming stdout/stderr line-by-line to the
 *  callbacks as they flush, while also accumulating the full text. */
export function runStreaming(
  command: string,
  args: string[],
  opts: {
    cwd: string;
    env: NodeJS.ProcessEnv;
    onStdoutLine?: (line: string) => void;
    onStderrLine?: (line: string) => void;
  },
): StreamingRun {
  const child = spawn(command, args, {
    cwd: opts.cwd,
    env: opts.env,
    windowsHide: true,
    // Own process group on POSIX so killTree can signal the group (-pid) and
    // reap the tool subprocesses the agent forks, not just the parent.
    detached: process.platform !== "win32",
    // stdin closed: print mode must never block on an interactive prompt.
    stdio: ["ignore", "pipe", "pipe"],
  });

  let stdout = "";
  let stderr = "";
  let killed = false;

  const outRl = createInterface({ input: child.stdout });
  outRl.on("line", (line) => {
    stdout += `${line}\n`;
    opts.onStdoutLine?.(line);
  });
  const errRl = createInterface({ input: child.stderr });
  errRl.on("line", (line) => {
    stderr += `${line}\n`;
    opts.onStderrLine?.(line);
  });

  const done = new Promise<{ code: number | null; stdout: string; stderr: string }>(
    (resolve) => {
      child.on("error", (error) => {
        // Spawn failure (ENOENT etc.) — surface as a non-zero-ish result rather
        // than throwing, so adapters have one place to handle failure.
        // SAFETY: node delivers an Error instance to the child "error" listener.
        stderr += `${(error as Error).message}\n`;
        resolve({ code: null, stdout, stderr });
      });
      child.on("close", (code) => {
        outRl.close();
        errRl.close();
        resolve({ code, stdout, stderr });
      });
    },
  );

  return {
    done,
    kill: () => {
      if (killed) return;
      killed = true;
      // StreamingRun.kill() is a synchronous, fire-and-forget signal; no
      // caller here needs proof of exit before proceeding.
      void killTree(child.pid);
    },
  };
}

/** True if `pid` still names a live process (the zero-signal existence check —
 *  it delivers nothing, it just tests whether `kill` would be allowed to). */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Signal the process group first (adapters spawn detached so this reaches
 *  the tool subprocesses the CLI forked), falling back to the bare pid. */
function signalTree(pid: number, signal: NodeJS.Signals): boolean {
  try {
    process.kill(-pid, signal);
    return true;
  } catch {
    try {
      process.kill(pid, signal);
      return true;
    } catch {
      return false; // Already gone.
    }
  }
}

/** Poll until `pid` is gone or `timeoutMs` elapses. Resolves `true` on proven
 *  death, `false` on timeout — never rejects, so a caller can bound the wait
 *  without a try/catch. */
function waitWhileAlive(pid: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (!isProcessAlive(pid)) {
      resolve(true);
      return;
    }
    const deadline = Date.now() + timeoutMs;
    const poll = setInterval(() => {
      if (!isProcessAlive(pid)) {
        clearInterval(poll);
        resolve(true);
        return;
      }
      if (Date.now() >= deadline) {
        clearInterval(poll);
        resolve(false);
      }
    }, KILL_POLL_MS);
    // A caller that doesn't await killTree() (StreamingRun.kill(), the probe
    // timeout path) must never keep the process alive just for this poll.
    poll.unref?.();
  });
}

/** Kill a process and the tool subprocesses it spawned, resolving only once
 *  the process is actually gone — not merely signaled. Agent CLIs fork shells
 *  and tools; a plain SIGTERM to the parent can orphan them. A caller that
 *  awaits this before starting a replacement (same workspace, same lock
 *  files) needs the previous child provably dead, not just asked to leave:
 *  firing SIGKILL on a timer and returning immediately left a window where
 *  the old and new child could both hold the same CLI's on-disk session
 *  store. */
export async function killTree(pid: number | undefined): Promise<void> {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const tasked = spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
      tasked.once("exit", () => resolve());
      tasked.once("error", () => resolve());
    });
    return;
  }
  if (!isProcessAlive(pid)) return;
  signalTree(pid, "SIGTERM");
  if (await waitWhileAlive(pid, KILL_ESCALATION_MS)) return;
  // A wedged CLI that ignores the polite signal would otherwise leak its
  // whole process group.
  signalTree(pid, "SIGKILL");
  await waitWhileAlive(pid, KILL_FORCE_WAIT_MS);
}

/** How a probe ended. The distinction is load-bearing for provider health: a
 *  CLI that is absent wants "install it", one that timed out wants "try again",
 *  and one that exited non-zero wants its own stderr shown back. Collapsing all
 *  three into "no output" is what made a slow CLI read as uninstalled. */
export type ProbeOutcome =
  /** Ran to completion, exit code 0. */
  | "ok"
  /** Ran to completion, exit code non-zero. `stdout`/`stderr` still hold output. */
  | "nonzero"
  /** Still running when the timeout fired; the process group was torn down. */
  | "timeout"
  /** Could not be started — ENOENT, i.e. nothing to run at that path. */
  | "missing"
  /** Could not be started for some other reason (permissions, and friends). */
  | "failure";

export type ProbeResult = {
  outcome: ProbeOutcome;
  stdout: string;
  stderr: string;
  /** Exit code when the child ran to completion; null when it never did. */
  code: number | null;
  /** The spawn error behind a "missing" / "failure" outcome. */
  error?: Error;
};

/** Run a short command to completion and report how it ended, with both streams
 *  captured. This is the probe primitive; `probe()` below is the text-only
 *  wrapper most callers still want.
 *
 *  Critically, stdin is closed: some agent CLIs block forever on an open stdin
 *  pipe when not attached to a TTY, so a probe that leaves stdin open just
 *  hangs until the timeout. For quick, bounded probes (`--version` and the
 *  like) — never for turns. Each stream is capped at 1 MiB and a timed-out
 *  probe tears down the child's whole process group, escalating SIGTERM to
 *  SIGKILL. */
export function probeResult(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<ProbeResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      // stdin closed so the CLI can't block waiting on it.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (result: ProbeResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      // A timed-out probe resolves immediately with whatever it captured;
      // nothing here waits on the teardown, so let it run in the background.
      void killTree(child.pid);
      finish({ outcome: "timeout", stdout, stderr, code: null });
    }, timeoutMs);

    // Keep draining both streams but stop appending past the cap: a chatty
    // stream with no consumer fills its pipe buffer and blocks the child
    // (backpressure), which deadlocks the probe, while an unbounded append
    // would balloon memory over a long probe window.
    child.stdout.on("data", (buf: Buffer) => {
      if (stdout.length >= PROBE_OUTPUT_CAP_BYTES) return;
      stdout += buf.toString();
    });
    child.stderr.on("data", (buf: Buffer) => {
      if (stderr.length >= PROBE_OUTPUT_CAP_BYTES) return;
      stderr += buf.toString();
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      finish({
        outcome: error.code === "ENOENT" ? "missing" : "failure",
        stdout,
        stderr,
        code: null,
        error,
      });
    });
    child.on("close", (code) => {
      finish({ outcome: code === 0 ? "ok" : "nonzero", stdout, stderr, code });
    });
  });
}

/** Run a short command to completion and return stdout. Returns null only when
 *  the binary is genuinely unavailable (ENOENT) — callers read that as "not
 *  installed". A non-zero exit that still printed output yields that output
 *  (some agent CLIs exit non-zero yet produce their real result).
 *
 *  Prefer `probeResult` where the *reason* a probe failed changes what the user
 *  should be told; this wrapper cannot tell a missing binary from a wedged one. */
export function probe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<string | null> {
  return probeResult(command, args, env, timeoutMs).then((result) => {
    if (result.outcome === "missing" || result.outcome === "failure") return null;
    // A timeout that captured nothing is indistinguishable from a dead binary
    // through this signature — the reason `probeResult` exists.
    if (result.outcome === "timeout") return result.stdout.length > 0 ? result.stdout : null;
    return result.stdout;
  });
}
