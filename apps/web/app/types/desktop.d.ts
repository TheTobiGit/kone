// Shape of the Electron preload bridge, as seen from the renderer.
// Mirrors apps/desktop/src/git.ts and apps/desktop/src/types/global.d.ts.
export {};

export type DirEntry = {
  name: string;
  path: string;
  repo: boolean;
};

export type DirListing = {
  path: string;
  name: string;
  parent: string | null;
  repo: boolean;
  entries: DirEntry[];
};

export type KoneFsApi = {
  home: () => Promise<string>;
  listDir: (dir: string) => Promise<DirListing>;
};

export type GitFileStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "untracked"
  | "ignored"
  | "conflicted";

export type GitChange = {
  path: string;
  from?: string;
  status: GitFileStatus;
  staged: boolean;
  unstaged: boolean;
  /** Lines inserted in this file (working tree vs HEAD), when known. */
  added?: number;
  removed?: number;
};

export type GitDiffLine = {
  kind: "context" | "add" | "del";
  text: string;
  oldNo: number | null;
  newNo: number | null;
};

export type GitDiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: GitDiffLine[];
};

export type GitFileDiff = {
  path: string;
  status: GitFileStatus;
  binary: boolean;
  hunks: GitDiffHunk[];
  added: number;
  removed: number;
};

export type GitFileContent = {
  text: string | null;
  binary: boolean;
  truncated: boolean;
};

export type GitBranch = {
  name: string;
  current: boolean;
  remote: boolean;
  upstream?: string;
  ahead?: number;
  behind?: number;
};

export type GitCommit = {
  hash: string;
  short: string;
  subject: string;
  author: string;
  email: string;
  date: string;
  relative: string;
};

export type GitStatus = {
  root: string;
  branch: string | null;
  detached: boolean;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
};

export type GitRepo = {
  root: string;
  name: string;
  branch: string | null;
  detached: boolean;
  ahead: number;
  behind: number;
  changeCount: number;
  clean: boolean;
  /** Lines inserted across uncommitted tracked changes (working tree vs HEAD). */
  added: number;
  removed: number;
};

export type CloneProgress = {
  /** Overall progress across all clone phases, 0..1. */
  progress: number;
  /** Human caption for the current phase, e.g. "Receiving objects…". */
  stage: string;
};

export type CloneResult = {
  root: string;
  name: string;
};

export type CreateProjectOptions = {
  parent: string;
  name: string;
  git: boolean;
  branch?: string;
  gitignore?: string | null;
  readme?: boolean;
  remote?: boolean;
  repoName?: string;
  visibility?: "public" | "private";
  command?: string;
};

export type CreateProjectResult = {
  root: string;
  name: string;
};

export type KoneGitApi = {
  detect: (dir: string) => Promise<GitRepo | null>;
  status: (dir: string) => Promise<GitStatus | null>;
  /** The unified diff for one file. `staged` picks the index-vs-HEAD view. */
  diff: (
    dir: string,
    path: string,
    staged: boolean,
  ) => Promise<GitFileDiff | null>;
  /** One file's current working-tree text (for a plain content preview). */
  content: (dir: string, path: string) => Promise<GitFileContent | null>;
  branches: (dir: string) => Promise<GitBranch[]>;
  log: (dir: string, limit?: number) => Promise<GitCommit[]>;
  clone: (url: string, dest: string) => Promise<CloneResult>;
  /** Abort the clone in flight; its clone() promise then rejects. */
  cancelClone: () => Promise<void>;
  /** Subscribe to clone progress; returns an unsubscribe fn. */
  onCloneProgress: (cb: (p: CloneProgress) => void) => () => void;
  /** Create a new project folder (optionally a git repo); resolves the folder. */
  create: (opts: CreateProjectOptions) => Promise<CreateProjectResult>;
  /** Watch a repo for on-disk changes; `cb` fires with fresh status on every
   *  edit / stage / commit. Returns an unsubscribe fn that stops the watcher. */
  watchStatus: (dir: string, cb: (status: GitStatus) => void) => () => void;
  /** Stage the given repo-relative paths. */
  stage: (dir: string, paths: string[]) => Promise<void>;
  /** Unstage the given paths (index back to HEAD; working tree untouched). */
  unstage: (dir: string, paths: string[]) => Promise<void>;
  /** Discard the given paths' uncommitted changes — destructive. */
  discard: (dir: string, paths: string[]) => Promise<void>;
};

export type KoneSystemApi = {
  username: () => Promise<string | null>;
  reveal: (path: string) => Promise<void>;
};

export type KoneDesktopApi = {
  isDesktop: true;
  platform: string;
  version: string;
  fs: KoneFsApi;
  git: KoneGitApi;
  system: KoneSystemApi;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}
