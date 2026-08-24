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

// ── Git Space surface ─────────────────────────────────────────────────────────
// The contract for the git-space feature (spec §5.1). Everything here crosses
// the IPC boundary to the renderer, so it stays flat and serializable.

export type GitRemote = {
  name: string; // "origin"
  fetchUrl: string;
  pushUrl: string;
  /** "owner/repo" when the URL parses as a GitHub remote, else null. */
  slug: string | null;
  /** Host of the remote URL, e.g. "github.com", else null. */
  host: string | null;
};

/** An in-progress multi-step operation the repo is sitting in the middle of. */
export type GitRepoState = {
  operation: "none" | "merging" | "rebasing" | "cherry-picking" | "reverting" | "bisecting";
  /** Repo-relative paths with unresolved conflicts. */
  conflicts: string[];
};

export type GitStashEntry = {
  /** Position in `git stash list` — 0 is the most recent. */
  index: number;
  /** "stash@{0}" */
  ref: string;
  /** The stash's own message, with git's "WIP on <branch>: " prefix stripped. */
  message: string;
  /** Branch the stash was taken on, or null when unparseable. */
  branch: string | null;
  /** ISO date. */
  date: string;
  /** "2 hours ago" */
  relative: string;
};

export type GitCommitFile = {
  path: string;
  from?: string;
  status: GitFileStatus;
  added: number;
  removed: number;
  binary: boolean;
};

export type GitCommitDetail = {
  commit: GitCommit;
  /** Message after the subject line; "" when there is none. */
  body: string;
  /** Parent hashes — length > 1 means a merge commit. */
  parents: string[];
  files: GitCommitFile[];
  added: number;
  removed: number;
};

export type GitCommitOptions = {
  message: string;
  body?: string;
  amend?: boolean;
  noVerify?: boolean;
};

export type GitPushOptions = {
  remote?: string; // default "origin"
  branch?: string; // default: current branch
  setUpstream?: boolean;
  /** Maps to --force-with-lease. Never plain --force. */
  force?: boolean;
};

export type GitPullOptions = {
  remote?: string;
  branch?: string;
  rebase?: boolean;
};

export type GitHubStatus = {
  installed: boolean;
  authenticated: boolean;
  /** Logged-in login handle when known. */
  user: string | null;
  /** Why it isn't usable, for the empty state. null when fine. */
  message: string | null;
};

/** Whether GitHub could merge a pull request, reduced to the one word worth
 *  saying. Named rather than inlined so a table keyed by it — the obstacle
 *  copy, say — is checked against the real set instead of accepting any string. */
export type GitHubMergeability =
  | "clean"
  | "conflicting"
  | "blocked"
  | "behind"
  | "unstable"
  | "draft"
  | "unknown";

export type GitHubPullRequest = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  author: string;
  /** Head branch. */
  branch: string;
  base: string;
  url: string;
  createdAt: string;
  relative: string;
  additions: number;
  deletions: number;
  /** Rollup of the head commit's checks. */
  checks: "passing" | "failing" | "pending" | "none";
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  comments: number;
};

export type GitHubPrCreateOptions = {
  title: string;
  body?: string;
  base?: string;
  draft?: boolean;
};

export type GitHubPrCreateResult = { number: number | null; url: string };

/** The repo's README, for the About section's rendered markdown. */
export type GitReadme = {
  /** Repo-relative path, e.g. "README.md". */
  path: string;
  markdown: string;
};

/** The name/email git will attribute work to in this repo — repo-local git
 *  config, which overrides global/user config. A missing value is null. */
export type GitIdentity = {
  name: string | null;
  email: string | null;
};

/** A repo logo as an inline data URL, for the About section's header. */
export type GitLogo = {
  /** Repo-relative path the bytes came from, e.g. "public/logo.svg". */
  path: string;
  dataUrl: string;
};

/** How many contributors the About section shows — everyone past this is only
 *  counted in `total`, not rendered. Shared by the git and GitHub sources. */
export const GIT_CONTRIBUTOR_CAP = 12;

/** One person credited with commits in this repository. */
export type GitContributor = {
  /** How to name them: a human name from git, or a GitHub login. */
  name: string;
  /** GitHub handle — null when the list came from git. */
  login: string | null;
  /** Commit email — null when the list came from GitHub. */
  email: string | null;
  /** Avatar as a data URL — null when there was none, or it couldn't be fetched. */
  avatarDataUrl: string | null;
  /** Commits attributed to them. */
  commits: number;
};

/** The repository's contributors. */
export type GitContributors = {
  /** Where the list came from. GitHub carries avatars; git carries emails. */
  source: "github" | "git";
  /** Capped at 12, ordered by commit count descending. */
  people: GitContributor[];
  /** Everyone, including those beyond the cap. */
  total: number;
};

/** The public GitHub surface of a repository, via `gh repo view --json`. */
export type GitHubRepoInfo = {
  nameWithOwner: string;
  description: string | null;
  homepageUrl: string | null;
  stars: number;
  forks: number;
  /** licenseInfo.nickname, falling back to licenseInfo.name. */
  license: string | null;
  /** primaryLanguage.name. */
  language: string | null;
  topics: string[];
  /** Lowercased GitHub visibility. */
  visibility: "public" | "private" | "internal";
  isFork: boolean;
  defaultBranch: string | null;
  pushedAt: string | null;
  createdAt: string | null;
  url: string;
};

