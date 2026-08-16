import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";

import { killProcessTree } from "../terminal/processTree.js";
import { GitError, exists, lastStderrLine } from "./core.js";
import type { CloneProgress, CloneResult } from "./types.js";

// `git clone --progress` narrates its work on stderr, updating a line in place
// with `\r` as each phase advances. We parse those percentages and fold them
// onto a single 0..1 ramp — each phase owns a band, weighted by how long it
// actually takes (receiving objects is the long middle stretch), so the bar
// moves at a believable pace rather than snapping between phases.

const CLONE_PHASES: { re: RegExp; lo: number; hi: number; label: string }[] = [
  { re: /Counting objects:\s+(\d+)%/, lo: 0.0, hi: 0.1, label: "Counting objects…" },
  { re: /Compressing objects:\s+(\d+)%/, lo: 0.1, hi: 0.25, label: "Compressing objects…" },
  { re: /Receiving objects:\s+(\d+)%/, lo: 0.25, hi: 0.9, label: "Receiving objects…" },
  { re: /Resolving deltas:\s+(\d+)%/, lo: 0.9, hi: 0.98, label: "Resolving deltas…" },
  { re: /(?:Updating|Checking out) files:\s+(\d+)%/, lo: 0.98, hi: 1.0, label: "Checking out files…" },
];

/** 30 minutes: a large repo over a slow link is a real clone, not a `git status`
 *  that should die at 20s. A hung credential helper still cannot pin the
 *  process forever. */
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000;
/** Grace between SIGTERM on the git tree and SIGKILL. git clone forks
 *  `git-remote-*` helpers; the polite signal is enough when they listen, and
 *  the escalation reaps a wedged helper that would otherwise keep writing. */
const DEFAULT_KILL_ESCALATION_MS = 1_500;

/** Fold a chunk of clone stderr into the latest progress tick, or null when the
 *  chunk holds no recognizable phase update. Bands are monotonic, so the last
 *  match in the chunk is always the furthest along. */
function parseCloneProgress(chunk: string): CloneProgress | null {
  let latest: CloneProgress | null = null;
  for (const line of chunk.split(/[\r\n]+/)) {
    for (const phase of CLONE_PHASES) {
      const m = line.match(phase.re);
      if (m) {
        const pct = Number(m[1]) / 100;
        latest = {
          progress: phase.lo + (phase.hi - phase.lo) * pct,
          stage: phase.label,
        };
      }
    }
  }
  return latest;
}

export type CloneTestHooks = {
  spawn?: typeof spawn;
  timeoutMs?: number;
  killEscalationMs?: number;
};

let cloneSpawn: typeof spawn = spawn;
let cloneTimeoutMs = DEFAULT_TIMEOUT_MS;
let killEscalationMs = DEFAULT_KILL_ESCALATION_MS;

/** One abort fn per live clone, registered synchronously when clone() is
 *  called — before any await — so cancelAllClones() on the next line still
 *  reaches a clone that has not spawned git yet. */
const liveSessions = new Set<() => void>();

export function configureCloneForTests(hooks: CloneTestHooks): void {
  if (hooks.spawn !== undefined) cloneSpawn = hooks.spawn;
  if (hooks.timeoutMs !== undefined) cloneTimeoutMs = hooks.timeoutMs;
  if (hooks.killEscalationMs !== undefined) killEscalationMs = hooks.killEscalationMs;
}

export function resetCloneForTests(): void {
  cancelAllClones();
  liveSessions.clear();
  cloneSpawn = spawn;
  cloneTimeoutMs = DEFAULT_TIMEOUT_MS;
  killEscalationMs = DEFAULT_KILL_ESCALATION_MS;
}

/** Abort every clone in flight. App quit uses this so a skill-install clone
 *  cannot outlive the process just because the user's GitHub clone held the
 *  cancel slot. */
export function cancelAllClones(): void {
  for (const abort of [...liveSessions]) abort();
}

/** Alias of cancelAllClones — kept so existing imports keep compiling. IPC
 *  cancel must NOT call this: the modal button is per-renderer, not process-wide. */
export function cancelClone(): void {
  cancelAllClones();
}

/** SIGTERM the git clone and every helper it forked, then SIGKILL if they
 *  ignore it. `child.kill` hits the direct child (a shebang `git` wrapper may
 *  not be a process-group leader); the tree walk catches `git-remote-*`
 *  helpers; `-pid` is the POSIX group, private because we spawn detached. */
function abortGitChild(child: ChildProcess | null): void {
  if (!child) return;
  try {
    child.kill("SIGTERM");
  } catch {
    // Already gone.
  }
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === "win32") {
    killProcessTree(pid, "SIGKILL");
    return;
  }
  try {
    process.kill(-pid, "SIGTERM");
  } catch {
    // Not a group leader — the tree walk below still reaps children.
  }
  killProcessTree(pid, "SIGTERM");
  setTimeout(() => {
    try {
      child.kill("SIGKILL");
    } catch {
      // Already gone.
    }
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // Already gone.
    }
    killProcessTree(pid, "SIGKILL");
  }, killEscalationMs).unref?.();
}

