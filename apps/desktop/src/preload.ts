import { contextBridge, ipcRenderer } from "electron";

import type { DirListing } from "./fs.js";
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
  fs: {
    // Home directory — where the in-app folder browser starts.
    home: (): Promise<string> => ipcRenderer.invoke("fs:home"),
    // Immediate subdirectories of `dir` (directories only, dotfiles omitted).
    listDir: (dir: string): Promise<DirListing> =>
      ipcRenderer.invoke("fs:list-dir", dir),
  },
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
  system: {
    // The signed-in OS account's short username, or null if unreadable.
    username: (): Promise<string | null> =>
      ipcRenderer.invoke("system:username"),
  },
};

contextBridge.exposeInMainWorld("koneDesktop", api);
