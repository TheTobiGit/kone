import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { git, repoRoot } from "./core.js";
import type {
  GitChange,
  GitFileStatus,
  GitRepo,
  GitStatus,
} from "./types.js";

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

// ── per-file line counts ──────────────────────────────────────────────────────
// `git status` reports what changed but not how much. We layer numstat on top so
// each change carries its own +/− — the working tree vs HEAD for tracked files,
// and the whole file for untracked ones (nothing to diff against yet).

/** Map of repo-relative path → {added, removed} for tracked changes vs HEAD. */
async function trackedLineCounts(
  root: string,
): Promise<Map<string, { added: number; removed: number }>> {
  const map = new Map<string, { added: number; removed: number }>();
  let out: string;
  try {
    // vs HEAD covers staged + unstaged edits to tracked files in one pass.
    out = await git(root, ["diff", "--numstat", "--no-renames", "HEAD"]);
  } catch {
    // Unborn branch (no HEAD): only staged content exists to measure.
    try {
      out = await git(root, ["diff", "--numstat", "--no-renames", "--cached"]);
    } catch {
      return map;
    }
  }
  for (const line of out.split("\n")) {
    if (!line.trim()) continue;
    // "<added>\t<removed>\t<path>"; binary files report "-\t-".
    const tab1 = line.indexOf("\t");
    const tab2 = line.indexOf("\t", tab1 + 1);
    if (tab1 < 0 || tab2 < 0) continue;
    const a = line.slice(0, tab1);
    const r = line.slice(tab1 + 1, tab2);
    const filePath = line.slice(tab2 + 1);
    map.set(filePath, {
      added: a === "-" ? 0 : Number(a),
      removed: r === "-" ? 0 : Number(r),
    });
  }
  return map;
}

const UNTRACKED_SIZE_CAP = 512 * 1024; // 512 KB

/** Line count of an untracked file (its whole content is "added"). Binary or
 *  unreadable files count as 0. */
async function fileLineCount(root: string, relPath: string): Promise<number> {
  try {
    // A `/`-terminated path is a directory; readFile would throw (EISDIR).
    if (relPath.endsWith("/")) return 0;
    const fullPath = path.join(root, relPath);
    const st = await stat(fullPath);
    if (st.size > UNTRACKED_SIZE_CAP) return 0;
    const buf = await readFile(fullPath);
    if (buf.length === 0 || buf.includes(0)) return 0;
    let lines = 0;
    for (let i = 0; i < buf.length; i++) if (buf[i] === 0x0a) lines++;
    // A final line without a trailing newline still counts.
    if (buf[buf.length - 1] !== 0x0a) lines++;
    return lines;
  } catch {
    return 0;
  }
}

/** Attach per-file +/− to every change in `status`, in place. */
async function attachLineCounts(status: GitStatus): Promise<void> {
  const tracked = await trackedLineCounts(status.root);
  await Promise.all(
    status.changes.map(async (change) => {
      if (change.status === "ignored") return;
      if (change.status === "untracked") {
        change.added = await fileLineCount(status.root, change.path);
        change.removed = 0;
        return;
      }
      const counts = tracked.get(change.path);
      change.added = counts?.added ?? 0;
      change.removed = counts?.removed ?? 0;
    }),
  );
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
    // Expand untracked directories into their files — otherwise git collapses
    // e.g. `.agents/` into one entry, and a `/`-terminated path yields nameless,
    // unreadable "empty" cards downstream.
    "--untracked-files=all",
    "-z",
  ]);
  const parsed = parseStatus(root, out);
  await attachLineCounts(parsed);
  return parsed;
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

// ── conversation-scoped snapshots ─────────────────────────────────────────────
// The recent-conversations diffstat must show what *one conversation* changed,
// not the repo's whole uncommitted state. We do that by snapshotting the working
// tree into a git tree object when the thread starts, then diffing that baseline
// against a fresh snapshot when each turn settles — so the +/− count only the
// lines that moved between the conversation's start and its latest turn.

/** Capture the current working tree (tracked + untracked, honouring .gitignore)
 *  as a git tree object, without touching the repo's real index. Returns the
 *  tree SHA, or null if the snapshot can't be taken. */
export async function snapshotWorkingTree(dir: string): Promise<string | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  let scratch: string | null = null;
  try {
    scratch = await mkdtemp(path.join(os.tmpdir(), "kone-git-idx-"));
    // A throwaway index so `add`/`write-tree` never disturb the user's staging.
    const env = { GIT_INDEX_FILE: path.join(scratch, "index") };
    // An empty scratch index + `add -A` stages every non-ignored working-tree
    // file, so the resulting tree mirrors the current content exactly (new files
    // included, deletions absent) — the true "state right now".
    await git(root, ["add", "-A"], env);
    const tree = (await git(root, ["write-tree"], env)).trim();
    return tree.length > 0 ? tree : null;
  } catch {
    return null;
  } finally {
    if (scratch) await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/** Lines added/removed between two tree-ish snapshots (e.g. a conversation's
 *  baseline tree → a fresh working-tree snapshot). Either end missing → 0/0. */
export async function diffStatBetween(
  dir: string,
  from: string,
  to: string,
): Promise<{ added: number; removed: number }> {
  const root = await repoRoot(dir);
  if (!root) return { added: 0, removed: 0 };
  try {
    return parseShortStat(await git(root, ["diff", "--shortstat", from, to]));
  } catch {
    return { added: 0, removed: 0 };
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