/** Clone `url` into `dest` (an absolute path that must not already exist),
 *  reporting progress as each phase advances. Resolves with the created folder;
 *  rejects (GitError) on any git failure — bad URL, auth, network, existing dir,
 *  abort, or timeout.
 *
 *  Git writes into a sibling `.kone-clone-*` staging folder and dest is renamed
 *  onto only after a zero exit. A failed or cancelled clone therefore cannot
 *  occupy dest — a retry would otherwise die on "already exists" while a
 *  half-written tree sat in the user's chosen path. */
export function clone(
  url: string,
  dest: string,
  onProgress: (p: CloneProgress) => void,
  opts?: { signal?: AbortSignal },
): Promise<CloneResult> {
  return new Promise((resolve, reject) => {
    const target = path.resolve(dest);
    const staging = path.join(
      path.dirname(target),
      `.kone-clone-${process.pid}-${randomUUID().replace(/-/g, "")}`,
    );

    const session = new AbortController();
    const cancelSession = (): void => session.abort();
    liveSessions.add(cancelSession);

    const timeout = new AbortController();
    const timeoutTimer = setTimeout(() => timeout.abort(), cloneTimeoutMs);
    timeoutTimer.unref?.();

    const sources: AbortSignal[] = [session.signal, timeout.signal];
    if (opts?.signal) sources.push(opts.signal);
    const combined = AbortSignal.any(sources);

    let child: ChildProcess | null = null;
    let settled = false;

    const finish = (fn: () => void): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutTimer);
      combined.removeEventListener("abort", onAbort);
      liveSessions.delete(cancelSession);
      fn();
    };

    const onAbort = (): void => {
      abortGitChild(child);
    };
    if (combined.aborted) {
      onAbort();
    } else {
      combined.addEventListener("abort", onAbort, { once: true });
    }

    const abortError = (): GitError =>
      timeout.signal.aborted && !session.signal.aborted && !opts?.signal?.aborted
        ? GitError.classified("TIMEOUT", "The clone timed out.")
        : new GitError("Clone cancelled", null);

    const sweepAndReject = (error: GitError): void => {
      void rm(staging, { recursive: true, force: true }).finally(() => {
        finish(() => reject(error));
      });
    };

    void (async () => {
      if (combined.aborted) {
        sweepAndReject(abortError());
        return;
      }

      if (await exists(target)) {
        finish(() =>
          reject(new GitError(`A folder already exists at ${target}`, null)),
        );
        return;
      }
      try {
        await mkdir(path.dirname(target), { recursive: true });
      } catch (error) {
        finish(() => reject(new GitError((error as Error).message, null)));
        return;
      }

      if (combined.aborted) {
        sweepAndReject(abortError());
        return;
      }

      onProgress({ progress: 0, stage: "Connecting to github.com…" });

      child = cloneSpawn("git", ["clone", "--progress", "--", url, staging], {
        env: {
          ...process.env,
          LC_ALL: "C",
          // Never block on an interactive credential prompt for a private repo;
          // fail fast so the UI can surface the auth error instead of hanging.
          GIT_TERMINAL_PROMPT: "0",
          GCM_INTERACTIVE: "never",
          GIT_ASKPASS: "",
        },
        windowsHide: true,
        // Own process group on POSIX so abort signals `-pid` and reaps the
        // git-remote-* helpers clone forks, without signalling Electron.
        detached: process.platform !== "win32",
        stdio: ["ignore", "pipe", "pipe"],
      });

      if (combined.aborted) {
        abortGitChild(child);
      }

      let stderr = "";
      child.stderr?.on("data", (buf: Buffer) => {
        const text = buf.toString();
        stderr += text;
        const tick = parseCloneProgress(text);
        if (tick) onProgress(tick);
      });
      child.on("error", (error) => {
        if (combined.aborted) {
          sweepAndReject(abortError());
          return;
        }
        sweepAndReject(new GitError(error.message, null));
      });
      child.on("close", (code) => {
        if (combined.aborted) {
          sweepAndReject(abortError());
          return;
        }
        if (code === 0) {
          void (async () => {
            if (await exists(target)) {
              sweepAndReject(
                new GitError(`A folder already exists at ${target}`, null),
              );
              return;
            }
            try {
              await rename(staging, target);
            } catch (error) {
              sweepAndReject(
                new GitError(
                  (error as Error).message || `A folder already exists at ${target}`,
                  null,
                ),
              );
              return;
            }
            finish(() =>
              resolve({ root: target, name: path.basename(target) }),
            );
          })();
          return;
        }
        const message = lastStderrLine(
          stderr,
          `git clone exited with code ${code}`,
        );
        sweepAndReject(new GitError(message, code));
      });
    })();
  });
}
