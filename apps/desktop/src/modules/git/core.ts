import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import { markKind } from "../../lib/ipcError.js";
import type { IpcErrorKind } from "../../lib/ipcError.js";

// The shared foundation every git feature module builds on: the git process
// runner, the error type it throws, and the path/fs guards that keep operations
// inside the repository.

export const run = promisify(execFile);

export class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
    /** stdout captured on the failing run — some commands (e.g. `git diff
     *  --no-index`) exit non-zero yet still produce their real output here. */
    readonly stdout = "",
    /** Semantic failure kind, when the caller can classify the error. Carried
     *  in the message as a "[kone:…]" marker so it survives IPC serialization —
     *  see ipcError.ts. */
    readonly kind: IpcErrorKind | null = null,
  ) {
    super(kind ? markKind(kind, message) : message);
    this.name = "GitError";
  }

  /** Build a GitError carrying a semantic failure kind. */
  static classified(
    kind: IpcErrorKind,
    message: string,
    code: number | null = null,
    stdout = "",
  ): GitError {
    return new GitError(message, code, stdout, kind);
  }
}

/** The last non-empty line of a command's stderr — the part worth surfacing —
 *  or `fallback` when there's nothing usable. */
export function lastStderrLine(stderr: string, fallback: string): string {
  return stderr.trim().split("\n").pop()?.trim() || fallback;
}

/** Whether a rejected child_process run died from its own timeout (killed by
 *  the `timeout` option) rather than a real exit. */
export function isExecTimeout(cause: unknown): boolean {
  if (!(cause instanceof Object)) return false;
  return (
    ("killed" in cause && cause.killed === true) ||
    ("code" in cause && cause.code === "ETIMEDOUT")
  );
}

export async function git(
  cwd: string,
  args: string[],
  /** Extra env for this invocation only — e.g. a scratch `GIT_INDEX_FILE` so a
   *  command can stage into a throwaway index without touching the real one. */
  extraEnv?: Record<string, string>,
): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      // Deterministic, machine-readable output regardless of user config.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C", ...extraEnv },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    if (isExecTimeout(error)) {
      throw new GitError("The git command timed out.", null, "", "TIMEOUT");
    }
    const stderr =
      error instanceof Error && "stderr" in error
        ? String(error.stderr ?? "")
        : "";
    const stdout =
      error instanceof Error && "stdout" in error
        ? String(error.stdout ?? "")
        : "";
    const message =
      stderr.trim() ||
      (error instanceof Error ? error.message : "git command failed");
    const rawCode =
      error instanceof Error && "code" in error ? error.code : undefined;
    // SAFETY: Number.isInteger verified rawCode is an integer exit code.
    const code = Number.isInteger(rawCode) ? (rawCode as number) : null;
    throw new GitError(message, code, stdout);
  }
}

/** Resolve the repository root for `dir`, or null when it isn't in a repo. */
export async function repoRoot(dir: string): Promise<string | null> {
  try {
    const out = await git(dir, ["rev-parse", "--show-toplevel"]);
    const root = out.trim();
    return root.length > 0 ? path.normalize(root) : null;
  } catch {
    return null;
  }
}

/** Whether `dir` exists (as anything). */
export async function exists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

/** Resolve a repo-relative path to an absolute path, but only if it stays inside
 *  the repo. Guards the fs-level deletes in mutations: git refuses out-of-tree
 *  pathspecs, but `fs.rm` would happily follow `..` out of the repository.
 *  Returns null for escapes (`..`) and absolute paths. */
export function safeRepoPath(root: string, relPath: string): string | null {
  const abs = path.resolve(root, relPath);
  const rel = path.relative(root, abs);
  if (
    rel === "" ||
    rel === ".." ||
    rel.startsWith(`..${path.sep}`) ||
    path.isAbsolute(rel)
  ) {
    return null;
  }
  return abs;
}

/** Reject a batch that names any path outside the repo root, before we run git
 *  or touch the filesystem. */
export function assertWithinRepo(root: string, paths: string[]): void {
  for (const p of paths) {
    if (safeRepoPath(root, p) === null) {
      throw new GitError(
        `Refusing to operate on a path outside the repository: ${p}`,
        null,
      );
    }
  }
}
