import { isInsideWorktreesRoot, worktreesRoot } from "./worktreePaths.js";

// Removing the directories a deleted thread leaves behind.
//
// A thread that ran in its own worktree owns a directory git still lists after
// the thread's rows are gone. Deleting the rows without removing the directory
// strands it: the branch is taken, the path is taken, and nothing owns either.
// So the delete path collects what the subtree owned BEFORE the rows go, and
// removes what nothing else still names AFTER they went.
//
// Two phases, because the rows vanish in between:
//
//   collectSubtreeWorktrees(store, threadId)   — before store.deleteThread
//   removeCollectedWorktrees(targets, deps)    — after a successful delete
//
// Everything here is best-effort and never throws: a worktree left behind is
// untidy, but a failed cleanup that masks a successful delete — or fails the
// delete itself — is worse. Callers await the removal only to keep teardown
// ordered, not to learn whether it worked.

/** The store surface the cleanup reads. Structural so tests hand a stub. */
export type WorktreeCleanupStore = {
  subtreeWorkspaces: (
    threadId: string,
  ) => Array<{ threadId: string; projectPath: string; worktreePath: string }>;
  isWorktreePathReferenced: (worktreePath: string) => boolean;
};

/** One directory a deleted subtree may have orphaned, and the project whose
 *  repository it was built from. */
export type DoomedWorktree = {
  projectPath: string;
  worktreePath: string;
};

/** What the removal phase needs from git. `remove` is `removeWorktree` with
 *  force and generated-branch reclaim already chosen; `isManaged` defaults to
 *  the containment check below. Injected so tests never touch a repository. */
export type WorktreeRemovalDeps = {
  isReferenced: (worktreePath: string) => boolean;
  remove: (projectPath: string, worktreePath: string) => Promise<void>;
  isManaged?: (worktreePath: string) => boolean;
};

function isNonBlank(value: string | null | undefined): value is string {
  return value !== null && value !== undefined && value.trim() !== "";
}

/** Snapshot the subtree's worktree directories before the delete drops the
 *  rows that name them. One entry per unique directory — siblings that share
 *  one (a thread reopened onto its predecessor's directory) clean it once. */
export function collectSubtreeWorktrees(
  store: WorktreeCleanupStore,
  threadId: string,
): DoomedWorktree[] {
  let owned: ReturnType<WorktreeCleanupStore["subtreeWorkspaces"]>;
  try {
    owned = store.subtreeWorkspaces(threadId);
  } catch (error) {
    console.warn(
      `[git] could not list worktrees for deleted thread '${threadId}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
  const seen = new Set<string>();
  const out: DoomedWorktree[] = [];
  for (const workspace of owned) {
    if (!isNonBlank(workspace.projectPath) || !isNonBlank(workspace.worktreePath)) continue;
    if (seen.has(workspace.worktreePath)) continue;
    seen.add(workspace.worktreePath);
    out.push({ projectPath: workspace.projectPath, worktreePath: workspace.worktreePath });
  }
  return out;
}

/** Remove every collected directory nothing else still names. A path another
 *  thread adopted after the delete is left alone; a path outside the managed
 *  root is left alone too — adopting a worktree the user made by hand must not
 *  become deleting it. */
export async function removeCollectedWorktrees(
  targets: DoomedWorktree[],
  deps: WorktreeRemovalDeps,
): Promise<void> {
  // Resolved lazily: tests that inject isManaged never need the real root, and
  // a state dir that cannot resolve must not fail a cleanup with nothing to do.
  let root: string | null = null;
  const isManaged = (worktreePath: string): boolean => {
    if (deps.isManaged) return safeIsManaged(deps.isManaged, worktreePath);
    try {
      if (!root) root = worktreesRoot();
      return isInsideWorktreesRoot(root, worktreePath);
    } catch (error) {
      console.warn(
        `[git] could not resolve the managed worktrees root: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  };
  for (const target of targets) {
    let referenced = true;
    try {
      referenced = deps.isReferenced(target.worktreePath);
    } catch (error) {
      console.warn(
        `[git] could not check references to '${target.worktreePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
      continue;
    }
    if (referenced) continue;
    if (!isManaged(target.worktreePath)) continue;
    try {
      await deps.remove(target.projectPath, target.worktreePath);
    } catch (error) {
      console.warn(
        `[git] could not remove worktree '${target.worktreePath}': ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}

function safeIsManaged(check: (worktreePath: string) => boolean, worktreePath: string): boolean {
  try {
    return check(worktreePath);
  } catch (error) {
    console.warn(
      `[git] could not check managed root for '${worktreePath}': ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}
