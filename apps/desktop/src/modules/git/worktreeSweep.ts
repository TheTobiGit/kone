import { lstat, readFile, readdir } from "node:fs/promises";
import path from "node:path";

import type { IdleWorktree } from "@kone/agent-core/threadWorkspace.js";
import { git } from "@kone/git-core/core.js";
import { removeWorktree } from "./worktree.js";
import { ignoredEntries, isRegeneratedDir, privateEntries } from "./worktreeInclude.js";
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
//     (`node_modules`, build output) or a private file — a file, or a file in
//     a directory, the copy step would have brought across — that still
//     matches the project's copy.
//
// Anything else — a scratch file, an edited `.env`, a locked worktree — keeps
// the directory, and the next pass asks again. The thread itself is untouched:
// opening it again builds a fresh worktree on the branch it left behind.

export type { IdleWorktree };

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
    // The worktree's private entries, by the project's rules: what the copy
    // step brought in, plus anything since that the same rules would pick.
    const kept = await privateEntries(dir, entry.projectPath);
    const isPrivate = (rel: string) => kept.some((p) => rel === p || rel.startsWith(`${p}/`));
    for (const item of await ignoredEntries(dir)) {
      const rel = item.replace(/\/$/, "");
      if (rel.split("/").some(isRegeneratedDir)) continue;
      // A directory holding nothing private keeps the worktree without its
      // contents being read one by one.
      if (!isPrivate(rel) && !kept.some((p) => p.startsWith(`${rel}/`))) return { ok: false, reason: `keeps ${rel}` };
      const files = item.endsWith("/") ? await filesUnder(dir, rel) : [rel];
      for (const file of files) {
        if (isPrivate(file) && (await sameFile(entry.projectPath, dir, file))) continue;
        return { ok: false, reason: `keeps ${file}` };
      }
    }
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  return { ok: true, branch };
}

/** Every file under a directory, relative to `root`, outside the directories
 *  a tool regenerates. */
async function filesUnder(root: string, rel: string): Promise<string[]> {
  const entries = await readdir(path.join(root, rel), { recursive: true, withFileTypes: true });
  return entries
    .filter((item) => !item.isDirectory())
    .map((item) => path.relative(root, path.join(item.parentPath, item.name)).split(path.sep).join("/"))
    .filter((file) => !file.split("/").some(isRegeneratedDir));
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

/** The first pass waits out the busy start; later ones run a few times a day,
 *  since "days old" does not need finer than that. */
const SWEEP_DELAY_MS = 5 * 60 * 1000;
const SWEEP_EVERY_MS = 6 * 60 * 60 * 1000;

/** Sweep on a schedule for as long as the app runs. Answers the stop. Timers
 *  are unref'd, so a pending pass never holds the process open. */
export function startWorktreeSweeper(run: () => Promise<number>): () => void {
  let every: ReturnType<typeof setInterval> | null = null;
  const first = setTimeout(() => {
    void run();
    every = setInterval(() => void run(), SWEEP_EVERY_MS);
    every.unref?.();
  }, SWEEP_DELAY_MS);
  first.unref?.();
  return () => {
    clearTimeout(first);
    if (every) clearInterval(every);
  };
}