/** The signed-in GitHub user, via `gh api user`. */
export type GitHubUser = {
  login: string;
  name: string | null;
  bio: string | null;
  avatarUrl: string | null;
  /** The avatar fetched into a base64 data URL, when the fetch succeeds. */
  avatarDataUrl: string | null;
  htmlUrl: string;
};

/** Anyone GitHub can name, as the space draws them: a handle, a real name when
 *  the API carried one, and an avatar already resolved to a data URL so the
 *  renderer never reaches the network itself. */
export type GitHubPerson = {
  login: string;
  name: string | null;
  avatarDataUrl: string | null;
};

/** One label. `color` is GitHub's six-digit hex *without* the leading '#', which
 *  is how the API returns it. */
export type GitHubLabel = {
  name: string;
  description: string | null;
  color: string;
};

/** A submitted review. "pending" is a review that was requested and hasn't
 *  arrived, so the view can list who is still being waited on. */
export type GitHubReview = {
  author: GitHubPerson | null;
  state: "approved" | "changes-requested" | "commented" | "dismissed" | "pending";
  body: string;
  submittedAt: string | null;
  relative: string;
};

/** One comment on the conversation. */
export type GitHubComment = {
  author: GitHubPerson | null;
  body: string;
  createdAt: string;
  relative: string;
  url: string;
};

/** One check run or status context, flattened to the same shape. */
export type GitHubCheck = {
  name: string;
  /** The workflow a check run belongs to; null for a bare status context. */
  workflow: string | null;
  state: "passing" | "failing" | "pending" | "skipped" | "none";
  url: string | null;
};

/** One file a pull request touches. */
export type GitHubPrFile = {
  path: string;
  additions: number;
  deletions: number;
  change: "added" | "modified" | "removed" | "renamed" | "copied" | "changed";
};

/** One commit on a pull request's branch. */
export type GitHubPrCommit = {
  oid: string;
  short: string;
  headline: string;
  body: string;
  author: string;
  date: string;
  relative: string;
};

/** A pull request in full — everything the dedicated view draws, in one read.
 *  Deliberately not an extension of `GitHubPullRequest`: the summary row names
 *  its author with a bare login, and this one carries a whole person. */
export type GitHubPullRequestDetail = {
  number: number;
  title: string;
  state: "open" | "closed" | "merged";
  isDraft: boolean;
  url: string;
  /** The description as GitHub markdown — images and all. */
  body: string;
  author: GitHubPerson | null;
  branch: string;
  base: string;
  /** The head repository's owner when the PR comes from a fork; null when not. */
  forkOwner: string | null;
  createdAt: string;
  relative: string;
  updatedAt: string | null;
  mergedAt: string | null;
  closedAt: string | null;
  mergedBy: GitHubPerson | null;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** Whether GitHub could merge it, reduced to the one word worth saying. */
  mergeability: GitHubMergeability;
  reviewDecision: "approved" | "changes-requested" | "review-required" | null;
  /** The rollup verdict, as the list row shows it. */
  checks: "passing" | "failing" | "pending" | "none";
  checkRuns: GitHubCheck[];
  labels: GitHubLabel[];
  assignees: GitHubPerson[];
  reviews: GitHubReview[];
  comments: GitHubComment[];
  commits: GitHubPrCommit[];
  files: GitHubPrFile[];
  milestone: string | null;
};

/** How many unique authors get an avatar fetched for the history gutter.
 *  Everyone past this draws their initial instead. */
export const GIT_AUTHOR_AVATAR_CAP = 24;

/** Commit email (lowercased) → the GitHub account behind it, so the history can
 *  put a real face next to a commit. Built from the repository's recent commits,
 *  which is exactly the stretch of history anyone scrolls. */
export type GitCommitAuthors = Record<string, GitHubPerson>;

// ── Stacked actions & AI Generation ───────────────────────────────────────────

export type GitStackedAction =
  | "commit"
  | "commit_push"
  | "commit_new_branch"
  | "commit_push_pr";

export type GitActionProgressPhase = "branch" | "stage" | "commit" | "push" | "pr";

export type GitActionProgressEvent = {
  phase: GitActionProgressPhase;
  message: string;
  exitCode?: number;
  error?: string;
};

export type CommitMessageGenerationInput = {
  dir: string;
  branch?: string | null;
  stagedSummary?: string;
  stagedPatch?: string;
  includeBranch?: boolean;
  model?: string;
  provider?: string;
};

export type CommitMessageGenerationResult = {
  subject: string;
  body: string;
  branch?: string;
};

export type GitRunStackedActionInput = {
  dir: string;
  action: GitStackedAction;
  message: string;
  body?: string;
  featureBranch?: boolean;
  branchName?: string;
  /** null commits all currently staged files; string[] stages and commits only the listed paths. */
  filePaths?: string[] | null;
  pushTarget?: string;
  prTitle?: string;
  prBody?: string;
  prDraft?: boolean;
};

export type GitRunStackedActionResult = {
  action: GitStackedAction;
  commitSha?: string;
  subject?: string;
  branch?: string;
  pushed?: boolean;
  upstreamBranch?: string;
  prNumber?: number;
  prUrl?: string;
};

