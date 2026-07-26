import { ipcMain } from "electron";

import { clone, cancelClone } from "./clone.js";
import { createProject } from "./create.js";
import { content, diff } from "./diff.js";
import { branches, log } from "./history.js";
import { checkout, discard, stage, unstage } from "./mutations.js";
import { detect, status } from "./status.js";
import { watchStatus } from "./watch.js";
import type { CreateProjectOptions } from "./types.js";

// One live watcher per renderer (webContents). Starting a new watch replaces the
// previous one; the sender's teardown stops it so a closed window leaks nothing.
const activeWatchers = new Map<number, () => void>();
// Senders we've already hooked "destroyed" on, so re-watching doesn't pile up
// listeners on the same webContents.
const watchTeardownHooked = new Set<number>();

function stopWatcher(id: number): void {
  activeWatchers.get(id)?.();
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
  // Start (or restart) live status watching for the calling renderer; fresh
  // status is pushed on the "git:status-changed" channel until git:unwatch.
  ipcMain.handle("git:watch", async (event, dir: string) => {
    const id = event.sender.id;
    stopWatcher(id);
    const stop = await watchStatus(dir, (status) => {
      if (!event.sender.isDestroyed()) {
        event.sender.send("git:status-changed", status);
      }
    });
    // The renderer may have navigated away (or unwatched) while we resolved the
    // repo root — don't install a now-orphaned watcher.
    if (event.sender.isDestroyed()) {
      stop();
      return;
    }
    // A concurrent git:watch may have installed a watcher during the await; stop
    // it so its handle can't leak past this overwrite.
    stopWatcher(id);
    activeWatchers.set(id, stop);
    if (!watchTeardownHooked.has(id)) {
      watchTeardownHooked.add(id);
      event.sender.once("destroyed", () => {
        stopWatcher(id);
        watchTeardownHooked.delete(id);
      });
    }
  });
  ipcMain.handle("git:unwatch", (event) => stopWatcher(event.sender.id));
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
  ipcMain.handle("git:log", (_event, dir: string, limit?: number) =>
    log(dir, limit),
  );
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
