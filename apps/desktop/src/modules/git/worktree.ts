import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

import { GitError, git, repoRoot } from "@kone/git-core/core.js";
import { withRepoMutation } from "./mutationLock.js";
import { isGeneratedBranchName } from "./worktreePaths.js";
import type { CreateWorktreeOptions, GitWorktree } from "@kone/git-core/types.js";

// Linked worktrees: additional checkouts of one repository, each on its own
// branch, sharing a single `.git`.
//
// Three things shape this module.
//
// Parsing is `-z` only. The text form of `worktree list --porcelain` C-quotes a
// lock reason that contains a newline; the `-z` form emits the reason raw and
// terminates every field with a NUL, so a reason carrying newlines, quotes or
// backslashes survives without an unescaping step. Records are separated by an
// empty field (a double NUL), exactly as the text form separates them with a
// blank line.
//
// Failures are classified where git ran. The same operation fails with exit 1,
// 128 or 255 depending on which refusal it hit, and a dirty worktree and a
// locked one both exit 128 with only the wording to tell them apart — so the
// exit code cannot carry the meaning and nothing downstream should try to
// recover it by matching on prose.
//
// Writes go through the repo mutation queue, which keys on the git common dir
// rather than the working tree. A worktree and its primary checkout therefore
// share one queue and cannot race each other for the shared index and refs.

/** `worktree add` writes out a whole tree; `remove` deletes one. Both scale
 *  with the repository and would lose to the default exec ceiling on a large
 *  one, so they get their own. */
const WORKTREE_EXEC_TIMEOUT_MS = 5 * 60_000;

/** Ordered because the patterns overlap: a path collision and an existing
 *  branch both say "already exists", and a stale registration says it too.
 *  First match wins, so the specific readings precede the general one. */
const WORKTREE_ERROR_PATTERNS = [
  [/is already used by worktree at/i, "WORKTREE_BRANCH_IN_USE"],
  [/a branch named .* already exists/i, "WORKTREE_BRANCH_EXISTS"],
  [/is a missing but already registered worktree/i, "WORKTREE_STALE_REGISTRATION"],
  [/contains modified or untracked files/i, "WORKTREE_DIRTY"],
  [/cannot remove a locked working tree/i, "WORKTREE_LOCKED"],
  [/is a main working tree/i, "WORKTREE_IS_MAIN"],
  [/already exists/i, "WORKTREE_PATH_EXISTS"],
] as const;

/** The same failure carrying the kind its message names, so callers branch on a
 *  kind instead of on git's wording. An unrecognized failure comes back
 *  untouched. */
function classifyWorktreeError(error: GitError): GitError {
  for (const [pattern, kind] of WORKTREE_ERROR_PATTERNS) {
    if (pattern.test(error.message)) {
      return GitError.classified(kind, error.message, error.code, error.stdout);
    }
  }
  return error;
}

/** Resolve symlinks so a path can be compared with one git reported. On macOS
 *  `/tmp` and `/var` are symlinks into `/private`, and git canonicalizes while
 *  a path assembled from arguments does not — two strings naming one directory
 *  will not compare equal until both have been through here. Falls back to
 *  resolving the nearest existing ancestor, so a path that does not exist yet
 *  still canonicalizes. */
export async function canonical(target: string): Promise<string> {
  const absolute = path.resolve(target);
  try {
    return await realpath(absolute);
  } catch {
    // Not there yet — canonicalize the parent and re-attach the leaf.
  }
  const parent = path.dirname(absolute);
  if (parent === absolute) return absolute;
  try {
    return path.join(await realpath(parent), path.basename(absolute));
  } catch {
    return absolute;
  }
}

/** Refuse an argument that git would read as an option. Every value this module
 *  passes to git is either a path or a ref supplied from outside. */
function assertNotOption(value: string, label: string): void {
  if (value.startsWith("-")) {
    throw GitError.classified("INVALID_INPUT", `Invalid ${label}: ${value}`);
  }
}

/** One `worktree list --porcelain -z` record, mid-parse. `main` is decided by
 *  position afterwards and `path` is canonicalized afterwards, so neither is
 *  set here. */
type ParsedWorktree = Omit<GitWorktree, "main">;

function emptyRecord(worktreePath: string): ParsedWorktree {
  return {
    path: worktreePath,
    head: null,
    branch: null,
    detached: false,
    bare: false,
    locked: false,
    lockReason: null,
    prunableReason: null,
  };
}

/** Split a porcelain field into its key and the rest. Label-only fields
 *  (`detached`, `bare`, and an unexplained `locked`) have no value. */
