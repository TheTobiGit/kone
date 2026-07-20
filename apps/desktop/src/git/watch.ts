import { watch as fsWatch, type FSWatcher } from "node:fs";
import path from "node:path";

import { repoRoot } from "./core.js";
import { status } from "./status.js";
import type { GitStatus } from "./types.js";

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
 *  no-op stop fn and no callbacks. Returns a function that stops watching. */
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

  async function emit(): Promise<void> {
    if (closed || running) {
      dirty = dirty || !closed;
      return;
    }
    running = true;
    try {
      const fresh = await status(root);
      if (fresh && !closed) onStatus(fresh);
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
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void emit();
    }, 180);
  }

  let watcher: FSWatcher | null = null;
  try {
    watcher = fsWatch(root, { recursive: true }, (_event, filename) => {
      if (closed || !watchRelevant(filename)) return;
      schedule();
    });
  } catch {
    // Recursive watch unsupported or the OS refused (too many files) — degrade to
    // no live sync rather than crash; the initial read still stands.
    return () => {};
  }

  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
    watcher?.close();
  };
}
