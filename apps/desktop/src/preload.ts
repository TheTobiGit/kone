import { contextBridge, ipcRenderer } from "electron";

import type { DirListing } from "./fs.js";
import type {
  CloneProgress,
  CloneResult,
  CreateProjectOptions,
  CreateProjectResult,
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "./git.js";

const api = {
  isDesktop: true as const,
  platform: process.platform,
  version: process.versions.electron,
  fs: {
    home: (): Promise<string> => ipcRenderer.invoke("fs:home"),
    listDir: (dir: string): Promise<DirListing> =>
      ipcRenderer.invoke("fs:list-dir", dir),
  },
  git: {
    detect: (dir: string): Promise<GitRepo | null> =>
      ipcRenderer.invoke("git:detect", dir),
    status: (dir: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke("git:status", dir),
    branches: (dir: string): Promise<GitBranch[]> =>
      ipcRenderer.invoke("git:branches", dir),
    log: (dir: string, limit?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke("git:log", dir, limit),
    clone: (url: string, dest: string): Promise<CloneResult> =>
      ipcRenderer.invoke("git:clone", url, dest),
    // Abort the clone currently in flight (its git.clone() invoke then rejects).
    cancelClone: (): Promise<void> => ipcRenderer.invoke("git:clone-cancel"),
    create: (opts: CreateProjectOptions): Promise<CreateProjectResult> =>
      ipcRenderer.invoke("git:create", opts),
    // Live status: watch the repo and receive a fresh GitStatus whenever it moves
    // on disk (edit, terminal `git add`, commit, branch switch). Returns an
    // unsubscribe fn that also stops the watcher in the main process.
    watchStatus: (dir: string, cb: (status: GitStatus) => void): (() => void) => {
      const listener = (_event: unknown, status: GitStatus) => cb(status);
      ipcRenderer.on("git:status-changed", listener);
      void ipcRenderer.invoke("git:watch", dir);
      return () => {
        ipcRenderer.removeListener("git:status-changed", listener);
        void ipcRenderer.invoke("git:unwatch");
      };
    },
    // Working-tree mutations. They resolve once git has run; the open project's
    // watcher then pushes the resulting status.
    stage: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:stage", dir, paths),
    unstage: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:unstage", dir, paths),
    discard: (dir: string, paths: string[]): Promise<void> =>
      ipcRenderer.invoke("git:discard", dir, paths),
    // Subscribe to clone progress; returns an unsubscribe fn. Only meaningful
    // while a git.clone() invoke is in flight.
    onCloneProgress: (cb: (p: CloneProgress) => void): (() => void) => {
      const listener = (_event: unknown, p: CloneProgress) => cb(p);
      ipcRenderer.on("git:clone-progress", listener);
      return () => ipcRenderer.removeListener("git:clone-progress", listener);
    },
  },
  system: {
    username: (): Promise<string | null> =>
      ipcRenderer.invoke("system:username"),
    reveal: (target: string): Promise<void> =>
      ipcRenderer.invoke("system:reveal", target),
  },
};

contextBridge.exposeInMainWorld("koneDesktop", api);
