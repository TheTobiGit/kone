import { rm } from "node:fs/promises";

import { assertWithinRepo, git, repoRoot, safeRepoPath } from "./core.js";

// Write operations behind the changes UI. Each resolves the repo root and runs
// git; the caller learns the resulting state from the watcher's next status push.

/** Stage the given repo-relative paths — added, modified and deleted alike. */
export async function stage(dir: string, paths: string[]): Promise<void> {
  const root = await repoRoot(dir);
  if (!root || paths.length === 0) return;
  assertWithinRepo(root, paths);
  await git(root, ["add", "--", ...paths]);
}

/** Unstage the given paths (index back to HEAD) without touching the working
 *  tree. A no-op for paths that weren't staged. */
export async function unstage(dir: string, paths: string[]): Promise<void> {
  const root = await repoRoot(dir);
  if (!root || paths.length === 0) return;
  assertWithinRepo(root, paths);
  await git(root, ["reset", "-q", "--", ...paths]);
}

/** Switch the working tree to `branch` — a local branch name as reported by
 *  `branches()`. Git refuses (and this throws GitError) when the checkout would
 *  clobber conflicting local changes; the message is surfaced to the caller so
 *  the UI can explain the failure. The open project's watcher pushes the new
 *  status once the switch lands. */
export async function checkout(dir: string, branch: string): Promise<void> {
  const root = await repoRoot(dir);
  if (!root || !branch.trim()) return;
  await git(root, ["checkout", branch]);
}

/** Whether `relPath` exists in the current HEAD commit. */
async function inHead(root: string, relPath: string): Promise<boolean> {
  try {
    await git(root, ["cat-file", "-e", `HEAD:${relPath}`]);
    return true;
  } catch {
    return false;
  }
}

/** Map of renamed-to path → original path, for renames against HEAD (staged or
 *  not). Lets `discard` restore the original rather than delete it — a rename
 *  carries the new path only, so without this the source content is lost. */
async function renameSources(root: string): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  let out: string;
  try {
    out = await git(root, ["diff", "--name-status", "-M", "-z", "HEAD"]);
  } catch {
    return map; // unborn branch / no HEAD — nothing to reconcile
  }
  // -z records are NUL-separated fields: "<status>\0<path>", or for renames /
  // copies "<status>\0<from>\0<to>".
  const fields = out.split("\0");
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i];
    if (!code) continue;
    if (code[0] === "R" || code[0] === "C") {
      const from = fields[i + 1];
      const to = fields[i + 2];
      i += 2;
      if (code[0] === "R" && from && to) map.set(to, from);
    } else {
      i += 1; // single-path record (M / A / D / T …)
    }
  }
  return map;
}

/** Discard the given paths' uncommitted changes — destructive. A file in HEAD is
 *  reset there (reverting staged + working-tree edits and restoring deletions);
 *  a renamed file is put back at its original path; a file with no HEAD version
 *  (new, whether staged or merely untracked) is dropped from the index and
 *  deleted from disk. */
export async function discard(dir: string, paths: string[]): Promise<void> {
  const root = await repoRoot(dir);
  if (!root || paths.length === 0) return;
  assertWithinRepo(root, paths);
  const renames = await renameSources(root);
  for (const relPath of paths) {
    const from = renames.get(relPath);
    if (from) {
      // Restore the original file (in HEAD), then drop the renamed-to copy.
      await git(root, ["checkout", "-q", "HEAD", "--", from]);
      try {
        await git(root, ["rm", "--cached", "--quiet", "--", relPath]);
      } catch {
        // The new path wasn't staged — nothing to unstage.
      }
      const abs = safeRepoPath(root, relPath);
      if (abs) await rm(abs, { recursive: true, force: true });
      continue;
    }
    if (await inHead(root, relPath)) {
      // Resets index + working tree for this path to HEAD in one step.
      await git(root, ["checkout", "-q", "HEAD", "--", relPath]);
    } else {
      // New file: unstage it if it's in the index, then remove it from disk.
      try {
        await git(root, ["rm", "--cached", "--quiet", "--", relPath]);
      } catch {
        // Plain untracked — nothing in the index to drop.
      }
      const abs = safeRepoPath(root, relPath);
      if (abs) await rm(abs, { recursive: true, force: true });
    }
  }
}
