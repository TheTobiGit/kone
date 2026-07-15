import type { DirListing } from "../fs.js";
import type {
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "../git.js";

export type KoneFsApi = {
  home: () => Promise<string>;
  listDir: (dir: string) => Promise<DirListing>;
};

export type KoneGitApi = {
  detect: (dir: string) => Promise<GitRepo | null>;
  status: (dir: string) => Promise<GitStatus | null>;
  branches: (dir: string) => Promise<GitBranch[]>;
  log: (dir: string, limit?: number) => Promise<GitCommit[]>;
};

export type KoneDesktopApi = {
  isDesktop: true;
  platform: NodeJS.Platform;
  version: string;
  fs: KoneFsApi;
  git: KoneGitApi;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}

export {};
