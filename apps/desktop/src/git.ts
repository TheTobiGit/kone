import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

import { ipcMain } from "electron";

const run = promisify(execFile);

// ── Data model ──────────────────────────────────────────────────────────────
// Kept deliberately flat and serializable — everything here crosses the IPC
// boundary to the renderer. Mirror any change in apps/web/app/types/desktop.d.ts.

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "untracked"
  | "ignored"
  | "conflicted";

export type GitChange = {
  /** Repo-relative path (POSIX separators, as git reports it). */
  path: string;
  /** Original path, for renames and copies. */
  from?: string;
  status: GitFileStatus;
  /** Present in the index (has a staged change). */
  staged: boolean;
  /** Present in the working tree (has an unstaged change). */
  unstaged: boolean;
};

export type GitBranch = {
  /** Short name, e.g. "main" or "origin/main". */
  name: string;
  current: boolean;
  /** A remote-tracking ref (under refs/remotes). */
  remote: boolean;
  /** Upstream branch for a local branch, e.g. "origin/main". */
  upstream?: string;
  ahead?: number;
  behind?: number;
};

export type GitCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  email: string;
  /** Author date, ISO 8601. */
  date: string;
  /** Human-relative author date, e.g. "2 hours ago". */
  relative: string;
};

export type GitStatus = {
  /** Absolute path to the repository's top level. */
  root: string;
  /** Current branch, or null when detached / on an unborn branch. */
  branch: string | null;
  detached: boolean;
  /** Short hash of HEAD, or null before the first commit. */
  head: string | null;
  /** Upstream tracking branch, e.g. "origin/main". */
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
};

/** Lightweight repo summary — what the UI needs to recognize a project. */
export type GitRepo = {
  root: string;
  name: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  changeCount: number;
  clean: boolean;
  /** Lines inserted across uncommitted tracked changes (working tree vs HEAD). */
  added: number;
  /** Lines deleted across uncommitted tracked changes. */
  removed: number;
};

// ── git runner ──────────────────────────────────────────────────────────────

class GitError extends Error {
  constructor(
    message: string,
    readonly code: number | null,
  ) {
    super(message);
    this.name = "GitError";
  }
}

async function git(cwd: string, args: string[]): Promise<string> {
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
      code?: number | string;
    };
    const code = typeof err.code === "number" ? err.code : null;
    throw new GitError(err.stderr?.trim() || err.message, code);
  }
}

/** Resolve the repository root for `dir`, or null when it isn't in a repo. */
async function repoRoot(dir: string): Promise<string | null> {
  try {
    const out = await git(dir, ["rev-parse", "--show-toplevel"]);
    const root = out.trim();
    return root.length > 0 ? path.normalize(root) : null;
  } catch {
    return null;
  }
}

// ── porcelain v2 parsing ─────────────────────────────────────────────────────

function fileStatus(code: string): GitFileStatus {
  switch (code) {
    case "M":
      return "modified";
    case "A":
      return "added";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    default:
      return "modified";
  }
}

function parseStatus(root: string, out: string): GitStatus {
  const records = out.split("\0");
  const status: GitStatus = {
    root,
    branch: null,
    detached: false,
    head: null,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: [],
    staged: 0,
    unstaged: 0,
    untracked: 0,
    clean: true,
  };

  for (let i = 0; i < records.length; i++) {
    const line = records[i];
    if (!line) continue;

    // Branch/header lines: "# branch.<key> <value>".
    if (line.startsWith("# branch.")) {
      const [key, ...rest] = line.slice(2).split(" ");
      const value = rest.join(" ");
      if (key === "branch.oid") {
        status.head = value === "(initial)" ? null : value.slice(0, 7);
      } else if (key === "branch.head") {
        if (value === "(detached)") {
          status.detached = true;
        } else {
          status.branch = value;
        }
      } else if (key === "branch.upstream") {
        status.upstream = value;
      } else if (key === "branch.ab") {
        const m = value.match(/\+(\d+) -(\d+)/);
        if (m) {
          status.ahead = Number(m[1]);
          status.behind = Number(m[2]);
        }
      }
      continue;
    }

    const kind = line[0];

    // Ordinary changed entry: "1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>".
    if (kind === "1") {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const filePath = parts.slice(8).join(" ");
      status.changes.push(changeFromXY(xy, filePath));
      continue;
    }

    // Renamed/copied: adds an <Xscore> field; original path is the next record.
    if (kind === "2") {
      const parts = line.split(" ");
      const xy = parts[1] ?? "..";
      const filePath = parts.slice(9).join(" ");
      const from = records[++i] ?? undefined;
      status.changes.push(changeFromXY(xy, filePath, from));
      continue;
    }

    // Unmerged (conflict): "u <XY> ... <path>".
    if (kind === "u") {
      const parts = line.split(" ");
      const filePath = parts.slice(10).join(" ");
      status.changes.push({
        path: filePath,
        status: "conflicted",
        staged: false,
        unstaged: true,
      });
      continue;
    }

    // Untracked: "? <path>". Ignored: "! <path>".
    if (kind === "?") {
      status.changes.push({
        path: line.slice(2),
        status: "untracked",
        staged: false,
        unstaged: true,
      });
      continue;
    }
    if (kind === "!") {
      status.changes.push({
        path: line.slice(2),
        status: "ignored",
        staged: false,
        unstaged: true,
      });
    }
  }

  for (const change of status.changes) {
    if (change.status === "ignored") continue;
    if (change.status === "untracked") {
      status.untracked += 1;
      continue;
    }
    if (change.staged) status.staged += 1;
    if (change.unstaged) status.unstaged += 1;
  }
  status.clean =
    status.staged === 0 && status.unstaged === 0 && status.untracked === 0;

  return status;
}

