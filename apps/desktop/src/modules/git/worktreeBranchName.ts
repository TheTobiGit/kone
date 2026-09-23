import { git, repoRoot } from "@kone/git-core/core.js";
import { withRepoMutation } from "./mutationLock.js";
import { isGeneratedBranchName, sanitizeBranchSegment } from "./worktreePaths.js";

// Giving a worktree's branch a name a person can read.
//
// A worktree is built before anyone knows what the thread is about, so its
// branch starts as a placeholder — `kone/1a2b3c4d`. Once the thread has a
// title, the placeholder becomes `kone/<the title, as a branch name>`, which is
// what the branch list, a pull request and a teammate will see.
//
// Only a placeholder is ever renamed. A branch a person named, or one that has
// already been renamed, keeps its name: the pattern is the whole guard, and it
// is the same one that decides which branches kone may delete.
//
// A renamed branch is still kone's, so it is marked as such in the repository's
// own config. Deleting the thread then reclaims it exactly as it would have
// reclaimed the placeholder, and a branch a person named is never marked.

const OWNED_KEY = "kone-owned";
const PREFIX = "kone/";
/** How many `-2`, `-3`… suffixes to try before giving up on a readable name. */
const MAX_SUFFIX = 100;

/** The readable half of a branch name for a title, or null when the title has
 *  nothing a branch name can carry (all punctuation, or another script). */
export function branchSlugFromTitle(title: string): string | null {
  const slug = sanitizeBranchSegment(title);
  // The sanitizer answers `update` when nothing survives; that is a fallback
  // for directory names, not a name worth renaming a branch to.
  if (slug === "update" && !/update/i.test(title)) return null;
  return slug;
}

async function branchTaken(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Whether kone may treat this branch as its own: a placeholder name, or one
 *  kone renamed from a placeholder and marked. */
export async function isKoneOwnedBranch(dir: string, branch: string): Promise<boolean> {
  if (isGeneratedBranchName(branch)) return true;
  try {
    const value = (await git(dir, ["config", "--get", `branch.${branch}.${OWNED_KEY}`])).trim();
    return value === "true";
  } catch {
    return false;
  }
}

/** Drop the ownership mark once the branch itself is gone. Best effort. */
export async function forgetKoneOwnedBranch(dir: string, branch: string): Promise<void> {
  await git(dir, ["config", "--unset", `branch.${branch}.${OWNED_KEY}`]).catch(() => undefined);
}

/**
 * Rename the placeholder branch a worktree is on after the thread's title.
 * Returns the new name, or null when there was nothing to rename — a branch
 * that is not a placeholder, a title with no usable words, a detached checkout.
 * Never throws: a thread keeps working on its placeholder either way.
 */
export async function renameGeneratedBranch(
  worktreePath: string,
  title: string,
): Promise<string | null> {
  try {
    const current = (await git(worktreePath, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
    if (!isGeneratedBranchName(current)) return null;
    const slug = branchSlugFromTitle(title);
    if (!slug) return null;
    const root = await repoRoot(worktreePath);
    if (!root) return null;

    return await withRepoMutation(root, async () => {
      let target = `${PREFIX}${slug}`;
      for (let n = 2; await branchTaken(root, target); n++) {
        if (n > MAX_SUFFIX) return null;
        target = `${PREFIX}${slug}-${n}`;
      }
      await git(worktreePath, ["branch", "-m", "--", current, target]);
      await git(root, ["config", `branch.${target}.${OWNED_KEY}`, "true"]).catch((err: unknown) => {
        console.warn(`[git] could not mark '${target}' as kone's own:`, err);
      });
      return target;
    });
  } catch (err) {
    console.warn("[git] could not give the worktree branch a readable name:", err);
    return null;
  }
}
