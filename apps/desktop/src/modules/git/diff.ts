import { readFile } from "node:fs/promises";

import { GitError, git, repoRoot, safeRepoPath } from "@kone/git-core/core.js";
import type { GitDiffHunk, GitFileContent, GitFileDiff } from "@kone/git-core/types.js";

// The detail view opens one file at a time, so we ask git for just that file's
// unified diff and parse it into numbered hunks. Staged files diff index-vs-HEAD;
// unstaged files diff worktree-vs-index; an untracked file has neither, so it
// diffs against /dev/null and reads as wholly added.

/** Run a diff, tolerating the exit-1 that `git diff --no-index` uses to mean
 *  "the files differ" — its real output is on stdout. Any other failure throws. */
async function diffRun(cwd: string, args: string[]): Promise<string> {
  try {
    return await git(cwd, args);
  } catch (error) {
    if (error instanceof GitError && error.code === 1) return error.stdout;
    throw error;
  }
}

/** Parse one file's unified diff into numbered hunks. Header/metadata lines set
 *  the status; `@@` lines seed the old/new counters that each body line then
 *  advances. Shared with the history module, which parses per-commit file diffs
 *  through the exact same parser so the two views can't drift. */
export function parseFileDiff(relPath: string, out: string): GitFileDiff {
  const result: GitFileDiff = {
    path: relPath,
    status: "modified",
    binary: false,
    hunks: [],
    added: 0,
    removed: 0,
  };
  let hunk: GitDiffHunk | null = null;
  let oldNo = 0;
  let newNo = 0;

  for (const raw of out.split("\n")) {
    if (raw.startsWith("Binary files")) {
      result.binary = true;
      continue;
    }
    const at = raw.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
    if (at) {
      oldNo = Number(at[1]);
      newNo = Number(at[2]);
      hunk = { header: (at[3] ?? "").trim(), oldStart: oldNo, newStart: newNo, lines: [] };
      result.hunks.push(hunk);
      continue;
    }
    // Diff header / metadata — before the first hunk. Note the file's disposition.
    if (!hunk) {
      if (raw.startsWith("new file")) result.status = "added";
      else if (raw.startsWith("deleted file")) result.status = "deleted";
      else if (raw.startsWith("rename ")) result.status = "renamed";
      continue;
    }
    if (raw.startsWith("\\")) continue; // "\ No newline at end of file"
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "+") {
      hunk.lines.push({ kind: "add", text, oldNo: null, newNo });
      newNo += 1;
      result.added += 1;
    } else if (marker === "-") {
      hunk.lines.push({ kind: "del", text, oldNo, newNo: null });
      oldNo += 1;
      result.removed += 1;
    } else {
      hunk.lines.push({ kind: "context", text, oldNo, newNo });
      oldNo += 1;
      newNo += 1;
    }
  }
  return result;
}

const CONTENT_CAP = 512 * 1024; // 512 KB — ample for source, guards huge blobs

/** Read one repo-relative file's current content. Null when `dir` isn't a repo
 *  or the path escapes it; a null `text` with `binary`/`truncated` flags marks a
 *  file we can show a note for instead of code. */
export async function content(
  dir: string,
  relPath: string,
  signal?: AbortSignal,
): Promise<GitFileContent | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  const abs = safeRepoPath(root, relPath);
  if (abs === null) return null;
  if (relPath.endsWith("/")) return { text: null, binary: false, truncated: false };
  try {
    const buf = await readFile(abs, signal ? { signal } : undefined);
    if (buf.includes(0)) return { text: null, binary: true, truncated: false };
    const truncated = buf.length > CONTENT_CAP;
    const slice = truncated ? buf.subarray(0, CONTENT_CAP) : buf;
    return { text: slice.toString("utf8"), binary: false, truncated };
  } catch (error) {
    // An aborted read must surface, not read as "no content".
    if (signal?.aborted) throw error;
    // Missing (e.g. a deleted file) or unreadable — no content to preview.
    return { text: null, binary: false, truncated: false };
  }
}

/** The unified diff for one repo-relative path. `staged` picks index-vs-HEAD
 *  over worktree-vs-index; an untracked file falls back to a diff against empty.
 *  Null when `dir` isn't in a repo or the path escapes it. */
export async function diff(
  dir: string,
  relPath: string,
  staged: boolean,
): Promise<GitFileDiff | null> {
  const root = await repoRoot(dir);
  if (!root) return null;
  if (safeRepoPath(root, relPath) === null) return null;
  const common = ["--no-color", "--no-ext-diff"];
  let out: string;
  if (staged) {
    out = await diffRun(root, ["diff", "--cached", ...common, "--", relPath]);
  } else {
    out = await diffRun(root, ["diff", ...common, "--", relPath]);
    if (!out.trim()) {
      // Nothing tracked to diff — an untracked file. Diff against empty so the
      // whole file reads as added.
      out = await diffRun(root, [
        "diff",
        "--no-index",
        ...common,
        "--",
        "/dev/null",
        relPath,
      ]);
    }
  }
  return parseFileDiff(relPath, out);
}
