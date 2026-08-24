import { rm } from "node:fs/promises";

import { GitError, assertWithinRepo, git, repoRoot, safeRepoPath } from "@kone/git-core/core.js";
import { withRepoMutation } from "./mutationLock.js";
import { repoState } from "./state.js";
import type { GitCommitOptions } from "@kone/git-core/types.js";

// Write operations behind the changes UI. Each resolves the repo root and runs
// git; the caller learns the resulting state from the watcher's next status push.
// Overlapping writes from the UI (a stage and an unstage racing, two files
// staged together) must never run two git processes against the same index at
// once, so every write runs inside withRepoMutation.

/** Stage the given repo-relative paths — added, modified and deleted alike. */
export async function stage(dir: string, paths: string[]): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || paths.length === 0) return;
    assertWithinRepo(root, paths);
    await git(root, ["add", "--", ...paths]);
  });
}

/** Unstage the given paths (index back to HEAD) without touching the working
 *  tree. A no-op for paths that weren't staged. */
export async function unstage(dir: string, paths: string[]): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || paths.length === 0) return;
    assertWithinRepo(root, paths);
    await git(root, ["reset", "-q", "--", ...paths]);
  });
}

/** Switch the working tree to `branch` — a local branch name as reported by
 *  `branches()`. Git refuses (and this throws GitError) when the checkout would
 *  clobber conflicting local changes; the message is surfaced to the caller so
 *  the UI can explain the failure. The open project's watcher pushes the new
 *  status once the switch lands. */
export async function checkout(dir: string, branch: string): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || !branch.trim()) return;
    await git(root, ["checkout", branch]);
  });
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
  return withRepoMutation(dir, async () => {
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
  });
}

// ── commit ───────────────────────────────────────────────────────────────────

/** Commit the staged changes. The message is split into subject + body: a
 *  subject is always its own `-m`, a non-empty body a second one (the same
 *  `noVerify` skips hooks. */
export async function commit(dir: string, opts: GitCommitOptions): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const message = opts.message.trim();
    if (!message) throw new GitError("Commit message is empty.", null);
    const first = message.split("\n")[0] ?? "";
    const rest = message.split("\n").slice(1);
    const subject = first.trim();
    const body = opts.body?.trim() || rest.join("\n").trim();

    if (!opts.amend) {
      // Reject the empty commit ourselves — git's advice block is a wall of text
      // and the renderer prints our message verbatim. `git diff --cached --quiet`
      // exits 1 exactly when something is staged (and works pre-first-commit).
      let staged = false;
      try {
        await git(root, ["diff", "--cached", "--quiet"]);
      } catch (error) {
        if (error instanceof GitError && error.code === 1) staged = true;
        else throw error;
      }
      if (!staged) {
        throw new GitError(
          "Nothing staged to commit — stage changes first, or amend the last commit.",
          null,
        );
      }
    }

    const args = ["commit", "-m", subject];
    if (body) args.push("-m", body);
    if (opts.amend) args.push("--amend");
    if (opts.noVerify) args.push("--no-verify");
    await git(root, args);
  });
}

// ── branch operations ────────────────────────────────────────────────────────

/** Create a local branch, optionally from a start point and/or switching to it.
 *
 * The switch is the risky step (it refuses when the working tree has changes
 * that would be clobbered), and the branch is created before it — the same
 * the switch fails, the branch is rolled back (`git branch -D`) so the
 * create+switch unit is atomic: a failed "create and switch" must not leave a
 * silently-created branch behind that the UI never shows and that blocks a
 * later retry. `git branch <name>` above would already have failed if the
 * branch existed, so the rollback can only remove the branch this call made —
 * force is safe (nothing can have been committed to it) and required, since
 * `from` may be an unmerged ref. */
export async function createBranch(
  dir: string,
  name: string,
  opts?: { from?: string; checkout?: boolean },
): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || !name.trim()) return;
    const branch = name.trim();
    const args = ["branch", branch];
    if (opts?.from?.trim()) args.push(opts.from.trim());
    await git(root, args);
    if (!opts?.checkout) return;
    try {
      await git(root, ["checkout", branch]);
    } catch (error) {
      await git(root, ["branch", "-D", branch]).catch(() => {
        // The rollback itself failed (repo vanished mid-call, …) — the original
        // checkout error is the one the caller needs.
      });
      throw error;
    }
  });
}