function changeFromXY(xy: string, filePath: string, from?: string): GitChange {
  const x = xy[0] ?? "."; // index/staged
  const y = xy[1] ?? "."; // working tree
  const staged = x !== "." && x !== "?";
  const unstaged = y !== ".";
  // Prefer the working-tree letter for display; fall back to the index letter.
  const primary = y !== "." ? y : x;
  return {
    path: filePath,
    from,
    status: fileStatus(primary),
    staged,
    unstaged,
  };
}

// ── public operations ────────────────────────────────────────────────────────

/** Full working-tree status, or null when `dir` isn't inside a git repo. */
export async function status(dir: string): Promise<GitStatus | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const out = await git(root, [
    "status",
    "--porcelain=v2",
    "--branch",
    "-z",
  ]);
  return parseStatus(root, out);
}

/** Parse `git diff --shortstat` output, e.g.
 *  " 3 files changed, 42 insertions(+), 13 deletions(-)". */
function parseShortStat(out: string): { added: number; removed: number } {
  const added = out.match(/(\d+) insertion/);
  const removed = out.match(/(\d+) deletion/);
  return {
    added: added ? Number(added[1]) : 0,
    removed: removed ? Number(removed[1]) : 0,
  };
}

/** Lines added/removed across all uncommitted tracked changes (working tree +
 *  index, measured against HEAD). Clean tree → 0/0. */
async function diffStat(
  root: string,
): Promise<{ added: number; removed: number }> {
  try {
    return parseShortStat(await git(root, ["diff", "--shortstat", "HEAD"]));
  } catch {
    // No HEAD yet (unborn branch): fall back to the staged diff, then give up.
    try {
      return parseShortStat(
        await git(root, ["diff", "--cached", "--shortstat"]),
      );
    } catch {
      return { added: 0, removed: 0 };
    }
  }
}

/** Recognize a repo and summarize it — cheap enough to call on open. */
export async function detect(dir: string): Promise<GitRepo | null> {
  const full = await status(dir);
  if (!full) return null;
  const { added, removed } = await diffStat(full.root);
  return {
    root: full.root,
    name: path.basename(full.root),
    branch: full.branch,
    detached: full.detached,
    ahead: full.ahead,
    behind: full.behind,
    changeCount: full.staged + full.unstaged + full.untracked,
    clean: full.clean,
    added,
    removed,
  };
}

export async function branches(dir: string): Promise<GitBranch[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const out = await git(root, [
    "for-each-ref",
    "--format=%(refname:short)%00%(HEAD)%00%(upstream:short)%00%(upstream:track)",
    "refs/heads",
    "refs/remotes",
  ]);

  const result: GitBranch[] = [];
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    const [name, head, upstream, track] = line.split("\0");
    if (!name) continue;
    // Skip the symbolic "origin/HEAD -> origin/main" pointer.
    if (name.endsWith("/HEAD")) continue;

    const remote = name.includes("/") && !upstream && head !== "*";
    const branch: GitBranch = {
      name,
      current: head === "*",
      remote,
    };
    if (upstream) branch.upstream = upstream;
    const ahead = track?.match(/ahead (\d+)/);
    const behind = track?.match(/behind (\d+)/);
    if (ahead) branch.ahead = Number(ahead[1]);
    if (behind) branch.behind = Number(behind[1]);
    result.push(branch);
  }
  return result;
}

export async function log(dir: string, limit = 50): Promise<GitCommit[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const sep = "\x1f"; // field separator (unit sep)
  const rec = "\x1e"; // record separator
  const format = ["%H", "%h", "%s", "%an", "%ae", "%aI", "%ar"].join(sep) + rec;

  // Fall back to the default for NaN / Infinity / non-positive values rather
  // than passing an invalid --max-count that git would reject.
  const max = Number.isFinite(limit) ? Math.max(1, Math.floor(limit)) : 50;

  let out: string;
  try {
    out = await git(root, [
      "log",
      `--max-count=${max}`,
      `--pretty=format:${format}`,
    ]);
  } catch (error) {
    // An unborn branch (no commits yet) has no log — treat as empty.
    if (error instanceof GitError) return [];
    throw error;
  }

  const commits: GitCommit[] = [];
  for (const chunk of out.split(rec)) {
    const line = chunk.replace(/^\n/, "");
    if (!line.trim()) continue;
    const [hash, short, subject, author, email, date, relative] =
      line.split(sep);
    if (!hash) continue;
    commits.push({
      hash,
      short: short ?? hash.slice(0, 7),
      subject: subject ?? "",
      author: author ?? "",
      email: email ?? "",
      date: date ?? "",
      relative: relative ?? "",
    });
  }
  return commits;
}

// ── IPC ───────────────────────────────────────────────────────────────────────

/** Register the git:* IPC handlers. Call once, before creating the window. */
export function registerGitIpc(): void {
  ipcMain.handle("git:detect", (_event, dir: string) => detect(dir));
  ipcMain.handle("git:status", (_event, dir: string) => status(dir));
  ipcMain.handle("git:branches", (_event, dir: string) => branches(dir));
  ipcMain.handle("git:log", (_event, dir: string, limit?: number) =>
    log(dir, limit),
  );
}
