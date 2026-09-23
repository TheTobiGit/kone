import { createHash, randomBytes } from "node:crypto";
import { realpathSync } from "node:fs";
import path from "node:path";

import { userDataPath } from "@kone/agent-core/userDataDir.js";

// Naming and placing a thread's worktree.
//
// Everything here is pure except `worktreesRoot`, so the rules can be tested
// without a filesystem.
//
// Worktrees live under the app's own state directory, never inside the user's
// repository: a directory inside the project tree would show up in the user's
// own status and diffs, and a `git worktree add` into the repo it came from is
// a trap the user has to clean up by hand.
//
// The leaf name carries a short digest as well as the branch. Two reasons, both
// observed rather than assumed: APFS is case-insensitive, so `Feature` and
// `feature` — two genuinely different branches — would land in one directory;
// and the sanitizer is lossy by design, so `fix/a b` and `fix/a-b` collapse to
// the same text. The digest is derived from the project and the branch, so the
// answer for a given pair is stable — asking twice gives the same directory
// rather than a second one.

/** Branch names kone generates when the user names none. Only a branch matching
 *  this may ever be deleted automatically; a name a person chose never is. */
const GENERATED_BRANCH_PREFIX = "kone/";
const GENERATED_BRANCH_PATTERN = /^kone\/[0-9a-f]{8}$/;

/** Long enough that the whole leaf stays readable in a path, short enough to
 *  keep the branch the part you actually read. */
const DIGEST_LENGTH = 6;

/** Past this the leaf stops being informative and starts being a liability on
 *  filesystems with a per-component limit. */
const MAX_BRANCH_SEGMENT = 64;

/**
 * A branch name reduced to something safe to use as a single path component,
 * or null when nothing in it survives (all punctuation, or another script).
 *
 * Lossy on purpose — this is a label, not an identifier, and the digest beside
 * it is what keeps two different branches apart. Slashes become dashes so a
 * `feature/foo` branch is one directory rather than two.
 */
export function branchSegmentOrNull(branch: string): string | null {
  const collapsed = branch
    .toLowerCase()
    .replace(/['"`]/g, "")
    .replace(/[^a-z0-9/_-]+/g, "-")
    .replace(/\//g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-_]+|[-_]+$/g, "");
  return collapsed.slice(0, MAX_BRANCH_SEGMENT).replace(/[-_]+$/, "") || null;
}

/**
 * {@link branchSegmentOrNull}, but never empty: a branch named entirely in
 * characters it strips would otherwise produce a path ending in a separator.
 */
export function sanitizeBranchSegment(branch: string): string {
  return branchSegmentOrNull(branch) ?? "update";
}

/** Resolve symlinks without touching the disk beyond what resolution needs.
 *
 *  Git reports realpaths while paths assembled from arguments do not resolve
 *  the platform's aliases (on macOS `/tmp` and `/var` point into `/private`),
 *  so two strings naming one directory compare unequal until both come through
 *  here. Falls back to the nearest existing ancestor, so a planned directory
 *  still canonicalizes; when nothing above resolves, the absolute path stands.
 *
 *  Synchronous because the digest and the containment guard are pure lookups
 *  with no async context — the async twin in `worktree.ts` covers the call
 *  sites that already await. */
function canonicalSync(target: string): string {
  const absolute = path.resolve(target);
  let dir = absolute;
  const leaves: string[] = [];
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...leaves.slice().reverse());
    } catch {
      // Unresolvable here — step up and try the parent.
    }
    const parent = path.dirname(dir);
    if (parent === dir) return absolute;
    leaves.push(path.basename(dir));
    dir = parent;
  }
}

/** A fresh generated branch name, for a thread whose user named none. */
export function generatedBranchName(): string {
  return `${GENERATED_BRANCH_PREFIX}${randomBytes(4).toString("hex")}`;
}

/** Whether kone generated this branch name, and may therefore clean it up.
 *  Everything else belongs to the person who named it. */
export function isGeneratedBranchName(branch: string): boolean {
  return GENERATED_BRANCH_PATTERN.test(branch.trim());
}

/** Stable short hash of the project/branch pair — what keeps two branches that
 *  sanitize alike, or differ only in case, in two directories. The project is
 *  resolved before hashing, so two spellings of one checkout name one
 *  directory rather than two. */
export function worktreeDigest(projectPath: string, branch: string): string {
  return createHash("sha256")
    .update(`${canonicalSync(projectPath)}\0${branch}`)
    .digest("hex")
    .slice(0, DIGEST_LENGTH);
}

/** The directory a thread's worktree belongs in, given the managed root.
 *  Grouped by repository so a user looking at the folder can tell which project
 *  a worktree came from without opening it. */
export function worktreeDirFor(input: {
  root: string;
  projectPath: string;
  branch: string;
}): string {
  const repo = sanitizeBranchSegment(path.basename(canonicalSync(input.projectPath)));
  const leaf = `${sanitizeBranchSegment(input.branch)}-${worktreeDigest(input.projectPath, input.branch)}`;
  return path.join(input.root, repo, leaf);
}

/** The managed root every kone worktree lives under. */
export function worktreesRoot(): string {
  return userDataPath("worktrees");
}

/**
 * Whether `target` is inside `root` — the guard every removal checks first.
 *
 * Both sides are resolved before comparing, so a caller may pass whatever
 * spelling it has: an aliased root still contains its directories, and a
 * failed-build cleanup is never silently refused for naming an inside
 * directory through a symlink. The refusal direction stays safe — anything
 * that does not resolve inside answers "no".
 *
 * Equality is not containment: the root itself is never a worktree.
 */
export function isInsideWorktreesRoot(root: string, target: string): boolean {
  const rel = path.relative(canonicalSync(root), canonicalSync(target));
  if (!rel || rel === "..") return false;
  return !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel);
}
