// ── Git data model ────────────────────────────────────────────────────────────
// Kept deliberately flat and serializable — everything here crosses the IPC
// boundary to the renderer. Mirror any change in apps/web/app/types/desktop.d.ts.

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
  /** Repo-relative path (POSIX separators, as git reports it). */
  path: string;
  /** Original path, for renames and copies. */
  from?: string;
  status: GitFileStatus;
  /** Present in the index (has a staged change). */
  staged: boolean;
  /** Present in the working tree (has an unstaged change). */
  unstaged: boolean;
  /** Lines inserted in this file (working tree vs HEAD; whole file if new). */
  added?: number;
  /** Lines deleted in this file (working tree vs HEAD). */
  removed?: number;
};

/** One rendered line of a file diff, carrying both side's line numbers so the
 *  UI can print a two-gutter view (old | new | text). */
export type GitDiffLine = {
  kind: "context" | "add" | "del";
  /** Line content, marker stripped. */
  text: string;
  /** 1-based line number in the old file, or null on an added line. */
  oldNo: number | null;
  /** 1-based line number in the new file, or null on a removed line. */
  newNo: number | null;
};

/** A contiguous change region — the run under one `@@ … @@` header. */
export type GitDiffHunk = {
  /** The section heading trailing the "@@" markers (often the enclosing fn). */
  header: string;
  oldStart: number;
  newStart: number;
  lines: GitDiffLine[];
};

/** The parsed diff for a single file — working tree vs index, or index vs HEAD
 *  for a staged view. Untracked files diff against empty (all added). */
export type GitFileDiff = {
  path: string;
  status: GitFileStatus;
  /** git reported a binary file — no textual hunks to show. */
  binary: boolean;
  hunks: GitDiffHunk[];
  added: number;
  removed: number;
};

/** The working-tree text of one file, for the detail view's plain-content
 *  preview. Binary / oversize / unreadable files return null text with a flag. */
export type GitFileContent = {
  text: string | null;
  binary: boolean;
  /** text is a prefix — the file exceeded the read cap. */
  truncated: boolean;
};

/** One project file offered by the composer @-mention picker. Paths are
 * relative to the requested project directory and always use `/`. */
export type GitProjectFile = {
  path: string;
  name: string;
  parent: string;
};

export type GitBranch = {
  /** Short name, e.g. "main" or "origin/main". */
  name: string;
  current: boolean;
  /** A remote-tracking ref (under refs/remotes). */
  remote: boolean;
  /** Upstream branch for a local branch, e.g. "origin/main". */
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
  /** Author date, ISO 8601. */
  date: string;
  /** Human-relative author date, e.g. "2 hours ago". */
  relative: string;
};

export type GitStatus = {
  /** Absolute path to the repository's top level. */
  root: string;
  /** Current branch, or null when detached / on an unborn branch. */
  branch: string | null;
  detached: boolean;
  /** Short hash of HEAD, or null before the first commit. */
  head: string | null;
  /** Upstream tracking branch, e.g. "origin/main". */
  upstream: string | null;
  ahead: number;
  behind: number;
  changes: GitChange[];
  staged: number;
  unstaged: number;
  untracked: number;
  clean: boolean;
};

/** Progress tick emitted while a clone runs, parsed from `git clone --progress`
 *  stderr. Crosses IPC to drive the modal's progress bar. */
export type CloneProgress = {
  /** Overall progress across all clone phases, 0..1. */
  progress: number;
  /** Human caption for the current phase, e.g. "Receiving objects…". */
  stage: string;
};

/** The folder a finished clone produced. */
export type CloneResult = {
  /** Absolute path of the cloned repository's root. */
  root: string;
  /** Its basename — the project name. */
  name: string;
};

/** What a "create new project" gesture asks for. */
export type CreateProjectOptions = {
  /** Absolute path of the parent folder the project is created inside. */
  parent: string;
  /** The project folder's name (a single path segment). */
  name: string;
  /** Initialize a git repository in the new folder. */
  git: boolean;
  /** Initial branch name when `git` — defaults to "main". */
  branch?: string;
  /** `.gitignore` template key to seed (e.g. "node"), or null for none. */
  gitignore?: string | null;
  /** Seed a `README.md` (a single `# <name>` heading). */
  readme?: boolean;
  /** Also create a remote repository on GitHub (via `gh`) and push to it. This
   *  implies a local git repo, so it forces `git` on. */
  remote?: boolean;
  /** Name for the remote repo — defaults to the project name. */
  repoName?: string;
  /** Remote repo visibility. */
  visibility?: "public" | "private";
  /** A shell command to run inside the new folder after it's created (e.g. a
   *  scaffolder like `npm create vite@latest .`). Empty/undefined runs nothing. */
  command?: string;
};

/** The folder a finished "create" produced — mirrors CloneResult. */
export type CreateProjectResult = {
  root: string;
  name: string;
};

/** Lightweight repo summary — what the UI needs to recognize a project. */
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
  /** Lines deleted across uncommitted tracked changes. */
  removed: number;
};
