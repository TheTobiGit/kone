import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

import { repoRoot } from "@kone/git-core/core.js";
import { invalidateFileIndex } from "./files.js";
import { status } from "@kone/git-core/status.js";
import type { GitStatus } from "@kone/git-core/types.js";

/** Linux safety-net poll for nested working-tree edits the non-recursive
 *  watchers can't see. One `git status` per watched repo per tick, so with
 *  every thread in its own worktree the cost scales with worktree count —
 *  kept well above the debounce (t3code refreshes on a 30s cadence). */
const LINUX_STATUS_POLL_INTERVAL_MS = 15_000;

// Keep the open project in sync with the disk: watch the repo and re-read status
// whenever the working tree or the index moves — an editor save, a `git add` in
// the terminal, a commit, a branch switch. Bursts (a save touches several files;
// git rewrites the index through a lock file) are coalesced by a short debounce,
// then a single fresh `git status` is pushed to the caller.

/** Whether a changed path under the repo root is worth re-reading status for.
 *  Working-tree files count; inside `.git` only the refs that staging/committing
 *  move matter (index, HEAD, refs) — object/log churn is ignored. node_modules
 *  is skipped entirely (git ignores it, and watching it is pure noise). */
function watchRelevant(filename: string | null): boolean {
  // A null filename means the platform couldn't name the file — re-check to be
  // safe rather than miss a real change.
  if (!filename) return true;
  const p = filename.split(path.sep).join("/");
  // Skip node_modules at any depth (monorepo package installs churn constantly).
  if (/(^|\/)node_modules(\/|$)/.test(p)) return false;
  if (p === ".git" || p.startsWith(".git/")) {
    const rest = p.slice(5);
    return (
      rest === "index" ||
      rest === "HEAD" ||
      rest === "ORIG_HEAD" ||
      rest === "MERGE_HEAD" ||
      rest.startsWith("refs/")
    );
  }
  return true;
}

/** Watch `dir`'s repository and call `onStatus` (debounced) with a fresh status
 *  whenever it changes on disk. Resolves the repo root first; a non-repo yields a
 *  no-op stop fn and no callbacks. Returns a function that stops watching.
 *
 *  Linux note: Node supports recursive watching on Linux since v19/20, but
 *  it adds one inotify watch per directory — on large trees that is hundreds
 *  of watches for a status signal. So on Linux we fan out to cheap
 *  non-recursive watchers (root + `.git` + `.git/refs` when present) plus a
 *  low-frequency status poll as a safety net for nested working-tree edits.
 *  Everywhere else we keep one recursive watcher. Either way bursts are
 *  coalesced by the same debounce and share one in-flight `git status`. */
export async function watchStatus(
  dir: string,
  onStatus: (status: GitStatus) => void,
): Promise<() => void> {
  const resolved = await repoRoot(dir);
  if (!resolved) return () => {};
  const root: string = resolved;

  let closed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let running = false;
  let dirty = false; // a change arrived while a read was in flight
  // Last status pushed to the caller, so a poll that finds nothing new stays
  // silent instead of re-sending an identical status over IPC every tick.
  let lastSent: string | null = null;

  async function emit(fromPoll = false): Promise<void> {
    if (closed || running) {
      // A poll colliding with a read already in flight has nothing to add.
      if (!fromPoll) dirty = dirty || !closed;
      return;
    }
    running = true;
    try {
      const fresh = await status(root);
      if (fresh && !closed) {
        const signature = JSON.stringify(fresh);
        if (fromPoll && signature === lastSent) return;
        // A poll-found change came from an edit no watcher saw, so the file
        // index may be stale too — drop it the way schedule() would have.
        if (fromPoll) invalidateFileIndex(root);
        lastSent = signature;
        onStatus(fresh);
      }
    } catch {
      // A transient read failure (mid-write, lock contention) is fine — the next
      // change reschedules another read.
    } finally {
      running = false;
      if (dirty && !closed) {
        dirty = false;
        schedule();
      }
    }
  }

  function schedule(): void {
    if (closed) return;
    // A relevant disk change means the cached path list may be missing a new
    // file or still listing a deleted one, so the next mention-picker search
    // must rebuild rather than trust the stale entry.
    invalidateFileIndex(root);
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void emit();
    }, 180);
  }

  let watchers: FSWatcher[] = [];
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  const onRawEvent = (prefix: string) => (_event: string, filename: string | null) => {
    if (closed) return;
    // Non-recursive watchers report names relative to their own dir; re-prefix
    // so watchRelevant sees the repo-relative path.
    const repoRelative = prefix
      ? filename
        ? `${prefix}/${filename}`
        : prefix
      : filename;
    if (!watchRelevant(repoRelative)) return;
    schedule();
  };

  const watchNonRecursive = (dirPath: string, prefix: string): void => {
    try {
      const w = fsWatch(dirPath, { recursive: false }, onRawEvent(prefix));
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // Best-effort: a missing dir (no .git/refs yet) or EMFILE just means
      // that scope has no live sync; the poll below still catches changes.
    }
  };

  // One inotify watch per scope that matters (working-tree top level +
  // index/HEAD + refs) instead of one recursive watch costing a watch per
  // directory. Nested working-tree edits below the top level don't raise
  // inotify here, so a slow poll backs them up. The poll reads status
  // directly rather than through schedule(): it must not drop the file index
  // every tick, and an unchanged result is not pushed to the caller.
  const useLinuxFallback = process.platform === "linux";
  if (useLinuxFallback) {
    watchNonRecursive(root, "");
    watchNonRecursive(path.join(root, ".git"), ".git");
    watchNonRecursive(path.join(root, ".git", "refs"), ".git/refs");
    pollTimer = setInterval(() => {
      // A pending debounce is about to read anyway.
      if (!closed && timer === null) void emit(true);
    }, LINUX_STATUS_POLL_INTERVAL_MS);
    // setInterval keeps the Electron main loop alive; the explicit close in
    // stop() below is the real teardown, this just avoids holding the loop
    // for a forgotten watcher.
    pollTimer.unref?.();
  } else {
    try {
      const w = fsWatch(root, { recursive: true }, onRawEvent(""));
      w.on("error", () => {});
      watchers.push(w);
    } catch {
      // Recursive watch unsupported or the OS refused (too many files) —
      // degrade to no live sync rather than crash; the initial read stands.
      return () => {};
    }
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    if (pollTimer) clearInterval(pollTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Already closed — teardown is best-effort.
      }
    }
    watchers = [];
  };
}
