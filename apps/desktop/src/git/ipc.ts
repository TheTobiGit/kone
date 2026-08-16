import { ipcMain } from "electron";

import { withTimeout } from "../ipcTimeout.js";
import { clone } from "./clone.js";
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

// The one in-flight clone per renderer (webContents id → controller). Cancel
// must be scoped to the sender's own clone: the modal's cancel button aborts
// the clone that modal owns, not every clone in the process — a concurrent
// skill-install clone (which calls clone() directly, with no renderer
// controller) would be killed for no reason. One clone per renderer, so a
// repeat git:clone supersedes the previous one for the same window.
const activeClones = new Map<number, AbortController>();

// Read-only git/github handlers are bounded by one deadline so a wedged read —
// a `git status` waiting on a credential prompt, a file preview on a stalled
// network share — can't leave the renderer's `invoke` hanging forever. The
// subprocess runner has its own shorter kill-timeout; this is the uniform
// backstop for every read, and the one deadline the fs-backed reads (which
// have no subprocess to time out) get at all. Both paths fail with the same
// classified TIMEOUT the renderer turns into a retry hint.
const GIT_READ_TIMEOUT_MS = 20_000;

/** Register the git:* IPC handlers. Call once, before creating the window. */
export function registerGitIpc(): void {
  ipcMain.handle("git:detect", (_event, dir: string) =>
    withTimeout(() => detect(dir), { channel: "git:detect", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  ipcMain.handle("git:status", (_event, dir: string) =>
    withTimeout(() => status(dir), { channel: "git:status", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  ipcMain.handle(
    "git:diff",
    (_event, dir: string, path: string, staged: boolean) =>
      withTimeout(() => diff(dir, path, staged), {
        channel: "git:diff",
        timeoutMs: GIT_READ_TIMEOUT_MS,
      }),
  );
  ipcMain.handle("git:content", (_event, dir: string, path: string) =>
    withTimeout((signal) => content(dir, path, signal), {
      channel: "git:content",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("git:files", (_event, dir: string, query?: string) =>
    withTimeout(() => files(dir, query), {
      channel: "git:files",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
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
  ipcMain.handle("git:branches", (_event, dir: string) =>
    withTimeout(() => branches(dir), { channel: "git:branches", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  ipcMain.handle("git:log", (_event, dir: string, limit?: number, skip?: number) =>
    withTimeout(() => log(dir, limit, skip), { channel: "git:log", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  // Git Space surface (spec §5.2). Every git: channel follows the same shape:
  // the renderer invokes with (dir, ...args) and failures reject with the
  // GitError message.
  ipcMain.handle("git:remotes", (_event, dir: string) =>
    withTimeout(() => remotes(dir), { channel: "git:remotes", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  ipcMain.handle("git:repo-state", (_event, dir: string) =>
    withTimeout(() => repoState(dir), { channel: "git:repo-state", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
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
    withTimeout(() => commitDetail(dir, hash), {
      channel: "git:commit-detail",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("git:commit-diff", (_event, dir: string, hash: string, path: string) =>
    withTimeout(() => commitDiff(dir, hash, path), {
      channel: "git:commit-diff",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("git:stashes", (_event, dir: string) =>
    withTimeout(() => stashes(dir), { channel: "git:stashes", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
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
  ipcMain.handle("git:readme", (_event, dir: string) =>
    withTimeout((signal) => readme(dir, signal), {
      channel: "git:readme",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("git:identity", (_event, dir: string) =>
    withTimeout(() => identity(dir), { channel: "git:identity", timeoutMs: GIT_READ_TIMEOUT_MS }),
  );
  ipcMain.handle("git:logo", (_event, dir: string) =>
    withTimeout((signal) => logo(dir, signal), {
      channel: "git:logo",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
  ipcMain.handle("git:contributors", (_event, dir: string) =>
    withTimeout(() => contributors(dir), {
      channel: "git:contributors",
      timeoutMs: GIT_READ_TIMEOUT_MS,
    }),
  );
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
  ipcMain.handle("git:clone", (event, url: string, dest: string) => {
    const id = event.sender.id;
    // One clone per renderer: a repeat start cancels the previous one rather
    // than stacking a second clone into the same staging folder.
    activeClones.get(id)?.abort();

    const controller = new AbortController();
    activeClones.set(id, controller);

    // A crashed renderer can't cancel its own clone — the invoke dies with the
    // process — so abort on destroyed or git keeps writing into the staging
    // folder. Drop the entry too, so a reload of the same window starts fresh.
    const onDestroyed = () => {
      controller.abort();
      activeClones.delete(id);
    };
    event.sender.once("destroyed", onDestroyed);

    return clone(
      url,
      dest,
      (p) => {
        if (!event.sender.isDestroyed()) {
          event.sender.send("git:clone-progress", p);
        }
      },
      { signal: controller.signal },
    ).finally(() => {
      event.sender.removeListener("destroyed", onDestroyed);
      if (activeClones.get(id) === controller) {
        activeClones.delete(id);
      }
    });
  });
  // Cancel is scoped to this sender's clone, never the process-wide sweep:
  // the modal's cancel button must not kill a concurrent skill-install clone.
  ipcMain.handle("git:cancel-clone", (event) => {
    activeClones.get(event.sender.id)?.abort();
  });
  ipcMain.handle("git:create", (_event, opts: CreateProjectOptions) =>
    createProject(opts),
  );
}
