import { constants } from "node:fs";
import { cp, stat } from "node:fs/promises";
import path from "node:path";

import { git, pathExists } from "@kone/git-core/core.js";

// Bringing a project's private files into a fresh worktree.
//
// A worktree is a checkout, so it holds what git tracks and nothing else. The
// files a project needs to start but keeps out of git — `.env` above all — are
// exactly the ones missing, and a desk without them fails in ways that look
// like the agent's fault. So a new worktree gets them copied across:
//
//   - every ignored `.env` / `.env.*` file, at any depth, with no setup at all;
//   - anything else the project lists in a `.worktreeinclude` file at its root,
//     written like a `.gitignore` (one pattern per line, `#` comments, `!` to
//     take a match back, a trailing `/` for a directory).
//
// Git evaluates the patterns itself, so `.worktreeinclude` means exactly what
// the same lines would mean in a `.gitignore`, character classes and escapes
// included.
//
// Only IGNORED files are candidates. A file git would track is either already
// in the worktree or is an unsaved change, and bringing unsaved changes along
// is a separate decision the user makes, not a side effect of this one.
//
// Copies are clones where the disk can make them, so a large directory costs
// nothing until one side changes it. Nothing in the worktree is overwritten.
// Best effort throughout: a file that will not copy is a worse desk, not a
// failed one, and the build carries on.

export const WORKTREE_INCLUDE_FILE = ".worktreeinclude";

/** What every project gets without a `.worktreeinclude`: its env files. */
const DEFAULT_PATTERNS = [".env", ".env.*"];

/** Directories whose contents a tool regenerates. Git is told not to look
 *  inside them for a file-level match — they are where the time would go, and
 *  a package's own `.env` is not the project's. A pattern that names one of
 *  them outright still copies it whole. */
const REGENERATED_DIRS = ["node_modules", "dist", "build", "target", ".next", ".nuxt", ".output", ".venv", "venv", "__pycache__", "coverage"];

/** Whether a directory name is one whose contents a tool regenerates. */
export function isRegeneratedDir(name: string): boolean {
  return REGENERATED_DIRS.includes(name);
}

/**
 * `git ls-files --others --ignored --directory` under the given exclude
 * options: a wholly matched directory comes back as one `dir/` entry. Git also
 * names each untracked directory on the way down to a match; those are only
 * the path to it, not a match of their own, so they are dropped.
 */
async function listIgnored(dir: string, excludes: string[], pathspec: string[] = []): Promise<string[]> {
  const out = await git(dir, ["ls-files", "--others", "--ignored", "--directory", "-z", ...excludes, "--", ...pathspec]);
  const entries = out.split("\0").filter(Boolean);
  return entries.filter(
    (entry) => !entry.endsWith("/") || !entries.some((other) => other !== entry && other.startsWith(entry)),
  );
}

/** The project's ignored files and directories, git's own view. A wholly
 *  ignored directory is one `dir/` entry rather than every file in it, which
 *  is what keeps this fast beside a `node_modules`. */
export async function ignoredEntries(dir: string): Promise<string[]> {
  return listIgnored(dir, ["--exclude-standard"]);
}

/**
 * The private entries of a checkout: the ignored paths the env defaults or the
 * `.worktreeinclude` in `rulesFrom` pick, project-relative, directories without
 * a trailing slash. The copy step brings these into a new worktree, and the
 * sweep asks the same question of an old one, so the two cannot disagree about
 * what was copied.
 */
export async function privateEntries(dir: string, rulesFrom = dir): Promise<string[]> {
  const ignored = await ignoredEntries(dir);
  if (ignored.length === 0) return [];
  const excludes = DEFAULT_PATTERNS.map((pattern) => `--exclude=${pattern}`);
  const list = path.join(rulesFrom, WORKTREE_INCLUDE_FILE);
  if (await pathExists(list)) excludes.push(`--exclude-from=${list}`);
  const pruned = REGENERATED_DIRS.map((name) => `:(exclude,glob)**/${name}/**`);
  const matched = await listIgnored(dir, excludes, [".", ...pruned]);

  // A match is private only where the project itself ignores it. A set,
  // because a matched directory that is only partly ignored hands back each
  // ignored entry inside it, and those may also have matched on their own.
  const picked = new Set<string>();
  for (const entry of matched) {
    if (ignored.some((place) => entry === place || (place.endsWith("/") && entry.startsWith(place)))) {
      picked.add(entry);
    } else if (entry.endsWith("/")) {
      for (const place of ignored) if (place.startsWith(entry)) picked.add(place);
    }
  }
  return [...picked].map((entry) => entry.replace(/\/$/, ""));
}

/**
 * Copy the project's private files into a new worktree. Returns what was
 * copied, project-relative, for the setup steps to name. Never throws.
 */
export async function copyPrivateFiles(project: string, worktree: string): Promise<string[]> {
  let wanted: string[];
  try {
    wanted = await privateEntries(project);
  } catch (err) {
    console.error("[git] could not list private files for the new worktree:", err);
    return [];
  }
  const copied: string[] = [];
  for (const rel of wanted) {
    const from = path.join(project, rel);
    const to = path.join(worktree, rel);
    try {
      // Something the checkout already put there is the project's own copy.
      if (await pathExists(to)) continue;
      const isDir = (await stat(from)).isDirectory();
      await cp(from, to, {
        recursive: isDir,
        force: false,
        errorOnExist: false,
        preserveTimestamps: true,
        // A clone where the disk supports one, a plain copy where it does not.
        mode: constants.COPYFILE_FICLONE,
      });
      copied.push(rel);
    } catch (err) {
      console.error(`[git] could not copy '${rel}' into the new worktree:`, err);
    }
  }
  return copied;
}
