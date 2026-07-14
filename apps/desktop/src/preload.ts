import { contextBridge, ipcRenderer } from "electron";

import type {
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "./git.js";

const api = {
  isDesktop: true as const,
  platform: process.platform,
  version: process.versions.electron,
  // Opens the native folder picker; resolves to the chosen directory
  // (absolute path + basename) or null if the dialog was dismissed.
  openFolder: (): Promise<{ path: string; name: string } | null> =>
    ipcRenderer.invoke("dialog:open-folder"),
  git: {
    // Recognize a git repo at `dir` and summarize it, or null if not a repo.
    detect: (dir: string): Promise<GitRepo | null> =>
      ipcRenderer.invoke("git:detect", dir),
    // Full working-tree status, or null if `dir` isn't inside a repo.
    status: (dir: string): Promise<GitStatus | null> =>
      ipcRenderer.invoke("git:status", dir),
    // Local + remote-tracking branches.
    branches: (dir: string): Promise<GitBranch[]> =>
      ipcRenderer.invoke("git:branches", dir),
    // Most recent commits (default 50).
    log: (dir: string, limit?: number): Promise<GitCommit[]> =>
      ipcRenderer.invoke("git:log", dir, limit),
  },
};

contextBridge.exposeInMainWorld("koneDesktop", api);
