import type { DirListing } from "../fs.js";
import type {
  CloneProgress,
  CloneResult,
  CreateProjectOptions,
  CreateProjectResult,
  GitBranch,
  GitCommit,
  GitRepo,
  GitStatus,
} from "../git/index.js";

export type KoneFsApi = {
  home: () => Promise<string>;
  listDir: (dir: string) => Promise<DirListing>;
};

export type KoneGitApi = {
  detect: (dir: string) => Promise<GitRepo | null>;
  status: (dir: string) => Promise<GitStatus | null>;
  branches: (dir: string) => Promise<GitBranch[]>;
  log: (dir: string, limit?: number) => Promise<GitCommit[]>;
  clone: (url: string, dest: string) => Promise<CloneResult>;
  cancelClone: () => Promise<void>;
  onCloneProgress: (cb: (p: CloneProgress) => void) => () => void;
  create: (opts: CreateProjectOptions) => Promise<CreateProjectResult>;
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