function splitField(field: string) {
  const space = field.indexOf(" ");
  if (space === -1) return { key: field, value: "" };
  return { key: field.slice(0, space), value: field.slice(space + 1) };
}

export function parseWorktreePorcelain(out: string): ParsedWorktree[] {
  const records: ParsedWorktree[] = [];
  let current: ParsedWorktree | null = null;

  const flush = (): void => {
    if (current) records.push(current);
    current = null;
  };

  for (const field of out.split("\0")) {
    // An empty field is a record boundary; trailing NULs produce several.
    if (field === "") {
      flush();
      continue;
    }
    const { key, value } = splitField(field);
    if (key === "worktree") {
      // Always the first field of a record, so it also closes the previous one
      // even if the boundary was somehow lost.
      flush();
      current = emptyRecord(value);
      continue;
    }
    if (!current) continue;
    switch (key) {
      case "HEAD":
        current.head = value;
        break;
      case "branch":
        current.branch = value.replace(/^refs\/heads\//, "");
        break;
      case "detached":
        current.detached = true;
        break;
      case "bare":
        current.bare = true;
        break;
      case "locked":
        current.locked = true;
        current.lockReason = value.length > 0 ? value : null;
        break;
      case "prunable":
        current.prunableReason = value.length > 0 ? value : "";
        break;
      default:
        break;
    }
  }
  flush();
  return records;
}

/** Every worktree of `dir`'s repository, the primary checkout first — git's own
 *  ordering, which is by role and not by path. */
export async function worktrees(dir: string): Promise<GitWorktree[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  const out = await git(root, ["worktree", "list", "--porcelain", "-z"]);
  const parsed = parseWorktreePorcelain(out);
  return Promise.all(
    parsed.map(async (record, index) => ({
      ...record,
      path: await canonical(record.path),
      main: index === 0,
    })),
  );
}

/** The primary checkout's directory. `--git-common-dir` points at the shared
 *  `.git` from anywhere in the repository, including from inside a linked
 *  worktree, and its parent is the primary tree. */
async function primaryCheckout(root: string): Promise<string> {
  const raw = (await git(root, ["rev-parse", "--git-common-dir"])).trim();
  return canonical(path.dirname(path.resolve(root, raw)));
}

/** Whether a branch already has a ref. */
export async function branchExists(root: string, branch: string): Promise<boolean> {
  try {
    await git(root, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]);
    return true;
  } catch {
    return false;
  }
}

/** Undo a branch this call created after a later step failed. Compare-and-swap
 *  on the commit we created it at, so a concurrent process that has already
 *  moved the ref keeps its work. Best effort — a rollback that fails must not
 *  replace the error that caused it. */
async function rollbackBranch(root: string, branch: string, sha: string): Promise<void> {
  try {
    await git(root, ["update-ref", "-d", `refs/heads/${branch}`, sha]);
  } catch {
    // The ref moved, was already gone, or is still held. Leave it.
  }
}

/**
 * Create a worktree at `input.path` on a new branch `input.branch`, started
 * from `input.base` (HEAD by default).
 *
 * The base is resolved to a commit before git is invoked, and the resolved SHA
 * is what gets passed — a ref name reaching `worktree add` unresolved can be
 * ambiguous between a branch and a tag, and resolving first turns that into a
 * clear failure here rather than a surprising checkout.
 *
 * The two refusals worth pre-checking are checked: a branch already in use by
 * another worktree, and a branch that merely exists. Both are things the caller
 * can act on, and both produce a better message here than the stderr would.
 */
