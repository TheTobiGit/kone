import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

// Shared subprocess plumbing for agent adapters — the agent-layer analogue of
// git/core.ts. Agent CLIs are long-lived and spawn their own child tools, so we
// need line-oriented streaming and whole-tree teardown, not just a buffered run.

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
      killTree(child.pid);
    },
  };
}

/** Kill a process and the tool subprocesses it spawned. Agent CLIs fork shells
 *  and tools; a plain SIGTERM to the parent can orphan them. */
export function killTree(pid: number | undefined): void {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    spawn("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    return;
  }
  try {
    // Negative pid targets the process group (adapters spawn detached).
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      // Already gone.
    }
  }
}

/** Run a short command to completion and return stdout. Returns null only when
 *  the binary is genuinely unavailable (ENOENT) — callers read that as "not
 *  installed". A non-zero exit that still printed output yields that output
 *  (some agent CLIs exit non-zero yet produce their real result).
 *
 *  Critically, stdin is closed: some agent CLIs block forever on an open stdin
 *  pipe when not attached to a TTY, so a probe that leaves stdin open just
 *  hangs until the timeout. For quick, bounded probes (`--version` and the
 *  like) — never for turns. */
export function probe(
  command: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  timeoutMs = 30_000,
): Promise<string | null> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      env,
      windowsHide: true,
      // stdin closed so the CLI can't block waiting on it.
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let settled = false;
    const finish = (value: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      finish(stdout.length > 0 ? stdout : null);
    }, timeoutMs);

    child.stdout.on("data", (buf: Buffer) => {
      stdout += buf.toString();
    });
    // ENOENT and friends — the binary isn't runnable.
    child.on("error", () => finish(null));
    child.on("close", () => finish(stdout));
  });
}
