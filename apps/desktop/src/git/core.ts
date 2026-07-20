import { execFile } from "node:child_process";
import { access } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

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
  ) {
    super(message);
    this.name = "GitError";
  }
}

/** The last non-empty line of a command's stderr — the part worth surfacing —
 *  or `fallback` when there's nothing usable. */
export function lastStderrLine(stderr: string, fallback: string): string {
  return stderr.trim().split("\n").pop()?.trim() || fallback;
}

export async function git(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await run("git", args, {
      cwd,
      // Deterministic, machine-readable output regardless of user config.
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
      maxBuffer: 32 * 1024 * 1024,
      timeout: 15_000,
      windowsHide: true,
    });
    return stdout;
  } catch (error) {
    const err = error as NodeJS.ErrnoException & {
      stderr?: string;
      stdout?: string;
      code?: number | string;
    };
    const code = typeof err.code === "number" ? err.code : null;
    throw new GitError(err.stderr?.trim() || err.message, code, err.stdout ?? "");
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