export async function addWorktree(
  dir: string,
  input: CreateWorktreeOptions,
): Promise<GitWorktree> {
  const branch = input.branch.trim();
  if (!branch) {
    throw GitError.classified("INVALID_INPUT", "A branch name is required.");
  }
  assertNotOption(branch, "branch name");

  const target = path.resolve(input.path);
  if (!path.isAbsolute(input.path)) {
    throw GitError.classified(
      "INVALID_INPUT",
      `A worktree path must be absolute: ${input.path}`,
    );
  }
  assertNotOption(input.path, "worktree path");

  const root = await repoRoot(dir);
  if (!root) {
    throw GitError.classified("NOT_A_REPO", `Not a git repository: ${dir}`);
  }

  const base = input.base?.trim() || "HEAD";
  assertNotOption(base, "base ref");
  let baseSha: string;
  try {
    const out = await git(root, [
      "rev-parse",
      "--verify",
      "--end-of-options",
      `${base}^{commit}`,
    ]);
    baseSha = out.trim();
  } catch {
    throw GitError.classified("NOT_FOUND", `No such commit: ${base}`);
  }

  const existing = await worktrees(root);
  const holder = existing.find((worktree) => worktree.branch === branch);
  if (holder) {
    throw GitError.classified(
      "WORKTREE_BRANCH_IN_USE",
      `'${branch}' is already used by worktree at '${holder.path}'`,
    );
  }
  if (await branchExists(root, branch)) {
    throw GitError.classified(
      "WORKTREE_BRANCH_EXISTS",
      `a branch named '${branch}' already exists`,
    );
  }

  await withRepoMutation(root, async () => {
    try {
      await git(
        root,
        ["worktree", "add", "-b", branch, target, baseSha],
        { timeoutMs: WORKTREE_EXEC_TIMEOUT_MS },
      );
    } catch (error) {
      // `worktree add` can leave the branch behind when the checkout is what
      // failed. Nothing here existed before this call — the pre-checks proved
      // the branch was absent — so removing it is safe.
      if (await branchExists(root, branch)) await rollbackBranch(root, branch, baseSha);
      if (error instanceof GitError) throw classifyWorktreeError(error);
      throw error;
    }
  });

  const canonicalTarget = await canonical(target);
  const created = (await worktrees(root)).find(
    (worktree) => worktree.path === canonicalTarget,
  );
  if (!created) {
    throw GitError.classified(
      "INTERNAL",
      `The worktree at '${target}' was created but git does not list it.`,
    );
  }
  return created;
}

/**
 * Create a worktree at `path` for a branch that already exists.
 *
 * The counterpart to `addWorktree`: that one mints a branch, this one moves an
 * existing one into a directory of its own. Git refuses either way if another
 * worktree already holds the branch, so the same pre-check applies — and the
 * refusal names the worktree that has it, which is what the caller needs to
 * offer opening that one instead.
 */
