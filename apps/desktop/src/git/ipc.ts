import { ipcMain } from "electron";

import { clone, cancelClone } from "./clone.js";
import { createProject } from "./create.js";
import { contributors, identity, logo, readme } from "./about.js";
import { content, diff } from "./diff.js";
import { files } from "./files.js";
import * as github from "./github.js";
import { branches, commitDetail, commitDiff, log } from "./history.js";
import {
  abortOperation,
  checkout,
  commit,
  continueOperation,
  createBranch,
  deleteBranch,
  discard,
  mergeBranch,
  renameBranch,
  stage,
  unstage,
} from "./mutations.js";
import { remotes, repoState } from "./state.js";
import { stashes, stashApply, stashDrop, stashPush } from "./stash.js";
import { detect, status } from "./status.js";
import { fetch as gitFetch, pull as gitPull, push as gitPush } from "./sync.js";
import { watchStatus } from "./watch.js";
import type {
  CreateProjectOptions,
  GitCommitOptions,
  GitHubPrCreateOptions,
  GitPullOptions,
  GitPushOptions,
} from "./types.js";

// Live watchers, one fs watch per (renderer, dir). A renderer can watch many
// repos at once — the open project *and* every folder on the launcher grid — so
// this is a map of dir → watcher per webContents, not a single slot. Multiple
// subscribers to the same repo (e.g. the open project and its launcher tile)
// share one fs watch via a refcount; the fs watch stops only when the last one
// unwatches. The sender's teardown stops all of its watchers so a closed window
// leaks nothing.
interface WatchEntry {
  stop: () => void;
  refs: number;
}
const activeWatchers = new Map<number, Map<string, WatchEntry>>();
// Senders we've already hooked "destroyed" on, so re-watching doesn't pile up
// listeners on the same webContents.
const watchTeardownHooked = new Set<number>();

function watchersFor(id: number): Map<string, WatchEntry> {
  let map = activeWatchers.get(id);
  if (!map) {
    map = new Map();
    activeWatchers.set(id, map);
  }
  return map;
}

/** Drop one reference to a (renderer, dir) watch; stop the fs watch when the
 *  last subscriber releases it. */
function releaseWatcher(id: number, dir: string): void {
  const map = activeWatchers.get(id);
  const entry = map?.get(dir);
  if (!map || !entry) return;
  entry.refs -= 1;
  if (entry.refs > 0) return;
  map.delete(dir);
  entry.stop();
  if (map.size === 0) activeWatchers.delete(id);
}

/** Stop every watcher a renderer holds (window closed). */
function stopAllWatchers(id: number): void {
  const map = activeWatchers.get(id);
  if (!map) return;
  for (const entry of map.values()) entry.stop();
  activeWatchers.delete(id);
}

