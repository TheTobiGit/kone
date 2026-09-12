import { mkdir, readdir, rm } from "node:fs/promises";
import path from "node:path";

import { GitError, git, pathExists, repoRoot } from "@kone/git-core/core.js";
import type { CreateWorktreeOptions, GitWorktree } from "@kone/git-core/types.js";
import { addWorktree, attachWorktree, branchExists, canonical, removeWorktree, worktrees } from "./worktree.js";
import {
  generatedBranchName,
  isGeneratedBranchName,
  isInsideWorktreesRoot,
  worktreeDirFor,
  worktreesRoot,
} from "./worktreePaths.js";

// Building a thread's worktree: the one call that turns "this conversation
// wants its own branch" into a directory on disk.
//
// It sits above `worktree.ts` rather than inside it because it does things a
// plumbing module should not: it decides where the directory goes, it invents a
// branch name when the user supplied none, and it reaches for submodules. The
// module underneath stays a thin, predictable wrapper around git.
//
// Two behaviours are worth stating up front, because both are the difference
// between a feature and a mess:
//
// Asking twice gives one worktree. A thread that already has a worktree on the
// branch it asked for gets that worktree back, not a second one — the directory
// is derived from the project and branch rather than minted, so the idempotent
// answer is the natural one.
//
// A failed build leaves nothing behind. Whatever was made is unmade in reverse
// order, and a rollback that itself fails is logged rather than allowed to
// replace the error that caused it. A half-built worktree that survives is
// worse than one that never existed: the branch is taken, the path is taken,
// and nothing owns either.

export type ProvisionedWorktree = {
  path: string;
  branch: string;
  /** kone invented this name, so kone may clean it up later. A branch the user
   *  named is never auto-deleted. */
  generatedBranch: boolean;
  /** The branch already existed and was moved into this worktree, rather than
   *  created for it. Its history is not ours to discard. */
  attachedExisting: boolean;
};

export type ProvisionWorktreeInput = {
  /** The project this conversation belongs to. Not where the worktree goes. */
  projectPath: string;
  /** The branch to create. A generated `kone/<hex>` name is used when absent. */
  branch?: string | null;
  /** Ref the branch starts from. Defaults to the project's HEAD. */
  base?: string | null;
};

/** Whether a directory is absent or present-but-empty — the two cases
 *  `git worktree add` accepts. A non-empty directory is a refusal, and the
 *  path is derived rather than chosen, so there is nowhere else to put it. */
async function isUsableTarget(target: string): Promise<boolean> {
  if (!(await pathExists(target))) return true;
  try {
    return (await readdir(target)).length === 0;
  } catch {
    return false;
  }
}

/** Populate submodules in a freshly created worktree. `git worktree add` does
 *  not do this — a limitation of git, not a failure of ours — so a project with
 *  submodules would otherwise come up with empty directories where they belong.
 *
 *  Best effort throughout. A submodule that will not initialize (no network, a
 *  private URL, a broken pointer) is a worse worktree, not a failed one, and
 *  must not tear down work the user is waiting on. */
async function populateSubmodules(worktreePath: string): Promise<void> {
  if (!(await pathExists(path.join(worktreePath, ".gitmodules")))) return;
  try {
    await git(worktreePath, ["submodule", "update", "--init", "--recursive"], {
      timeoutMs: 5 * 60_000,
    });
  } catch (err) {
    console.error("[git] could not populate submodules in the new worktree:", err);
  }
}

/** Undo a directory this call created. Guarded by containment: only something
 *  under the managed root is ever removed, so a bug in path derivation cannot
 *  turn into a delete somewhere that matters.
 *
 *  When git already lists the target — the reconciliation after `worktree add`
 *  can fail that way, with the registration in place — the removal goes
 *  through git so the registration goes with the directory. Deleting the
 *  directory out from under a registration strands it: the branch reads as
 *  taken by a worktree that is gone. Only a target git has no record of is
 *  deleted blind. */
export async function rollbackDirectory(
  project: string,
  root: string,
  target: string,
): Promise<void> {
  if (!isInsideWorktreesRoot(root, target)) return;
  let registered = false;
  try {
    const canonicalTarget = await canonical(target);
    registered = (await worktrees(project)).some(
      (worktree) => worktree.path === canonicalTarget,
    );
  } catch {
    registered = false;
  }
  if (registered) {
    try {
      await removeWorktree(project, { path: target, force: true });
    } catch (err) {
      console.error("[git] could not remove a failed worktree:", err);
    }
    return;
  }
  try {
    await rm(target, { recursive: true, force: true });
  } catch (err) {
    console.error("[git] could not clean up a failed worktree directory:", err);
  }
}

/**
 * Create — or recover — the worktree a conversation runs in.
 *
 * Returns the directory and the branch it is on. Throws with a classified kind
 * when git refuses; the caller decides whether that ends the send.
 */
export async function provisionWorktree(
  input: ProvisionWorktreeInput,
): Promise<ProvisionedWorktree> {
  const project = await repoRoot(input.projectPath);
  if (!project) {
    throw GitError.classified(
      "NOT_A_REPO",
      `Not a git repository: ${input.projectPath}`,
    );
  }

  const named = input.branch?.trim();
  const branch = named || generatedBranchName();
  const generatedBranch = !named && isGeneratedBranchName(branch);
  const root = worktreesRoot();
  const target = worktreeDirFor({ root, projectPath: project, branch });

  // A worktree already on this branch is adopted rather than refused. Two
  // different situations land here and both want the same answer: a thread
  // reopening on the branch it already owns, and a user who picked a branch they
  // had already checked out somewhere by hand. Git would refuse to create a
  // second worktree for one branch in any case, and the existing directory is
  // what the thread was asking for.
  //
  // Deliberately not restricted to the managed root — a worktree the user made
  // themselves is still the place that branch lives. It is never removed
  // automatically; only directories under the managed root are.
  //
  // The project's own checkout is excluded. Adopting it would hand a thread that
  // asked for isolation the shared tree everything else uses, recorded as though
  // it were a worktree — the precise lie this feature exists to end. Asking for
  // the branch the project is sitting on is refused below, naming where it is.
  const existing = (await worktrees(project)).find(
    (worktree) => !worktree.main && worktree.branch === branch,
  );
  if (existing) return { path: existing.path, branch, generatedBranch, attachedExisting: true };

  if (!(await isUsableTarget(target))) {
    throw GitError.classified(
      "WORKTREE_PATH_EXISTS",
      `A directory is already in the way at '${target}'.`,
    );
  }

  // The parent only — `git worktree add` wants to make the leaf itself, and an
  // empty leaf is accepted but a pre-made one buys nothing.
  await mkdir(path.dirname(target), { recursive: true });

  // An existing branch is moved into a directory of its own rather than
  // refused. A user picking a branch from the list is asking to work on that
  // branch, and creating `<name>-2` beside it would be answering a different
  // question. Only a branch nothing holds reaches here — one already in a
  // worktree was adopted above.
  const attaching = await branchExists(project, branch);

  let created: GitWorktree;
  try {
    if (attaching) {
      created = await attachWorktree(project, { path: target, branch });
    } else {
      const request: CreateWorktreeOptions = { path: target, branch };
      const base = input.base?.trim();
      if (base) request.base = base;
      created = await addWorktree(project, request);
    }
  } catch (error) {
    // `addWorktree` already undoes a branch it created; the directory is ours.
    await rollbackDirectory(project, root, target);
    throw error;
  }

  await populateSubmodules(created.path);
  return { path: created.path, branch, generatedBranch, attachedExisting: attaching };
}