/** Delete a local branch (safe `-d` unless forced) or, with `remote`, a
 *  remote one via `git push <remote> --delete`. */
export async function deleteBranch(
  dir: string,
  name: string,
  opts?: { force?: boolean; remote?: boolean },
): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || !name.trim()) return;
    if (opts?.remote) {
      // "origin/feature" → push origin --delete feature; a bare name deletes
      // on origin.
      const slash = name.indexOf("/");
      const remote = slash > 0 ? name.slice(0, slash) : "origin";
      const branch = slash > 0 ? name.slice(slash + 1) : name;
      await git(root, ["push", remote, "--delete", branch]);
      return;
    }
    await git(root, ["branch", opts?.force ? "-D" : "-d", "--", name.trim()]);
  });
}

export async function renameBranch(dir: string, from: string, to: string): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || !from.trim() || !to.trim()) return;
    await git(root, ["branch", "-m", "--", from.trim(), to.trim()]);
  });
}

/** Merge `name` into the current branch. `--no-edit` keeps a clean merge from
 *  opening an editor (which would block until the process timeout); conflicts
 *  surface as the GitError the masthead prints. */
export async function mergeBranch(
  dir: string,
  name: string,
  opts?: { noFf?: boolean },
): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root || !name.trim()) return;
    const args = ["merge"];
    if (opts?.noFf) args.push("--no-ff");
    args.push("--no-edit", name.trim());
    try {
      await git(root, args);
    } catch (error) {
      // `git merge` writes its conflict report to stdout, not stderr — with an
      // empty stderr the generic fallback would hide "CONFLICT (content): …"
      // from the user. Prefer the captured stdout when it has anything to say.
      if (error instanceof GitError) {
        const conflictReport = error.stdout.trim();
        if (conflictReport) throw new GitError(conflictReport, error.code);
      }
      throw error;
    }
  });
}

// ── mid-operation resume ─────────────────────────────────────────────────────
// Continue / abort whatever `repoState()` reports. The env, not a flag, keeps
// the resume commands from blocking on an editor: `git merge --continue`
// rejects `--no-edit` outright ("--continue expects no arguments"), so the
// editor is silenced via GIT_EDITOR.

/** Resume the in-progress operation (merge/rebase/cherry-pick/revert). */
export async function continueOperation(dir: string): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const state = await repoState(dir);
    if (!state || state.operation === "none") {
      throw new GitError("No operation is in progress to continue.", null);
    }
    switch (state.operation) {
      case "merging":
        await git(root, ["merge", "--continue"], { GIT_EDITOR: "true" });
        return;
      case "rebasing":
        await git(root, ["rebase", "--continue"], { GIT_EDITOR: "true" });
        return;
      case "cherry-picking":
        await git(root, ["cherry-pick", "--continue"], { GIT_EDITOR: "true" });
        return;
      case "reverting":
        await git(root, ["revert", "--continue"], { GIT_EDITOR: "true" });
        return;
      case "bisecting":
        throw new GitError(
          "A bisect has no continue step — mark the current commit good or bad, or run git bisect reset in a terminal.",
          null,
        );
    }
  });
}

/** Abort the in-progress operation, restoring the pre-operation state. */
export async function abortOperation(dir: string): Promise<void> {
  return withRepoMutation(dir, async () => {
    const root = await repoRoot(dir);
    if (!root) return;
    const state = await repoState(dir);
    if (!state || state.operation === "none") {
      throw new GitError("No operation is in progress to abort.", null);
    }
    switch (state.operation) {
      case "merging":
        await git(root, ["merge", "--abort"]);
        return;
      case "rebasing":
        await git(root, ["rebase", "--abort"]);
        return;
      case "cherry-picking":
        await git(root, ["cherry-pick", "--abort"]);
        return;
      case "reverting":
        await git(root, ["revert", "--abort"]);
        return;
      case "bisecting":
        await git(root, ["bisect", "reset"]);
        return;
    }
  });
}