export async function attachWorktree(
  dir: string,
  input: { path: string; branch: string },
): Promise<GitWorktree> {
  const branch = input.branch.trim();
  if (!branch) {
    throw GitError.classified("INVALID_INPUT", "A branch name is required.");
  }
  assertNotOption(branch, "branch name");

  const target = path.resolve(input.path);
  if (!path.isAbsolute(input.path)) {
    throw GitError.classified(
      "INVALID_INPUT",
      `A worktree path must be absolute: ${input.path}`,
    );
  }
  assertNotOption(input.path, "worktree path");

  const root = await repoRoot(dir);
  if (!root) {
    throw GitError.classified("NOT_A_REPO", `Not a git repository: ${dir}`);
  }

  if (!(await branchExists(root, branch))) {
    throw GitError.classified("NOT_FOUND", `No such branch: ${branch}`);
  }
  const holder = (await worktrees(root)).find((worktree) => worktree.branch === branch);
  if (holder) {
    throw GitError.classified(
      "WORKTREE_BRANCH_IN_USE",
      `'${branch}' is already used by worktree at '${holder.path}'`,
    );
  }

  await withRepoMutation(root, async () => {
    try {
      await git(
        root,
        ["worktree", "add", target, branch],
        { timeoutMs: WORKTREE_EXEC_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof GitError) throw classifyWorktreeError(error);
      throw error;
    }
  });

  const canonicalTarget = await canonical(target);
  const created = (await worktrees(root)).find(
    (worktree) => worktree.path === canonicalTarget,
  );
  if (!created) {
    throw GitError.classified(
      "INTERNAL",
      `The worktree at '${target}' was created but git does not list it.`,
    );
  }
  return created;
}

/**
 * Remove a worktree and unregister it.
 *
 * Always runs from the primary checkout. `git worktree remove .` from inside
 * the worktree being removed succeeds and deletes the directory out from under
 * the process, leaving it with a working directory that no longer exists.
 *
 * `force` covers a worktree with uncommitted or untracked changes — a
 * deliberate, destructive choice the caller has to make. It does **not** cover
 * a locked worktree: git requires a doubled force for that, which this module
 * does not offer. A locked worktree is unlocked on purpose or not removed.
 *
 * `reclaimGeneratedBranch` additionally deletes the worktree's branch, but
 * only when kone generated its name (`kone/<hex>`, the only names kone may
 * clean up). A branch a person named is never touched, whatever this flag
 * says. The name and its HEAD are read from the checkout BEFORE the removal —
 * afterwards the directory is gone and can no longer answer — and the ref is
 * deleted compare-and-swap against that HEAD, so a concurrent process that
 * repointed the branch since keeps its work. Reclaim failures are logged, never
 * thrown: the removal already succeeded, and a stranded branch is untidy where
 * a failed removal is a lie.
 */
export async function removeWorktree(
  dir: string,
  input: { path: string; force?: boolean; reclaimGeneratedBranch?: boolean },
): Promise<void> {
  assertNotOption(input.path, "worktree path");
  const root = await repoRoot(dir);
  if (!root) {
    throw GitError.classified("NOT_A_REPO", `Not a git repository: ${dir}`);
  }

  const primary = await primaryCheckout(root);
  const target = await canonical(input.path);
  if (target === primary) {
    throw GitError.classified(
      "WORKTREE_IS_MAIN",
      `'${target}' is a main working tree`,
    );
  }

  // What sits on this checkout, resolved while it can still be asked. Detached
  // checkouts answer non-zero here and user-named branches fail the pattern, so
  // both resolve to no reclaim without a special case each.
  let reclaim: { branch: string; head: string } | null = null;
  if (input.reclaimGeneratedBranch) {
    try {
      const branch = (await git(target, ["symbolic-ref", "--quiet", "--short", "HEAD"])).trim();
      if (isGeneratedBranchName(branch)) {
        const head = (
          await git(target, ["rev-parse", "--verify", `refs/heads/${branch}`])
        ).trim();
        if (head) reclaim = { branch, head };
      }
    } catch {
      // Gone already, detached, or otherwise unreadable: removal proceeds
      // without a reclaim, and whatever is left is git's to report.
      reclaim = null;
    }
  }

  await withRepoMutation(primary, async () => {
    try {
      await git(
        primary,
        ["worktree", "remove", ...(input.force ? ["--force"] : []), target],
        { timeoutMs: WORKTREE_EXEC_TIMEOUT_MS },
      );
    } catch (error) {
      if (error instanceof GitError) throw classifyWorktreeError(error);
      throw error;
    }
    // Copied to a const so the non-null check below survives into the closure.
    const claimed = reclaim;
    if (claimed) {
      try {
        // One branch lives in at most one worktree, so a successful removal
        // leaves this name held by nothing — but only delete what is still
        // unheld, in case another worktree took the name concurrently.
        const held = (await worktrees(primary)).some(
          (worktree) => worktree.branch === claimed.branch,
        );
        if (!held) {
          await git(primary, [
            "update-ref",
            "-d",
            `refs/heads/${claimed.branch}`,
            claimed.head,
          ]);
        }
      } catch (error) {
        console.warn(
          `[git] could not reclaim generated branch '${claimed.branch}': ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  });
}

/**
 * Unregister worktrees whose directories are gone, and return the paths that
 * were dropped.
 *
 * This takes effect immediately: without `--expire` there is no grace period.
 * (The three-month window is `gc.worktreePruneExpire`, which governs only
 * pruning that gc initiates.) A locked worktree is never pruned, whatever state
 * its directory is in — it has to be unlocked first.
 *
 * What was pruned is worked out by comparing the list either side of the run
 * rather than read from `--verbose`, which writes to stderr and names git's
 * internal admin entries instead of the directories a caller knows.
 */
export async function pruneWorktrees(dir: string): Promise<string[]> {
  const root = await repoRoot(dir);
  if (!root) return [];
  return withRepoMutation(root, async () => {
    const before = await worktrees(root);
    await git(root, ["worktree", "prune"]);
    const after = new Set((await worktrees(root)).map((worktree) => worktree.path));
    return before
      .filter((worktree) => !after.has(worktree.path))
      .map((worktree) => worktree.path);
  });
}

/**
 * Whether `root` is a linked worktree rather than an ordinary checkout.
 *
 * A linked worktree's `.git` is a file pointing at
 * `<common>/worktrees/<id>`. A submodule's `.git` is a file of exactly the same
 * shape pointing at `<super>/modules/<name>`, so the discriminator is the
 * second-to-last path segment — compared as a segment, because a directory
 * merely named `my-worktrees-backup` must not match.
 *
 * The common dir is deliberately not required to be named `.git`: a worktree of
 * a bare repository points into `<repo>.git/worktrees/<id>`, and `GIT_COMMON_DIR`
 * can be set to anything at all.
 */
export async function isLinkedWorktree(root: string): Promise<boolean> {
  const dotGit = path.join(root, ".git");
  try {
    const info = await stat(dotGit);
    // An ordinary checkout — including a repository that happens to be nested
    // inside a worktree, which is its own repository and not ours.
    if (info.isDirectory()) return false;
  } catch {
    return false;
  }

  let pointer: string;
  try {
    pointer = await readFile(dotGit, "utf8");
  } catch {
    return false;
  }
  const match = /^gitdir:\s*(.+)$/m.exec(pointer);
  const gitdir = match?.[1]?.trim();
  if (!gitdir) return false;

  const segments = gitdir.replace(/\\/g, "/").split("/").filter(Boolean);
  return segments.length >= 3 && segments.at(-2) === "worktrees";
}
