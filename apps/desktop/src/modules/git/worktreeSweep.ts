import { lstat, readFile } from "node:fs/promises";
import path from "node:path";

import { git } from "@kone/git-core/core.js";
import { removeWorktree } from "./worktree.js";
import { ignoredEntries, isIncluded, isRegeneratedDir, readIncludeRules } from "./worktreeInclude.js";
import { isInsideWorktreesRoot, worktreesRoot } from "./worktreePaths.js";

// Putting away worktrees nobody has used in a while.
//
// Every thread with a worktree leaves a full checkout on disk, and most of them
// are never opened again once the work is merged. After a set number of days
// with no activity on any thread using it, a worktree is removed — but only
// when removing it loses nothing:
//
//   - the directory is one kone made, inside its own worktrees folder;
//   - it is on a branch, which is kept, so every commit stays reachable;
//   - nothing is uncommitted or untracked;
//   - every ignored file in it is either something a tool regenerates
//     (`node_modules`, build output) or a private file copied from the project
//     that still matches the project's copy.
//
// Anything else — a scratch file, an edited `.env`, a locked worktree — keeps
// the directory, and the next pass asks again. The thread itself is untouched:
// opening it again builds a fresh worktree on the branch it left behind.

export type IdleWorktree = { worktreePath: string; projectPath: string; threadIds: string[] };

export type WorktreeSweepDeps = {
  /** Worktrees idle since `cutoff`, oldest first. */
  idleWorktrees: (cutoff: number, limit: number) => IdleWorktree[];
  /** Whether a thread has a session attached right now. */
  isThreadLive: (threadId: string) => boolean;
  /** Record that the directory is gone and the threads should rebuild on `branch`. */
  detachWorktree: (worktreePath: string, branch: string) => void;
  /** Days of quiet before removal, or null when cleanup is off. */
  cleanupDays: () => number | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
/** Worktrees looked at per pass; the rest wait for the next one. */
const SWEEP_BATCH = 20;

/** Why a worktree must stay, or the branch it is on when it may go. */
export async function worktreeRemovability(
  entry: Pick<IdleWorktree, "worktreePath" | "projectPath">,
): Promise<{ ok: true; branch: string } | { ok: false; reason: string }> {
  const dir = entry.worktreePath;
  if (!isInsideWorktreesRoot(worktreesRoot(), dir)) return { ok: false, reason: "not kone's" };
  try {
    // A linked worktree has a `.git` file pointing home; a directory there is
    // a repository of its own, and not something to remove.
    if (!(await lstat(path.join(dir, ".git"))).isFile()) return { ok: false, reason: "not a worktree" };
  } catch {
    return { ok: false, reason: "missing" };
  }
  let branch: string;
  try {
    branch = (await git(dir, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
  } catch {
    return { ok: false, reason: "detached" };
  }
  if (!branch) return { ok: false, reason: "detached" };
  try {
    const status = await git(dir, ["status", "--porcelain", "--ignore-submodules=none"]);
    if (status.trim()) return { ok: false, reason: "has changes" };
    const rules = await readIncludeRules(entry.projectPath);
    for (const item of await ignoredEntries(dir)) {
      const isDir = item.endsWith("/");
      const rel = isDir ? item.slice(0, -1) : item;
      if (rel.split("/").some(isRegeneratedDir)) continue;
      if (!isDir && isIncluded(rules, rel, false) && (await sameFile(entry.projectPath, dir, rel))) continue;
      return { ok: false, reason: `keeps ${rel}` };
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, branch };
}

/** Whether the worktree's copy of a private file still matches the project's. */
async function sameFile(project: string, worktree: string, rel: string): Promise<boolean> {
  try {
    const [ours, theirs] = await Promise.all([
      readFile(path.join(worktree, rel)),
      readFile(path.join(project, rel)),
    ]);
    return ours.equals(theirs);
  } catch {
    return false;
  }
}

/** One pass: remove what may go, detach its threads, and answer how many. */
export async function sweepIdleWorktrees(deps: WorktreeSweepDeps, now = Date.now()): Promise<number> {
  const days = deps.cleanupDays();
  if (days === null) return 0;
  let removed = 0;
  for (const entry of deps.idleWorktrees(now - days * DAY_MS, SWEEP_BATCH)) {
    if (entry.threadIds.some(deps.isThreadLive)) continue;
    const verdict = await worktreeRemovability(entry);
    if (!verdict.ok) continue;
    // Asked again after the checks: a thread opened meanwhile keeps its desk.
    if (entry.threadIds.some(deps.isThreadLive)) continue;
    try {
      // Not forced, and the branch is not reclaimed: git refuses a worktree
      // that changed since the checks, and the branch is how it comes back.
      await removeWorktree(entry.projectPath, { path: entry.worktreePath, force: false });
    } catch (err) {
      console.warn(`[git] kept idle worktree '${entry.worktreePath}':`, err);
      continue;
    }
    deps.detachWorktree(entry.worktreePath, verdict.branch);
    removed++;
  }
  if (removed > 0) console.info(`[git] removed ${removed} idle worktree(s)`);
  return removed;
}
