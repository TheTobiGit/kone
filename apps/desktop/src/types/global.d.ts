import type {
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "../git.js";

export type KoneFolder = {
  path: string;
  name: string;
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
  openFolder: () => Promise<KoneFolder | null>;
  git: KoneGitApi;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}

export {};
