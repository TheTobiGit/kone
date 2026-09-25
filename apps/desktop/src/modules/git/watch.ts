import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

import { repoRoot } from "@kone/git-core/core.js";
import { invalidateFileIndex } from "./files.js";
import { status } from "@kone/git-core/status.js";
import type { GitStatus } from "@kone/git-core/types.js";

/** Linux safety-net poll for nested working-tree edits the non-recursive
 *  watchers can't see. One `git status` per watched repo per tick, so with
 *  every thread in its own worktree the cost scales with worktree count —
 *  kept well above the debounce, since a missed nested edit only has to
 *  surface eventually, not instantly. */
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

/** Whether two status reads describe the same repo state, compared field by
 *  field so an unchanged poll costs no serialization. */
function sameStatus(a: GitStatus, b: GitStatus): boolean {
  if (
    a.branch !== b.branch ||
    a.detached !== b.detached ||
    a.head !== b.head ||
    a.upstream !== b.upstream ||
    a.ahead !== b.ahead ||
    a.behind !== b.behind ||
    a.staged !== b.staged ||
    a.unstaged !== b.unstaged ||
    a.untracked !== b.untracked ||
    a.changes.length !== b.changes.length
  ) {
    return false;
  }
  return a.changes.every((change, i) => {
    const other = b.changes[i];
    return (
      other !== undefined &&
      change.path === other.path &&
      change.from === other.from &&
      change.status === other.status &&
      change.staged === other.staged &&
      change.unstaged === other.unstaged &&
      change.added === other.added &&
      change.removed === other.removed
    );
  });
}

type RawWatchEvent = (_event: string, filename: string | null) => void;

/** Start the platform's file watchers over `root`, returning their teardown,
 *  or null when nothing could be watched.
 *
 *  Node supports recursive watching on Linux since v19/20, but it adds one
 *  inotify watch per directory — on large trees that is hundreds of watches
 *  for a status signal. So on Linux this fans out to cheap non-recursive
 *  watchers (working-tree top level + `.git` for index/HEAD + `.git/refs`)
 *  plus a low-frequency `onPoll` tick as a safety net for nested edits, which
 *  don't raise inotify there. Everywhere else one recursive watcher covers
 *  the whole tree. */
function startWatchers(
  root: string,
  onRawEvent: (prefix: string) => RawWatchEvent,
  onPoll: () => void,
): (() => void) | null {
  const watchers: FSWatcher[] = [];
  const watch = (dirPath: string, prefix: string, recursive: boolean): boolean => {
    try {
      const w = fsWatch(dirPath, { recursive }, onRawEvent(prefix));
      w.on("error", () => {});
      watchers.push(w);
      return true;
    } catch {
      return false;
    }
  };
  let pollTimer: ReturnType<typeof setInterval> | null = null;

  if (process.platform === "linux") {
    // Best-effort per scope: a missing dir (no .git/refs yet) or EMFILE just
    // means that scope has no live sync; the poll still catches changes.
    watch(root, "", false);
    watch(path.join(root, ".git"), ".git", false);
    watch(path.join(root, ".git", "refs"), ".git/refs", false);
    pollTimer = setInterval(onPoll, LINUX_STATUS_POLL_INTERVAL_MS);
    // setInterval keeps the Electron main loop alive; the explicit teardown is
    // the real stop, this just avoids holding the loop for a forgotten watcher.
    pollTimer.unref?.();
  } else if (!watch(root, "", true)) {
    // Recursive watch unsupported or the OS refused (too many files) —
    // degrade to no live sync rather than crash; the initial read stands.
    return null;
  }

  return () => {
    if (pollTimer) clearInterval(pollTimer);
    for (const w of watchers) {
      try {
        w.close();
      } catch {
        // Already closed — teardown is best-effort.
      }
    }
  };
}

/** Watch `dir`'s repository and call `onStatus` (debounced) with a fresh status
 *  whenever it changes on disk. Resolves the repo root first; a non-repo yields a
 *  no-op stop fn and no callbacks. Returns a function that stops watching.
 *  Bursts are coalesced by one debounce and share one in-flight `git status`. */
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
  let lastSent: GitStatus | null = null;

  function send(fresh: GitStatus): void {
    lastSent = fresh;
    onStatus(fresh);
  }

  /** One `git status` read, handing a fresh result to `onFresh`. */
  async function read(onFresh: (fresh: GitStatus) => void): Promise<void> {
    running = true;
    try {
      const fresh = await status(root);
      if (fresh && !closed) onFresh(fresh);
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

  /** A watcher saw a relevant change: always push what the disk says now. */
  async function emit(): Promise<void> {
    if (closed) return;
    if (running) {
      dirty = true;
      return;
    }
    await read(send);
  }

  /** The safety-net tick: push only when the status actually moved. A poll-found
   *  change came from an edit no watcher saw, so the file index may be stale
   *  too — drop it the way schedule() would have. */
  async function poll(): Promise<void> {
    // A pending debounce or an in-flight read is about to report anyway.
    if (closed || running || timer !== null) return;
    await read((fresh) => {
      if (lastSent && sameStatus(lastSent, fresh)) return;
      invalidateFileIndex(root);
      send(fresh);
    });
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

  const onRawEvent = (prefix: string): RawWatchEvent => (_event, filename) => {
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

  const stopWatchers = startWatchers(root, onRawEvent, () => void poll());
  if (!stopWatchers) return () => {};

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    stopWatchers();
  };
}