/** Register the git:* IPC handlers. Call once, before creating the window. */
export function registerGitIpc(): void {
  ipcMain.handle("git:detect", (_event, dir: string) => detect(dir));
  ipcMain.handle("git:status", (_event, dir: string) => status(dir));
  ipcMain.handle(
    "git:diff",
    (_event, dir: string, path: string, staged: boolean) =>
      diff(dir, path, staged),
  );
  ipcMain.handle("git:content", (_event, dir: string, path: string) =>
    content(dir, path),
  );
  ipcMain.handle("git:files", (_event, dir: string, query?: string) =>
    files(dir, query),
  );
  // Start live status watching of `dir` for the calling renderer; fresh status
  // is pushed on the "git:status-changed" channel — tagged with `dir` so the
  // renderer can route it to the right subscriber — until git:unwatch(dir). A
  // repeat watch of the same dir just adds a reference (one fs watch, many
  // subscribers); the fs watch is torn down when the last one unwatches.
  ipcMain.handle("git:watch", async (event, dir: string) => {
    const id = event.sender.id;
    const map = watchersFor(id);

    // Already watching this dir for this renderer — just take a reference.
    const existing = map.get(dir);
    if (existing) {
      existing.refs += 1;
      return;
    }

    // Reserve the slot before the async repo-root resolve so a concurrent watch
    // of the same dir refcounts onto this one instead of starting a rival fs
    // watch. `stop` is filled in once watchStatus resolves.
    const entry: WatchEntry = { stop: () => {}, refs: 1 };
    map.set(dir, entry);

    const stop = await watchStatus(dir, (status) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("git:status-changed", dir, status);
      }
    });

    // The renderer may have navigated away, or every subscriber may have
    // unwatched, while we resolved the repo root — don't install a now-orphaned
    // watcher. (unwatch/destroy during the await removes or replaces our slot.)
    if (event.sender.isDestroyed() || map.get(dir) !== entry) {
      stop();
      return;
    }
    entry.stop = stop;

    if (!watchTeardownHooked.has(id)) {
      watchTeardownHooked.add(id);
      event.sender.once("destroyed", () => {
        stopAllWatchers(id);
        watchTeardownHooked.delete(id);
      });
    }
  });
  ipcMain.handle("git:unwatch", (event, dir: string) =>
    releaseWatcher(event.sender.id, dir),
  );
  ipcMain.handle("git:stage", (_event, dir: string, paths: string[]) =>
    stage(dir, paths),
  );
  ipcMain.handle("git:unstage", (_event, dir: string, paths: string[]) =>
    unstage(dir, paths),
  );
  ipcMain.handle("git:discard", (_event, dir: string, paths: string[]) =>
    discard(dir, paths),
  );
  ipcMain.handle("git:checkout", (_event, dir: string, branch: string) =>
    checkout(dir, branch),
  );
  ipcMain.handle("git:branches", (_event, dir: string) => branches(dir));
  ipcMain.handle("git:log", (_event, dir: string, limit?: number, skip?: number) =>
    log(dir, limit, skip),
  );
  // Git Space surface (spec §5.2). Every git: channel follows the same shape:
  // the renderer invokes with (dir, ...args) and failures reject with the
  // GitError message.
  ipcMain.handle("git:remotes", (_event, dir: string) => remotes(dir));
  ipcMain.handle("git:repo-state", (_event, dir: string) => repoState(dir));
  ipcMain.handle("git:commit", (_event, dir: string, opts: GitCommitOptions) =>
    commit(dir, opts),
  );
  ipcMain.handle("git:fetch", (_event, dir: string, remote?: string) =>
    gitFetch(dir, remote),
  );
  ipcMain.handle("git:pull", (_event, dir: string, opts?: GitPullOptions) =>
    gitPull(dir, opts),
  );
  ipcMain.handle("git:push", (_event, dir: string, opts?: GitPushOptions) =>
    gitPush(dir, opts),
  );
  ipcMain.handle(
    "git:create-branch",
    (_event, dir: string, name: string, opts?: { from?: string; checkout?: boolean }) =>
      createBranch(dir, name, opts),
  );
  ipcMain.handle(
    "git:delete-branch",
    (_event, dir: string, name: string, opts?: { force?: boolean; remote?: boolean }) =>
      deleteBranch(dir, name, opts),
  );
  ipcMain.handle("git:rename-branch", (_event, dir: string, from: string, to: string) =>
    renameBranch(dir, from, to),
  );
  ipcMain.handle(
    "git:merge-branch",
    (_event, dir: string, name: string, opts?: { noFf?: boolean }) =>
      mergeBranch(dir, name, opts),
  );
  ipcMain.handle("git:continue-operation", (_event, dir: string) =>
    continueOperation(dir),
  );
  ipcMain.handle("git:abort-operation", (_event, dir: string) => abortOperation(dir));
  ipcMain.handle("git:commit-detail", (_event, dir: string, hash: string) =>
    commitDetail(dir, hash),
  );
  ipcMain.handle("git:commit-diff", (_event, dir: string, hash: string, path: string) =>
    commitDiff(dir, hash, path),
  );
  ipcMain.handle("git:stashes", (_event, dir: string) => stashes(dir));
  ipcMain.handle(
    "git:stash-push",
    (_event, dir: string, opts?: { message?: string; includeUntracked?: boolean }) =>
      stashPush(dir, opts),
  );
  ipcMain.handle(
    "git:stash-apply",
    (_event, dir: string, index: number, opts?: { pop?: boolean }) =>
      stashApply(dir, index, opts),
  );
  ipcMain.handle("git:stash-drop", (_event, dir: string, index: number) =>
    stashDrop(dir, index),
  );
  // The About section: the repo's presentation surface. All are local reads
  // that resolve to a "nothing here" shape (null, or an empty list) rather
  // than throwing.
  ipcMain.handle("git:readme", (_event, dir: string) => readme(dir));
  ipcMain.handle("git:identity", (_event, dir: string) => identity(dir));
  ipcMain.handle("git:logo", (_event, dir: string) => logo(dir));
  ipcMain.handle("git:contributors", (_event, dir: string) => contributors(dir));
  // GitHub (gh) surface — its own channel namespace.
  ipcMain.handle("github:status", () => github.status());
  ipcMain.handle("github:repo", (_event, dir: string) => github.repo(dir));
  ipcMain.handle("github:contributors", (_event, dir: string) => github.contributors(dir));
  ipcMain.handle("github:me", () => github.me());
  ipcMain.handle(
    "github:prs",
    (_event, dir: string, opts?: { state?: "open" | "all"; limit?: number }) =>
      github.prs(dir, opts),
  );
  ipcMain.handle(
    "github:create-pr",
    (_event, dir: string, opts: GitHubPrCreateOptions) => github.createPr(dir, opts),
  );
  ipcMain.handle("github:checkout-pr", (_event, dir: string, number: number) =>
    github.checkoutPr(dir, number),
  );
  ipcMain.handle(
    "github:pr-detail",
    (_event, dir: string, number: number) => github.prDetail(dir, number),
  );
  ipcMain.handle(
    "github:pr-diff",
    (_event, dir: string, number: number) => github.prDiff(dir, number),
  );
  ipcMain.handle("github:commit-authors", (_event, dir: string) =>
    github.commitAuthors(dir),
  );
  ipcMain.handle("github:open", (_event, url: string) => github.open(url));
  // Clone streams progress back to the requesting renderer on a side channel
  // while the invoke stays pending; it resolves with the created folder (or
  // rejects, which surfaces as a rejected invoke in the renderer).
  ipcMain.handle("git:clone", (event, url: string, dest: string) =>
    clone(url, dest, (p) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("git:clone-progress", p);
      }
    }),
  );
  ipcMain.handle("git:clone-cancel", () => cancelClone());
  ipcMain.handle("git:create", (_event, opts: CreateProjectOptions) =>
    createProject(opts),
  );
}
