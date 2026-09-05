// Shape of the Electron preload bridge, as seen from the renderer.
// Mirrors apps/desktop/src/git.ts and apps/desktop/src/types/global.d.ts.
export {};

import type { StudioLayout } from "~/types/studio";

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

export type GitProjectFile = {
  path: string;
  name: string;
  parent: string;
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
  /** Lines deleted across uncommitted tracked changes. */
  removed: number;
};

// ── Git Space surface (mirrors @kone/git-core types + desktop git modules) ───

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

/** The name/email git will attribute work to in this repo. */
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

/** Commit email (lowercased) → the GitHub account behind it, so the history can
 *  put a real face next to a commit. Built from the repository's recent commits,
 *  which is exactly the stretch of history anyone scrolls. */
export type GitCommitAuthors = Record<string, GitHubPerson>;

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
  files: (dir: string, query?: string) => Promise<GitProjectFile[]>;
  branches: (dir: string) => Promise<GitBranch[]>;
  log: (dir: string, limit?: number, skip?: number) => Promise<GitCommit[]>;
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
  /** Switch the working tree to a local branch; rejects when git blocks it. */
  checkout: (dir: string, branch: string) => Promise<void>;
  /** Configured remotes, origin first. */
  remotes: (dir: string) => Promise<GitRemote[]>;
  /** Mid-operation state (merge/rebase/…) + conflicted paths. */
  repoState: (dir: string) => Promise<GitRepoState | null>;

  commit: (dir: string, opts: GitCommitOptions) => Promise<void>;
  generateCommitMessage: (
    dir: string,
    opts?: Partial<CommitMessageGenerationInput>,
  ) => Promise<CommitMessageGenerationResult>;
  runStackedAction: (
    dir: string,
    input: GitRunStackedActionInput,
  ) => Promise<GitRunStackedActionResult>;
  onActionProgress: (cb: (event: GitActionProgressEvent) => void) => () => void;
  fetch: (dir: string, remote?: string) => Promise<void>;
  pull: (dir: string, opts?: GitPullOptions) => Promise<void>;
  push: (dir: string, opts?: GitPushOptions) => Promise<void>;


  createBranch: (
    dir: string,
    name: string,
    opts?: { from?: string; checkout?: boolean },
  ) => Promise<void>;
  deleteBranch: (
    dir: string,
    name: string,
    opts?: { force?: boolean; remote?: boolean },
  ) => Promise<void>;
  renameBranch: (dir: string, from: string, to: string) => Promise<void>;
  mergeBranch: (dir: string, name: string, opts?: { noFf?: boolean }) => Promise<void>;
  /** Continue / abort whatever `repoState().operation` reports. */
  continueOperation: (dir: string) => Promise<void>;
  abortOperation: (dir: string) => Promise<void>;

  commitDetail: (dir: string, hash: string) => Promise<GitCommitDetail | null>;
  commitDiff: (dir: string, hash: string, path: string) => Promise<GitFileDiff | null>;

  stashes: (dir: string) => Promise<GitStashEntry[]>;
  stashPush: (
    dir: string,
    opts?: { message?: string; includeUntracked?: boolean },
  ) => Promise<void>;
  /** `pop: true` removes the entry after applying. */
  stashApply: (dir: string, index: number, opts?: { pop?: boolean }) => Promise<void>;
  stashDrop: (dir: string, index: number) => Promise<void>;

  /** Repo README markdown, or null when the repo has none. */
  readme: (dir: string) => Promise<GitReadme | null>;
  /** The name/email git attributes work to in this repo. */
  identity: (dir: string) => Promise<GitIdentity>;
  /** Repo logo as a data URL, or null when nothing qualifies. */
  logo: (dir: string) => Promise<GitLogo | null>;
  /** The repo's contributors, straight from git. No avatars, but it always
   *  works — even when there's no remote to ask. */
  contributors: (dir: string) => Promise<GitContributors>;

  github: KoneGithubApi;
};

export type KoneGithubApi = {
  status: () => Promise<GitHubStatus>;
  prs: (dir: string, opts?: { state?: "open" | "all"; limit?: number }) => Promise<GitHubPullRequest[]>;
  createPr: (dir: string, opts: GitHubPrCreateOptions) => Promise<GitHubPrCreateResult>;
  checkoutPr: (dir: string, number: number) => Promise<void>;
  prDetail: (dir: string, number: number) => Promise<GitHubPullRequestDetail | null>;
  prDiff: (dir: string, number: number) => Promise<GitFileDiff[]>;
  commitAuthors: (dir: string) => Promise<GitCommitAuthors | null>;
  /** Open a URL in the user's real browser. */
  open: (url: string) => Promise<void>;
  /** The repo's public GitHub surface, or null when there's no GitHub info. */
  repo: (dir: string) => Promise<GitHubRepoInfo | null>;
  /** The repo's contributors via GitHub, with avatars — or null when GitHub
   *  can't answer. */
  contributors: (dir: string) => Promise<GitContributors | null>;
  /** The signed-in GitHub user (with avatar data URL), or null. */
  me: () => Promise<GitHubUser | null>;
};

export type KoneSystemApi = {
  username: () => Promise<string | null>;
  reveal: (path: string) => Promise<void>;
};

// ── Agent layer ────────────────────────────────────────────────────────────
// Mirrors packages/agent-core/src/types.ts. "Bring your own subscription": kone
// drives the agent CLIs the user already installed + logged into; it never
// stores provider credentials.

export type ProviderKind = "codex" | "claudeAgent" | "cursor" | "opencode" | "droid" | "antigravity";
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type ProviderReadiness = "ready" | "needs-login" | "not-installed" | "error" | "disabled";

export type ProviderStatus = {
  provider: ProviderKind;
  label: string;
  available: boolean;
  authStatus: AuthStatus;
  readiness: ProviderReadiness;
  enabled?: boolean;
  version?: string;
  authLabel?: string;
  message?: string;
};

/** The user's persisted per-provider install settings (mirrors
 *  packages/agent-core/src/types.ts). Credential-free by design — only how to
 *  reach the CLI the user already installed + logged into. */
export type ProviderConfig = {
  /** Override the CLI executable (absolute path or a name on PATH). Empty falls
   *  back to the adapter default (`codex` / `opencode`); ignored by providers
   *  with no external binary (Claude). */
  binaryPath?: string;
  /** Whether the provider is enabled across the app (default: true). */
  enabled?: boolean;
};

export type ProviderSettingsMap = Partial<Record<ProviderKind, ProviderConfig>>;

// ── Install maintenance (mirrors packages/agent-core/src/providerMaintenance.ts) ─

/** Which channel installed a provider's CLI, and therefore which one has to
 *  update it. `native` — the CLI's own updater; `bundled` — kone ships the
 *  runtime, so there's no user install at all; `unknown` — found but in a
 *  layout kone doesn't recognise, so it won't guess an update command. */
export type ProviderInstallSource =
  | "npm"
  | "bun"
  | "pnpm"
  | "homebrew"
  | "native"
  | "bundled"
  | "unknown";

/** How the installed version stands against the newest published one.
 *  `unknown` covers both "we couldn't ask" and "there's nowhere to ask". */
export type VersionStanding = "current" | "behind" | "unknown";

/** What kone knows about how one provider's CLI is installed and updated. */
export type ProviderMaintenance = {
  provider: ProviderKind;
  installSource: ProviderInstallSource;
  binary: string | null;
  /** The PATH entry the binary resolved to, and what it points at when that's
   *  a shim into a versioned install directory. */
  resolvedPath: string | null;
  realPath: string | null;
  packageName: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  /** False when there's no registry to read a "latest" from — a self-updating
   *  CLI, which must never be presented as out of date. */
  latestKnowable: boolean;
  standing: VersionStanding;
  /** The exact command kone would run, shown so the user can run it themselves. */
  updateCommand: string | null;
  canUpdate: boolean;
  checkedAt: number | null;
};

export type ProviderUpdateOutcome = "succeeded" | "failed" | "unchanged" | "unsupported";

export type ProviderUpdateResult = {
  provider: ProviderKind;
  outcome: ProviderUpdateOutcome;
  message: string | null;
  /** The installer's own transcript — a failure usually names its cause. */
  output: string | null;
  maintenance: ProviderMaintenance;
  /** Re-probed statuses for every provider, since an update moves a version. */
  statuses: ProviderStatus[];
};

export type ModelDescriptor = {
  id: string;
  label: string;
  /** Provider-reported native context capacity, when available. */
  contextWindowTokens?: number;
  /** Real reasoning-effort ids this model supports (Codex's `model/list`
   *  `supportedReasoningEfforts`), in the order the API returned them. Absent
   *  for a model with no reasoning-effort axis at all. */
  reasoningEfforts?: string[];
  /** Which of `reasoningEfforts` the provider itself defaults to. */
  defaultReasoningEffort?: string;
  /** Real speed/service tiers this model supports (Codex's `model/list`
   *  `serviceTiers`, falling back to the deprecated `additionalSpeedTiers` id
   *  list). Absent for a model with no speed-tier axis at all — most models
   *  don't have one; where it exists it's almost always just a "fast" tier. */
  serviceTiers?: { id: string; label: string; description?: string }[];
  /** The provider's own default service tier id for this model (Codex's
   *  `model/list` `defaultServiceTier`), when it has one configured. Lets the
   *  picker pre-set the fast-mode toggle to the provider's default. */
  defaultServiceTier?: string;
  /** The context-window sizes this model can run in, when it has a choice. For
   *  Claude this is the auto-compact window (compact early at 200k vs run to the
   *  full native 1M), not a raw capacity switch. Absent for a single-window
   *  model (Haiku). `tokens` is the raw budget the adapter applies. */
  contextWindows?: { id: string; label: string; tokens: number; isDefault?: boolean }[];
};

/** The approval-policy ladder — how much the agent may do without asking,
 *  from most to least restrictive: `ask` always asks first (read-only
 *  sandbox); `accept-edits` auto-approves file edits but still asks before
 *  commands/other actions; `full-access` never prompts. No 4th "auto" rung
 *  (an AI-reviewed middle ground) — see CodexAdapter.ts. */
export type InteractionMode = "ask" | "accept-edits" | "full-access";

/** The named agent a thread was handed to, reduced to what the provider session
 *  has to be told (gateway/appContext renderAgentIdentity). The roster's faces
 *  and ordering mean nothing to a model, so only the name and the agent's own
 *  instructions cross the boundary. Absent runs the session as a guest, told
 *  nothing. */
export type AgentPersona = {
  /** The agent's name as the user has it — renameable, so never the shipped one
   *  by assumption. */
  name: string;
  /** The agent's standing instructions: how it should work, in its own words.
   *  Optional — an agent can be nothing but a name. Rendered after the name in
   *  the identity block; behavioural only, never a provider/model/effort pick. */
  instructions?: string;
};

export type SessionStartInput = {
  threadId: string;
  provider: ProviderKind;
  cwd: string;
  model?: string;
  mode?: InteractionMode;
  /** Reasoning-effort tier. Flag-based providers (Codex) take effort per turn
   *  and ignore this; providers that fix effort when the session process spawns
   *  (Claude — the SDK `effort` is a spawn-time option) read it here, so
   *  changing it restarts the session. */
  effort?: string;
  /** Provider-native conversation id to resume when reopening a stored thread,
   *  so it continues with its full prior context. Absent starts fresh. */
  resume?: string;
  /** The last assistant message uuid of the prior conversation (Claude only),
   *  persisted alongside `resume` as StoredThreadMeta.resumeSessionAt. Passed to
   *  the Claude SDK as `resumeSessionAt` to anchor the resume at the last
   *  assistant message — the SDK can't reliably resume a conversation whose
   *  tail is a user message. Absent for every other provider. */
  resumeSessionAt?: string;
  /** MCP gateway connection for this session, filled main-side by
   *  AgentService.startSession when the gateway is live. The adapter injects
   *  it into the provider session's mcpServers config so the agent can call
   *  kone tools. Renderer code never sets this. */
  gatewayConnection?: GatewayConnection;
  /** Who this session works as, when the thread was handed to a named agent.
   *  On the session rather than per turn: a thread has one agent from end to
   *  end. Absent runs it as a guest. */
  agent?: AgentPersona;
};

/** Loopback MCP gateway connection for one provider session
 *  (packages/agent-core/src/gateway). */
export type GatewayConnection = {
  url: string;
  bearerToken: string;
};

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type Session = {
  threadId: string;
  provider: ProviderKind;
  cwd: string;
  status: RuntimeSessionState;
  conversationId?: string;
  /** The resume id this session actually adopted, when `SessionStartInput.resume`
   *  was honored. Absent means the process came up with an empty context — the
   *  send path then replays the transcript as context instead. */
  resumedFrom?: string;
  activeTurnId?: string;
  model?: string;
  /** Reasoning-effort tier the session runs at, when the adapter knows it.
   *  Absent when the adapter genuinely can't know (e.g. Codex takes effort per
   *  turn and records nothing at session level). */
  effort?: string;
  mode: InteractionMode;
};

// ── Attachments (mirror packages/agent-core/src/types.ts) ─────────────────────
/** How an attachment is fed to the agent. `image` → native vision block;
 *  `file` → an on-disk path the agent reads with its own tools. */
export type AttachmentKind = "image" | "file";

/** Bytes-free attachment metadata that rides a turn. */
export type ChatAttachment = {
  type: AttachmentKind;
  id: string;
  name: string;
  mimeType: string;
  sizeBytes: number;
};

/** Upload payload — raw bytes (base64, no data: prefix) sent once over IPC. */
export type UploadAttachmentInput = {
  threadId: string;
  name: string;
  mimeType: string;
  data: string;
};

export type SendTurnInput = {
  threadId: string;
  userBlockId?: string;
  input: string;
  /** Files/images attached to this turn (metadata only; bytes live on disk). */
  attachments?: ChatAttachment[];
  model?: string;
  mode?: InteractionMode;
  /** Reasoning effort tier. Providers that bake effort into the model id
   *  ignore it; providers that expose it as a flag (Codex) use it. */
  effort?: string;
  /** A model's chosen service tier (e.g. Codex's "fast" tier id) for this
   *  turn. Absent means the provider's default tier. */
  serviceTier?: string;
  /** A model's chosen context-window id (ModelDescriptor.contextWindows[].id,
   *  e.g. "200k"/"1m"). Claude maps it to a live auto-compact-window Setting.
   *  Absent means the model's default window. */
  contextWindow?: string;
};

export type TurnStartResult = { threadId: string; turnId: string };

// ── durable turn queue (mirror packages/agent-core/src/ConversationStore.ts) ─
/** A follow-up durably enqueued while the thread's turn ran (survives
 *  crashes), promoted automatically when the active turn settles, and
 *  cancelled on stop/thread-delete. `userBlockId` anchors the queued chip to
 *  the transcript block of the user prompt it was sent after; `dispatchMode`
 *  distinguishes a plain follow-up from a steer request that fell back to the
 *  queue (steers claim first, so the nudge lands as the next turn the moment
 *  the current one settles). */
export type QueuedTurnRow = {
  queueId: string;
  threadId: string;
  userBlockId: string;
  dispatchMode: "queue" | "steer";
  state: "queued" | "promoting";
  /** The user's prompt text. */
  input: string;
  /** Files/images attached to the queued turn (metadata only; bytes on disk). */
  attachments?: ChatAttachment[];
  model?: string;
  mode?: string;
  effort?: string;
  serviceTier?: string;
  contextWindow?: string;
  /** Times this turn was claimed; survives release→reclaim (the retry ledger). */
  attemptCount: number;
  createdAt: number;
  updatedAt: number;
  promotedAt?: number;
};

// ── side chat creation (mirror packages/agent-core/src/types.ts) ──────────────
// A side chat is a root thread with a fork pointer back at its source: the
// renderer mints the threadId + requestId, the desktop side validates + imports
// the source transcript, and the result streams as `thread.sidechat-created`.
// Duplicate dispatch with the same threadId resolves "exists" — requireThreadAbsent
// idempotency; requestId makes that exactly-once across app restarts.

/** Provider/model/effort/mode for a forked child. Absent fields inherit the
 *  source thread (provider always inherits when unset; model only when it
 *  stays on the same provider). */
export type CreateSideChatTarget = {
  provider?: ProviderKind;
  model?: string;
  effort?: string;
  mode?: InteractionMode;
};

export type CreateSideChatInput = {
  /** Caller-chosen idempotency key. Same requestId replayed with the same
   *  threadId resolves "exists"; replayed with a different threadId is an
   *  idempotency conflict. */
  requestId: string;
  /** Renderer-minted id for the new side chat thread. */
  threadId: string;
  /** The thread this side chat is forked from. */
  sourceThreadId: string;
  /** Optional first prompt — dispatched as a normal first turn after
   *  creation; the bootstrap context rides it. */
  prompt?: string;
  /** Overrides the default `Sidechat: <seed>` title. */
  title?: string;
  /** Target provider/model/effort/mode for the child. */
  target?: CreateSideChatTarget;
};

export type CreateSideChatResult = {
  requestId: string;
  threadId: string;
  sourceThreadId: string;
  /** The provider the child is set up for (resolved target or source thread's). */
  provider: ProviderKind;
  /** The model the child is set up for, when one resolved. */
  model?: string;
  /** `"created"` = the fork was written; `"exists"` = a thread with this id
   *  was already there (idempotent replay of the same creation). */
  status: "created" | "exists";
};

export type ApprovalDecision = "allow-once" | "allow-always" | "reject-once" | "reject-and-stop";

// ── tool approvals (mirror packages/agent-core/src/types.ts) ──────────────────
// When the thread's InteractionMode is restrictive enough that the provider
// asks before an action, the adapter parks the request and emits
// `approval.requested` instead of auto-answering it. The renderer shows the
// approve/reject prompt; the picked decision (ApprovalDecision) is handed back
// via respondToRequest → `approval.resolved`.

/** What an approval is being asked to allow. `tool` is the catch-all for a
 *  permission/call kone doesn't classify further. */
export type ApprovalRequestKind = "command" | "file-read" | "file-change" | "permission" | "tool";

/** A parked provider-side request for the user's go-ahead before the agent
 *  runs something — normalized across every provider's approval surface. */
export type ApprovalRequest = {
  kind: ApprovalRequestKind;
  /** The headline — the command line, the path, the tool name. */
  title: string;
  /** The provider's stated reason, when it gives one. */
  detail?: string;
};

// ── mid-turn user-input questions (mirror packages/agent-core/src/types.ts) ────
/** One choice offered for a question; `description` is a short gloss. */
export type UserInputQuestionOption = {
  label: string;
  description?: string;
};

/** One question the agent asks the user mid-turn. No `options` → free text. */
export type UserInputQuestion = {
  /** Stable key the answer is filed under (for Claude, equals the question text). */
  id: string;
  header: string;
  question: string;
  options: UserInputQuestionOption[];
  multiSelect?: boolean;
};

/** Answers keyed by question id → free text / single label, an array of labels
 *  (multi-select), or null when skipped. */
export type UserInputAnswers = Record<string, string | string[] | null>;

export type RuntimeTurnState = "completed" | "failed" | "interrupted";

/** How a turn settled when it didn't run to completion. `turn.aborted` covers
 *  crashes as well as user interrupts, so "completed" is unreachable here. */
export type TurnAbortReason = Exclude<RuntimeTurnState, "completed">;

/** A shell command execution is a `tool_call` like any other — it doesn't get
 *  its own kind. */
export type RuntimeItemKind = "assistant_text" | "reasoning_text" | "plan_text" | "tool_call";

export type RuntimeItemStatus = "in-progress" | "completed" | "failed";

/** One entry in the agent's working checklist. Matches the shared vocabulary of
 *  Claude's TodoWrite and Codex's TurnPlanStep — the only two producers. */
export type PlanTaskStatus = "pending" | "in-progress" | "completed";

export type PlanTask = {
  /** kone-minted and held stable across snapshots. Providers send no ids. */
  id: string;
  /** Imperative form: TodoWrite `content`, Codex `step`. */
  content: string;
  /** Present-continuous form for the in-progress row. TodoWrite only. */
  activeForm?: string;
  status: PlanTaskStatus;
};

// ── nested subagents ─────────────────────────────────────────────────────────
// A provider-native nested agent: the main agent's Task/Agent tool call spawns a
// child agent that runs its own turn and reports back as the tool's result. NOT
// a second thread/session — the run stays nested inside the parent turn, hanging
// off the `tool_call` item that spawned it. Mirrors packages/agent-core/src/types.ts.

/** Lifecycle of one subagent run. `stopped` is a user/parent-initiated kill,
 *  distinct from a `failed` run. */
export type SubagentStatus = "starting" | "running" | "completed" | "failed" | "stopped";

/** Identity + status for one subagent run, without its transcript. Every
 *  `subagent.*` event carries a full snapshot, so a consumer merges not patches. */
export type SubagentRunSnapshot = {
  /** The spawning Task/Agent tool-use id — the run's stable id. */
  toolUseId: string;
  /** The provider's own task id, once known. Needed to stop the run. */
  taskId?: string;
  /** `itemId` of the parent turn's `tool_call` item this run hangs under. */
  parentItemId?: string;
  /** The agent definition that was invoked, e.g. `explore` / `worker-high`. */
  agentType?: string;
  /** The Task tool's one-line `description` — the run's label. */
  description?: string;
  /** The brief the parent handed the child. */
  prompt?: string;
  model?: string;
  effort?: string;
  /** True for a fire-and-forget background run. */
  background?: boolean;
  status: SubagentStatus;
  /** The child's final report, once it settles. */
  summary?: string;
  /** Name of the tool the child ran most recently — a live progress hint. */
  lastToolName?: string;
  tokens?: number;
  toolUses?: number;
  startedAt: number;
  endedAt?: number;
};

/** A subagent run plus the transcript it produced, in arrival order. */
export type SubagentRun = SubagentRunSnapshot & { items: RuntimeItem[] };

export type RuntimeItem = {
  itemId: string;
  kind: RuntimeItemKind;
  status: RuntimeItemStatus;
  /** Streamed narrative for text kinds, or a short inline target/summary for
   *  a tool_call. */
  text: string;
  /** For `plan_text` items: the agent's checklist as data. */
  tasks?: PlanTask[];
  name?: string;
  /** A tool_call's full result body (command output, a diff, a changed-file
   *  list) — shown on demand. Undefined when there's nothing to expand. */
  detail?: string;
  /** For a Task/Agent `tool_call`: the nested run it spawned, assembled by the
   *  consumer from the `subagent.*` events plus items tagged with this run's
   *  `subagentToolUseId` — adapters emit the pieces, never the tree. */
  subagent?: SubagentRun;
};

export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
  /** Tokens currently occupying the provider's context window. */
  contextUsed?: number;
  /** The active model context/auto-compact budget, when reported. */
  contextWindow?: number;
  /** Whether the provider automatically compacts this context when needed. */
  compactsAutomatically?: boolean;
};

export type ProviderRefs = {
  conversationId?: string;
  /** Last assistant message uuid (Claude only) — carried on every envelope so
   *  the store can persist the resume anchor the moment it changes. */
  resumeSessionAt?: string;
};

export type RuntimeEventSource =
  | "codex.rpc.notification"
  | "codex.rpc.stderr"
  | "codex.rpc.lifecycle"
  // Claude Agent SDK: `message` = a translated SDKMessage from the query
  // stream; `lifecycle` = session start/exit; `stderr` = the CLI's stderr line.
  | "claude.sdk.message"
  | "claude.sdk.stderr"
  | "claude.sdk.lifecycle"
  | "opencode.sse.message"
  | "opencode.sse.stderr"
  | "opencode.sse.lifecycle"
  // Cursor Agent ACP: `notification` = session/model notices from the ACP
  // extension methods; `lifecycle` = session start/exit; `stderr` = CLI stderr.
  | "cursor.acp.notification"
  | "cursor.acp.stderr"
  | "cursor.acp.lifecycle"
  // Factory Droid ACP (`droid exec --output-format acp`): same three sources as
  // Cursor's ACP transport.
  | "droid.acp.notification"
  | "droid.acp.stderr"
  | "droid.acp.lifecycle"
  // Antigravity `agy -p` print mode: `event` = transcript/hook-derived turn
  // events, `stderr` = the CLI's stderr line, `lifecycle` = session start/exit.
  | "antigravity.cli.event"
  | "antigravity.cli.stderr"
  | "antigravity.cli.lifecycle"
  // Antigravity ACP (`agy_acp_server` stdio): `notification` = a
  // `session/update` notification, `lifecycle` = process/session start+exit.
  | "antigravity.acp.notification"
  | "antigravity.acp.lifecycle"
  // Main-process store / side-channel work (e.g. first-turn title rename).
  | "kone.store"
  // Renderer-synthesized mock traffic (agentMock) — browser-dev only, it
  // never crosses the bridge, so nothing downstream can observe this source.
  | "kone.mock";

export type AgentBaseEvent = {
  threadId: string;
  provider: ProviderKind;
  at: number;
  source: RuntimeEventSource;
  refs?: ProviderRefs;
  /** Dedupe id, stamped by the main-process broadcast choke point when absent. */
  eventId?: string;
  /** When this thread was spawned by another thread's turn, that spawning
   *  turn's id — set at dispatch, so a child's events correlate to the parent
   *  turn without a store walk. */
  parentTurnId?: string;
};

export type RuntimeEvent =
  | (AgentBaseEvent & { type: "session.started" })
  | (AgentBaseEvent & {
      type: "session.state.changed";
      state: RuntimeSessionState;
      message?: string;
    })
  // Non-fatal: the session is degraded or retrying but continues. Consumers must
  // NOT flip the thread to an error state on this.
  | (AgentBaseEvent & { type: "session.warning"; message: string })
  | (AgentBaseEvent & { type: "session.exited"; code: number | null })
  | (AgentBaseEvent & { type: "thread.token-usage.updated"; usage: TokenUsage })
  | (AgentBaseEvent & { type: "thread.title.updated"; title: string })
  // A thread (and its spawned subtree) was stamped archived — hidden from
  // every live list, recoverable from the archive. One event per affected
  // thread: the root and each spawned descendant put away with it.
  | (AgentBaseEvent & { type: "thread.archived"; archivedAt: number })
  // An archived thread was restored. One event per affected thread, mirroring
  // the archive event's per-subtree-thread fan-out.
  | (AgentBaseEvent & { type: "thread.unarchived" })
  // The provider rerouted the request to a different model mid-session. Update
  // the session's model label; `reason` is the provider's own wording.
  | (AgentBaseEvent & {
      type: "model.rerouted";
      fromModel: string;
      toModel: string;
      reason?: string;
    })
  // A side chat fork was persisted (agent:create-side-chat). `threadId` is the
  // new side chat's id; `sourceThreadId` is the thread it was forked from.
  | (AgentBaseEvent & {
      type: "thread.sidechat-created";
      sourceThreadId: string;
      requestId: string;
    })
  // An agent spawned a child thread (kone_spawn_worker), and every subsequent
  // change to that child's rolled-up state. `threadId` is the CHILD's id, so
  // these route like any other thread event; the snapshot carries the parent
  // pointer. Both carry the whole `SpawnedThread` value — apply by replacing,
  // never patching. The main process is the only place a child's status is
  // derived; the renderer applies these rather than re-deriving from the
  // child's raw turn events.
  | (AgentBaseEvent & { type: "thread.spawned"; spawned: SpawnedThread })
  | (AgentBaseEvent & { type: "thread.spawn-updated"; spawned: SpawnedThread })
  // An agent gateway write landed on a project's scratchpad
  // (kone_scratchpad_write). `projectPath` scopes it to the project the pad
  // belongs to (a studio row is project-scoped, not thread-scoped); `writer` is
  // the agent session that wrote, null for user edits. Consumers apply it
  // only when `revision` is newer than their own.
  | (AgentBaseEvent & {
      type: "scratchpad.updated";
      scratchpadId: string;
      projectPath: string;
      title: string;
      body: string;
      revision: number;
      savedAt: number;
      writer: ScratchpadWriter | null;
    })
  // An agent tool call mutated the workspace theme or visual appearance.
  // The renderer applies the new themeId, mode, or preview overrides in real-time.
  | (AgentBaseEvent & {
      type: "app.theme_mutation";
      themeId?: string;
      mode?: "system" | "dark" | "light";
      preview?: boolean;
      colors?: Record<string, string>;
      customTheme?: {
        id: string;
        label: string;
        blurb?: string;
        appearance: "light" | "dark" | "adaptive";
        accent: string;
        ground?: string;
        roles?: Record<string, string>;
      };
    })
  // An agent tool call changed the app's agent roster — who a thread can be
  // handed to. The write is the renderer's to make: the shipped agents are
  // prose in its bundle and a stored row is a delta against one, so only it can
  // say what a cleared field falls back to.
  | (AgentBaseEvent & {
      type: "app.agent_mutation";
      op: "create" | "update" | "delete" | "select";
      /** Which agent. Absent only on a `select` handing the next turn to a
       *  guest, which is a real choice rather than a missing one. */
      agentId?: string;
      /** The fields to write. On a `create` the id above is the one the tool
       *  minted, so it can name the agent it made before the row exists. */
      fields?: {
        name?: string;
        role?: string;
        instructions?: string;
        face?: { body: string; ink: string };
        model?: { provider: string; model: string; label?: string };
        /** Ordered fallbacks behind `model`. Ignored when no primary is set. */
        modelFallbacks?: { provider: string; model: string; label?: string }[];
      };
      /** Fields to hand back: to the shipped preset on a built-in, unset on a
       *  user-made agent. Named rather than sent as null, because a null across
       *  IPC cannot be told from a client that filled in the blanks. */
      clear?: ("role" | "instructions" | "face" | "model")[];
      /** On a `create`, the project whose team the new agent also joins. */
      projectPath?: string;
    })
  // An agent tool call added, edited or removed a preset sub-agent — one of the
  // standing definitions `kone_spawn_worker_preset` cuts a spawn from. Unlike the
  // roster there is no inheritance to resolve, so the gateway has already
  // written the row and this only tells the open windows to re-read.
  | (AgentBaseEvent & {
      type: "app.subagent_presets_changed";
      op: "create" | "update" | "delete";
      presetId: string;
    })
  // An agent tool call changed the thread strip's own settings: where the strip
  // lands when a column takes focus, and the width a new pane opens at. Per
  // install rather than per project, and the renderer's alone to hold.
  | (AgentBaseEvent & {
      type: "app.strip_mutation";
      centering?: "never" | "on-overflow" | "always";
      defaultWidths?: { thread?: number; terminal?: number; scratchpad?: number };
    })
  | (AgentBaseEvent & { type: "turn.started"; turnId: string })
  // A follow-up message offered into a RUNNING turn: same turn, no new
  // boundary — the provider consumes it when it builds its next request.
  // `turnId` is the live turn the message was steered into; `message` is the
  // trimmed prompt text (absent for attachment-only steers — the event is
  // then not emitted at all).
  | (AgentBaseEvent & { type: "turn.steered"; turnId: string; message: string })
  // A follow-up was durably enqueued because the thread has a live turn.
  // `position` is the turn's place in line within the queue (the first queued
  // follow-up is #1). `dispatchMode` distinguishes a plain follow-up from a
  // steer request that fell back to the queue (steers claim first).
  | (AgentBaseEvent & {
      type: "turn.queued";
      queueId: string;
      userBlockId: string;
      dispatchMode: "queue" | "steer";
      position: number;
      input?: string;
      /** JSON.stringify(ChatAttachment[]) — null when the turn has no attachments. */
      attachmentsJson?: string | null;
    })
  // A queued follow-up was cancelled before it ran — the user dropped it
  // (`user`), the thread's session was stopped (`stop`), or the thread was
  // deleted/archived (`thread-deleted`/`archive`). Consumers renumber the
  // remaining chips.
  | (AgentBaseEvent & {
      type: "turn.queued-cancelled";
      queueId: string;
      reason: "user" | "stop" | "thread-deleted" | "archive";
    })
  // A queued follow-up was handed to the adapter as a real turn (the queue row
  // is gone). `turnId` is the adapter's turn id when sendTurn returned one —
  // omitted when the adapter doesn't name the turn until its turn.started.
  | (AgentBaseEvent & { type: "turn.promoted"; queueId: string; turnId?: string })
  | (AgentBaseEvent & { type: "turn.queued-reordered"; queueIds: string[] })
  | (AgentBaseEvent & { type: "turn.completed"; turnId: string; conversationId?: string })
  | (AgentBaseEvent & {
      type: "turn.aborted";
      turnId: string;
      reason: TurnAbortReason;
      message?: string;
    })
  // `subagentToolUseId` scopes the item to a nested subagent run instead of the
  // parent turn's own body.
  | (AgentBaseEvent & {
      type: "item.started";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  | (AgentBaseEvent & {
      type: "item.updated";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  | (AgentBaseEvent & {
      type: "item.completed";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  // One nested subagent run's identity/status. Its transcript arrives as ordinary
  // item events tagged with the run's `subagentToolUseId`.
  | (AgentBaseEvent & { type: "subagent.started"; turnId: string; subagent: SubagentRunSnapshot })
  | (AgentBaseEvent & { type: "subagent.updated"; turnId: string; subagent: SubagentRunSnapshot })
  | (AgentBaseEvent & { type: "subagent.completed"; turnId: string; subagent: SubagentRunSnapshot })
  // Background runs settled after the turn that spawned them had already ended.
  // The main process answers this by driving one more turn on the thread, so
  // nothing here has to: the renderer sees that turn through the ordinary turn
  // events. Mirrored because the union is contract, not because anything folds it.
  | (AgentBaseEvent & {
      type: "subagent.background-settled";
      turnId: string;
      subagents: SubagentRunSnapshot[];
    })
  | (AgentBaseEvent & {
      type: "user-input.requested";
      requestId: string;
      turnId?: string;
      questions: UserInputQuestion[];
    })
  | (AgentBaseEvent & { type: "user-input.resolved"; requestId: string; answers: UserInputAnswers })
  // The provider is asking for the user's go-ahead before the agent runs
  // something and the turn is parked until they decide (respondToRequest).
  // `subagentToolUseId` scopes the ask to a nested subagent run.
  | (AgentBaseEvent & {
      type: "approval.requested";
      requestId: string;
      turnId?: string;
      approval: ApprovalRequest;
      subagentToolUseId?: string;
    })
  // The parked approval was answered (or drained on interrupt/stop) — clear
  // the prompt.
  | (AgentBaseEvent & { type: "approval.resolved"; requestId: string; decision: ApprovalDecision });

// ── persisted conversation history ───────────────────────────────────────────
// What the main-process ConversationStore reads back off disk. Kept in the same
// UserBlock | AssistantBlock timeline shape the renderer uses, so a reloaded
// thread drops straight into `blocks`. Mirrors packages/agent-core/src/types.ts.

export type StoredThreadMeta = {
  threadId: string;
  projectPath: string;
  provider: ProviderKind;
  model?: string;
  conversationId?: string;
  createdAt: number;
  updatedAt: number;
  /** The branch the project was on when the thread last ran. */
  branch?: string | null;
  /** Working-tree diffstat snapshotted at the thread's last turn. */
  added?: number;
  removed?: number;
  /** Tokens spent on the thread — cumulative for providers that report a running
   *  total (Codex), summed across turns for per-turn reporters (Claude). */
  tokens?: number;
  /** The user's chosen per-thread knobs, persisted so a reopened thread restores
   *  the picker exactly where the user left it. Each knob is a ModelDescriptor
   *  axis id — the same values SendTurnInput carries. */
  selection?: {
    effort?: string;
    serviceTier?: string;
    /** The chosen context-window id (ModelDescriptor.contextWindows[].id).
     *  Named distinctly from the token-meter `contextWindow` number below —
     *  that one is a last-reported usage snapshot, this is a user choice. */
    contextWindow?: string;
    mode?: InteractionMode;
  };
  /** The last assistant message uuid of the conversation (Claude only), for
   *  reliable resume — see SessionStartInput.resumeSessionAt. */
  resumeSessionAt?: string;
  /** Pins live in the DB (v18), not browser localStorage — a pinned thread
   *  follows the thread across profiles. */
  isPinned?: boolean;
  /** Timestamp when the thread was pinned (v1 baseline), or null if unpinned. */
  pinnedAt?: number | null;
  /** Timestamp when the thread was archived (v1 baseline), or null if active. */
  archivedAt?: number | null;
  /** Recency ordering key: last conversation activity. */
  lastActivityAt?: number;
  /** For side chats and forks: the thread this was forked from. */
  sourceThreadId?: string;
  /** For spawned threads: the parent thread id. */
  parentThreadId?: string;
  /** For child threads: kind of relationship to the parent. */
  relationshipToParent?: RelationshipToParent | null;
  /** Your standing answer on whether this thread still has a claim on you
   *  (v29). Done is a fact about you, not about the work: it stops the thread
   *  asking without stopping the agent, closing the thread, or archiving it.
   *
   *  Three values, three different answers. A timestamp is "I marked it then" —
   *  and it expires by comparison with `lastActivityAt`, so a thread the agent
   *  has spoken in since is asking again whatever the stamp says, and nothing
   *  has to write here when a turn lands. Null is "I never said", which leaves
   *  the thread free to be counted done once it has been quiet long enough.
   *  Zero is "I said it is not done", which outranks age.
   *
   *  Never read it alone — go through isThreadDone, which holds all three. */
  doneAt?: number | null;
  /** When you last had this thread in front of you (v30), or null for a thread
   *  written before the column existed / never opened since.
   *
   *  Unread is the comparison with `lastActivityAt`, not a flag: the agent has
   *  spoken since you last looked. A stamp has one writer — the surface showing
   *  the thread — where a flag would need one writer to set it on every turn and
   *  another to clear it on every open, with a crash between the two leaving a
   *  thread permanently shouting or permanently quiet.
   *
   *  Never read it alone — go through isThreadUnread. */
  lastVisitedAt?: number | null;
  /** Last context-window snapshot the thread reported, so a reopened thread can
   *  restore its meter fill immediately instead of showing empty until the next
   *  turn. Overwritten (not accumulated) at each token-usage event. */
  contextUsed?: number;
  contextWindow?: number;
  compactsAutomatically?: boolean;
  /** Agent-generated (or first-turn word-fallback) working title. */
  title?: string;
  /** Present when this thread is a side chat (or any future fork): the stored
   *  handoff context — source thread, fork point, import time, bootstrap
   *  status. The renderer reads it to label + filter the timeline. */
  forkContext?: ForkContext;
  /** Present for app-owned relationships (side chats today, subagents with the
   *  spawn design). `relationshipToParent === "side_chat"` is the
   *  discriminator. */
  lineage?: ThreadLineage;
  /** Short text excerpt or preview of the latest turn/prompt. */
  snippet?: string;
};

// ── thread lineage & fork context (side chats) ───────────────────────────────
// A side chat is a user-initiated child conversation forked from a parent
// thread: it inherits the parent's transcript as *reference-only* context,
// runs as its own root thread, and never pollutes the parent. The
// discriminator for "is this thread a side chat" is
// `lineage.relationshipToParent === "side_chat"` — never a title prefix, never
// a message source. Mirrors packages/agent-core/src/types.ts.

/** How an app-owned thread relates to another thread. `"subagent"` =
 *  agent-initiated work unit (spawn design, Phase 0); `"side_chat"` =
 *  user-initiated fork. */
export type RelationshipToParent = "subagent" | "side_chat";

/** Thread lineage for app-owned relationships. Side chats are roots:
 *  `parentThreadId` is null and archive/retention subtree walks ignore them. */
export type ThreadLineage = {
  parentThreadId: string | null;
  relationshipToParent: RelationshipToParent | null;
  rootThreadId: string;
};

/** Stored handoff context — the fork point and what was imported. */
export type ForkContext = {
  /** The thread this side chat was forked from. */
  sourceThreadId: string;
  /** Id of the last native block in the source at import time. Provenance
   *  only — the import is never truncated. */
  forkPointBlockId: string | null;
  /** Epoch millis when the fork was created. */
  importedAt: number;
  /** One-shot bootstrap flag: `"pending"` until the thread's first turn
   *  completes. Gates the `<sidechat_context>` injection. */
  bootstrapStatus: "pending" | "completed";
};

/** Where a stored block came from: a live conversation row (`"native"`) or a
 *  fork import (`"fork-import"`). Imported rows carry their original `at` and
 *  are not activity — they never refresh a thread's `updated_at`. */
export type BlockSource = "native" | "fork-import";

// ── thread spawning (agent-owned child threads) ──────────────────────────────
// docs/thread-spawning-design.md. A running agent asks kone — over the MCP
// gateway — to open a NEW thread on any installed provider, with its own
// prompt, model and effort, and kone drives that thread to completion in the
// main process. The child is a first-class thread: sidebar row, persisted,
// resumable, openable.
//
// Deliberately NOT the same thing as a provider-native subagent (`SubagentRun`)
// — that is one CLI running nested agents inside a single turn. Both read
// "subagent" in the UI; `lineage.relationshipToParent === "subagent"` is the
// discriminator for the app-owned kind.
//
// Mirrors packages/agent-core/src/types.ts.

/** Where a spawned child should run. `provider` is required; the rest fall
 *  back to the parent's when the parent is on the same provider. */
export type SpawnTarget = {
  provider: ProviderKind;
  model?: string;
  effort?: string;
};

/** A target kone had to change to make a spawn work, reported back rather than
 *  silently applied. */
export type SpawnAdjustment = {
  field: "model" | "effort" | "mode";
  requested: string;
  applied: string | null;
  reason: string;
};

/** A spawned thread's rolled-up state. Approval/input gates beat "working": a
 *  child parked on a question is the most important thing to surface, because
 *  nothing moves until a human answers it. `starting` = the spawn is in flight
 *  (first turn not started yet, session live); `stillborn` = the child was
 *  created but never dispatched (a crash between the row write and dispatch) —
 *  terminal, so a parent wait on it settles instead of hanging. */
export type SpawnedThreadStatus =
  | "starting"
  | "working"
  | "waiting-for-approval"
  | "waiting-for-user-input"
  | "idle"
  | "stillborn"
  | "completed"
  | "failed"
  | "interrupted";

/** One spawned child, projected for both the parent agent's wait tool and the
 *  UI — one shape, one source (trap #10: no second view model). */
export type SpawnedThread = {
  threadId: string;
  parentThreadId: string;
  title: string;
  provider: ProviderKind;
  model?: string;
  effort?: string;
  status: SpawnedThreadStatus;
  /** True once the child has settled and will not move again on its own. */
  terminal: boolean;
  createdAt: number;
  updatedAt: number;
  /** Wall-clock millis the child's turns have run, for "replied in 52s". */
  elapsedMs?: number;
  /** The child's final assistant text, capped — the only thing that crosses
   *  back into the parent's context. */
  summary?: string;
  /** Failure reason, or the question/approval the child is parked on. */
  detail?: string;
  /** When the child is parked on an APPROVAL, the parked requestId + the
   *  normalized ask — answerable in place via `agent.respond(threadId,
   *  requestId, decision)`. Absent for every other status. */
  gate?: { requestId: string; approval: ApprovalRequest };
  tokens?: number;
};

export type StoredBlock =
  | {
      id: string;
      role: "user";
      text: string;
      at: number;
      attachments?: ChatAttachment[];
      /** Absent = `"native"`; `"fork-import"` = copied in from a side chat's
       *  source thread (original `at`, never refreshes `updated_at`). */
      source?: BlockSource;
    }
  | {
      id: string;
      role: "assistant";
      turnId: string;
      items: RuntimeItem[];
      state: "running" | RuntimeTurnState;
      error?: string;
      at: number;
      endedAt?: number;
      source?: BlockSource;
    };

export type StoredThread = StoredThreadMeta & { blocks: StoredBlock[] };

/** One windowed page of a stored thread (keyset-paginated, user-anchored):
 *  metadata plus the page's blocks in ascending timeline order, and the
 *  opaque cursor for the next strictly older page. `nextCursor` is null (and
 *  `hasMore` false) when the whole thread is in hand. */
export type StoredThreadPage = {
  threadId: string;
  meta: StoredThreadMeta;
  blocks: StoredBlock[];
  /** Cursor for the next strictly older page; null when the walk is complete.
   *  Opaque — consumers echo it back verbatim. */
  nextCursor: string | null;
  /** Whether older blocks exist beyond this page. */
  hasMore: boolean;
};

/** Outcome of an archive/restore request over the history bridge. Success
 *  carries every thread id the stamp landed on — the requested thread plus its
 *  spawned subtree, ancestor-first. `busy` means a spawned descendant was
 *  mid-turn; nothing was written. */
export type ThreadArchiveResult =
  | { ok: true; threadIds: string[] }
  | { ok: false; reason: "missing" | "busy" | "error" };

export type KoneAgentHistoryApi = {
  /** The project's most recently active thread, metadata only (no transcript) —
   *  or null. Resolve the transcript separately via `threadPage`/`thread`. */
  latest: (projectPath: string) => Promise<StoredThreadMeta | null>;
  /** One stored thread by id, fully reconstructed — or null. */
  thread: (threadId: string) => Promise<StoredThread | null>;
  /** One windowed page of a stored thread, newest window first: first page
   *  when no cursor is given, then the next strictly older page per cursor.
   *  Null when the thread is missing. */
  threadPage: (
    threadId: string,
    options?: { limit?: number; cursor?: string },
  ) => Promise<StoredThreadPage | null>;
  /** Every stored thread for a project (metadata only), newest first. The live
   *  threads by default; with `archived: true`, only the put-away ones. The two
   *  are disjoint views, never a union. */
  list: (projectPath: string, options?: { archived?: boolean }) => Promise<StoredThreadMeta[]>;
  /** Hide a thread from the recent list (recoverable), or restore it. The
   *  result comes back so the asking surface can undo its optimistic row drop
   *  on a busy refusal (a spawned descendant mid-turn) instead of watching the
   *  row vanish and reappear. */
  archive: (threadId: string, archived: boolean) => Promise<ThreadArchiveResult>;
  /** Permanently delete a thread and its transcript. Irreversible. */
  remove: (threadId: string) => Promise<void>;
  /** Pin (or unpin) a thread — pins live in the DB so they follow the thread
   *  across browser profiles. */
  setPinned: (threadId: string, pinned: boolean) => Promise<void>;
  /** Mark a thread done (you are finished with its claim on you), or take the
   *  mark off. Stored in the DB beside pins, so it follows the thread across
   *  profiles. Not archive: the thread stays in the live list, and it starts
   *  asking again by itself once the agent speaks in it — see
   *  `StoredThreadMeta.doneAt`. */
  setDone: (threadId: string, done: boolean) => Promise<void>;
  /** Record that the user has just had this thread in front of them — what
   *  makes a reply seen. The stamp only moves forward unless `force` is set,
   *  which is how a thread is deliberately marked unread again. See
   *  `StoredThreadMeta.lastVisitedAt`. */
  setVisited: (threadId: string, at: number, force?: boolean) => Promise<void>;
  /** Lifetime, fully-local usage stats aggregated across every project, for the
   *  standalone profile board. */
  profileStats: () => Promise<ProfileStats>;
};

/** Lifetime, fully-local usage stats for the profile board — every figure is
 *  aggregated in SQL across all projects (never a cloud call). A prompt is one
 *  user block; day/hour buckets follow the machine's local calendar. Ranked
 *  lists arrive already sorted most-used first. */
export type ProfileStats = {
  generatedAt: number;
  totals: {
    threads: number;
    prompts: number;
    tokens: number;
    inputTokens: number;
    outputTokens: number;
    projects: number;
  };
  streak: {
    current: number;
    longest: number;
    peakDay: { date: string; count: number } | null;
  };
  /** One entry per active local day, ascending by date (YYYY-MM-DD). */
  activity: Array<{ date: string; count: number }>;
  /** Prompts binned by local hour 0–23 (only non-empty hours). */
  hours: Array<{ hour: number; count: number }>;
  mostActiveHour: number | null;
  providers: Array<{ provider: ProviderKind; count: number }>;
  models: Array<{ model: string; provider: ProviderKind; count: number }>;
  reasoning: Array<{ effort: string; count: number }>;
  projects: Array<{ path: string; name: string; prompts: number }>;
};

// ── Agents page: usage ──────────────────────────────────────────────────────
// The same local SQL story as ProfileStats, but bounded to a window and,
// optionally, to one project — and carrying an estimated cost. Nothing here
// is a bill: the money figure is tokens priced against a static published
// rate table, and the UI is required to say so.

/** The windows the usage report can be asked for. */
export type UsageRange = "1d" | "7d" | "30d" | "all";

export type UsageTotals = {
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  threads: number;
  costUsd: number;
};

export type UsageDayProvider = {
  provider: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  costUsd: number;
};

/** One local calendar day. The report is dense across the whole range —
 *  including days with no activity — so a chart never has to invent gaps. */
export type UsageDay = {
  /** YYYY-MM-DD, local calendar. */
  date: string;
  tokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  costUsd: number;
  byProvider: UsageDayProvider[];
};

/** A ranked slice of usage by model, provider or project. `key` is the stable
 *  identity to render by; `label` is already display-ready. */
export type UsageBySlice = {
  key: string;
  label: string;
  provider?: string;
  tokens: number;
  cacheReadTokens: number;
  cacheCreationTokens: number;
  reasoningTokens: number;
  prompts: number;
  costUsd: number;
};

export type AgentUsageReport = {
  generatedAt: number;
  range: UsageRange;
  scope: "project" | "global";
  projectPath: string | null;
  totals: UsageTotals;
  /** Ascending, one entry per day in range (zero days included). */
  days: UsageDay[];
  /** Descending by tokens. */
  models: UsageBySlice[];
  providers: UsageBySlice[];
  projects: UsageBySlice[];
};

export type KoneAgentUsageApi = {
  /** Aggregate the per-turn token rows over a window. Pass a `projectPath` to
   *  scope it to one project, or null for every project on the machine. */
  report: (options: {
    range: UsageRange;
    projectPath?: string | null;
    forceRefresh?: boolean;
  }) => Promise<AgentUsageReport>;
};

// ── Agents page: provider quota ─────────────────────────────────────────────
// Bring-your-own-subscription, extended from "can this CLI run" to "how much
// of your plan is left". For most providers kone reads the OAuth token that
// provider's own CLI already wrote to this machine and calls that provider's
// own usage endpoint with it; for OpenCode there is no network call at all,
// because OpenCode records authoritative per-message cost to a local database.
// Nothing is read or sent until the user opts that provider in, and no
// credential is ever stored or forwarded anywhere by kone.
//
// Mirrors packages/agent-core/src/quota/types.ts — keep the two in step.

/** Providers kone can report a quota card for. Factory Droid reads through
 *  Factory's billing/usage APIs with the user's own Factory API key. */
export type QuotaCapableProvider = "claudeAgent" | "codex" | "opencode" | "cursor" | "antigravity" | "droid";

/** What a number *is*, so the UI can format it without a per-provider special
 *  case: a share of a window, an amount of money, or a plain tally. */
export type MetricKind = "percent" | "dollars" | "count";

/** One number kone is prepared to put on screen.
 *
 *  `number: null` means **"no data"** — not zero. Rendering `$0.00` when a read
 *  simply failed is a lie that reads as good news, so a null renders as
 *  "No data" and nothing else. */
export type MetricValue = {
  number: number | null;
  kind: MetricKind;
  /** Short unit suffix for `count` values ("credits"); unused for the rest. */
  suffix?: string;
  /** True when kone computed this rather than the provider reporting it —
   *  surfaces as a "~" and a footnote. */
  estimated?: boolean;
};

/** Whether a rolling window is actually running. `notStarted` matters: a
 *  rolling window with no usage in it has no reset time, and inventing a
 *  countdown for it would be fabrication. */
export type QuotaWindowState = "active" | "notStarted" | "unknown";

/** One usage window in a provider's report. */
export type QuotaWindow = {
  id: string;
  label: string;
  used: MetricValue;
  /** The cap, when the provider publishes one; null for an uncapped meter. */
  limit: MetricValue | null;
  /** 0..1 fraction consumed, or null when unknowable (no cap, or no data).
   *  A null draws no bar rather than an empty one. */
  percent: number | null;
  state: QuotaWindowState;
  resetsAt: string | null;
};

/** A spend figure for a fixed calendar span — "Today · $4.08 · 1.2M". Money
 *  and tokens are separately nullable; a provider can report one without the
 *  other. */
export type SpendTile = {
  id: string;
  label: string;
  dollars: number | null;
  tokens: number | null;
  estimated: boolean;
};

/** One day on a provider card's trend sparkline. Days with no usage are
 *  present with `dollars: 0` — for a daily series the zero is the true claim. */
export type TrendPoint = {
  /** `YYYY-MM-DD`, local time. */
  date: string;
  dollars: number;
  tokens: number;
};

/** How a provider's report resolved. `disconnected` = no credential found;
 *  `accessDenied` = the OS refused to hand one over; `stale` = a cached
 *  report while a fresh read is in flight or backed off; `transientFailure` =
 *  retryable; `terminalFailure` = a rejection retrying won't fix. */
export type QuotaConnection =
  | "connected"
  | "disconnected"
  | "accessDenied"
  | "stale"
  | "transientFailure"
  | "terminalFailure";

export type QuotaProviderReport = {
  provider: QuotaCapableProvider;
  connection: QuotaConnection;
  /** The single most representative window — what a compact row shows when
   *  there is room for only one number. */
  primary: QuotaWindow | null;
  /** Every window reported, `primary` included. */
  windows: QuotaWindow[];
  /** Today / Yesterday / Last 30 days, where the provider's data supports it. */
  spend: SpendTile[];
  /** Daily series for the card's sparkline, oldest first. Empty when unknown. */
  trend: TrendPoint[];
  /** The plan/tier label when the provider names one, e.g. "Max 20x". */
  planLabel: string | null;
  /** Models whose cost kone could not price, and therefore left *out* of the
   *  dollar figures above. Pricing an unknown model at zero would understate
   *  spend with no way for the user to find out; naming them is what makes the
   *  exclusion honest. */
  excludedModels: string[];
  /** True when the report reflects a 429 backoff rather than a fresh read, so
   *  the UI can say the figures may be stale instead of a vague "waiting". */
  rateLimited?: boolean;
  /** Set when this report re-serves a last-known-good snapshot after a fetch
   *  failed for a reason other than a formatted rate limit, so the UI can say
   *  the figures might be behind instead of passing off old numbers as fresh.
   *  Never set together with `rateLimited`. */
  stale?: boolean;
  fetchedAt: number;
  /** Why, when `connection` isn't "connected" — rendered as the row's line. */
  message?: string;
};

export type KoneAgentQuotaApi = {
  /** Is there a credential on disk we could read? Local, offline, and never a
   *  network call — this only decides whether "Connect" is offered. */
  detect: (provider: QuotaCapableProvider) => Promise<boolean>;
  /** Read the provider's live usage. Only ever called for a provider the user
   *  connected. `allowKeychain` must be true only on a user-initiated action —
   *  a background read must not risk a surprise OS credential prompt. */
  fetch: (
    provider: QuotaCapableProvider,
    options?: { allowKeychain?: boolean; force?: boolean },
  ) => Promise<QuotaProviderReport>;
};

// ── Agents page: inventory ──────────────────────────────────────────────────
// A read-only snapshot of what the agent CLIs on this machine can reach:
// skills, MCP servers, and the instruction files in scope. The scan itself
// only reads; the writes live below, on the skills API.

/** One on-disk copy of a skill: enough to name where it is and who would
 *  have offered it, never the file's contents. */
export type SkillCopy = { origin: string; scope: SkillEntry["scope"]; path: string };

/** One discovered skill (a directory holding a SKILL.md). `origin` names the
 *  CLI root it was found under — a plain string, not a union, so a new origin
 *  can't break the contract. Today: claude | codex | opencode | cursor |
 *  agents | kone. */
export type SkillEntry = {
  name: string;
  description: string | null;
  /** Absolute SKILL.md path. */
  path: string;
  directory: string;
  origin: string;
  scope: "user" | "project" | "plugin" | "system";
  displayName: string | null;
  shortDescription: string | null;
  /** Who the SKILL.md credits, from `author` (or nested `metadata.author`) frontmatter; null when unsigned. */
  author: string | null;
  /** SKILL.md mtime, epoch ms — carried by the scan so the list can date a row
   *  without reading the file again. */
  modifiedAt: number;
  /** Copies of this same skill name that lost the precedence contest, nearest
   *  loser first. Empty for the overwhelming majority of skills. */
  shadowedBy: SkillCopy[];
  /** True when the SKILL.md asks not to be invoked automatically
   *  (`disable-model-invocation: true`) — the skill is still there, but the
   *  model won't reach for it on its own. */
  manualOnly: boolean;
  enabled: boolean;
  /** Whether the skill is enabled under Kone's internal visibility and execution gate. */
  internalEnabled?: boolean;
  /** True when this copy is shadowed by a higher-precedence copy of the same name. */
  shadowed?: boolean;
  /** When shadowed, points to the winning copy that shadowed it. */
  shadowedByWinner?: SkillCopy | null;
};

/** Full per-skill detail for the skill detail view — what the list's
 *  name/description snippet can't show. Read on demand instead of padding the
 *  scan's payload, so the list render never waits on the slowest root. */
export type SkillDetail = {
  /** The SKILL.md absolute path, as resolved. */
  path: string;
  directory: string;
  bytes: number;
  /** Epoch ms. */
  modifiedAt: number;
  /** Every frontmatter key/value as written, keys lowercased-as-parsed. */
  frontmatter: Record<string, string>;
  /** Markdown body after the frontmatter block, whitespace-trimmed and
   *  capped (see below). */
  body: string;
  /** True when the body was cut short by the cap. */
  bodyTruncated: boolean;
  /** Sibling files/dirs bundled with the skill (scripts/, references/, ...),
   *  relative to `directory`, sorted, dirs marked. Capped at 60 entries. */
  resources: { name: string; kind: "file" | "directory" }[];
};

/** How an MCP server is reached. `unknown` is a real, expected value — many
 *  on-disk configs omit an explicit type and give nothing to infer from. */
export type McpTransport = "stdio" | "http" | "sse" | "ws" | "unknown";

export type McpServerEntry = {
  name: string;
  transport: McpTransport;
  command: string | null;
  args: string[];
  url: string | null;
  /** Env var KEY NAMES the config declares — never the values, which may be
   *  API keys. The UI is required to say so. */
  envKeys: string[];
  sourcePath: string;
  /** Human label for the source, e.g. "Claude Code · project". */
  sourceLabel: string;
  scope: "user" | "project";
  /** Null when the source has no enable/disable concept at all — distinct
   *  from a server the source explicitly turned off. */
  enabled: boolean | null;
};

/** One CLAUDE.md / AGENTS.md in scope. */
export type InstructionFile = {
  path: string;
  kind: "AGENTS.md" | "CLAUDE.md" | "other";
  scope: "user" | "project" | "nested";
  bytes: number;
  modifiedAt: number;
  /** The opening prose, frontmatter and heading marks stripped. */
  excerpt: string;
};

/** One scan-step failure, carried alongside the partial result rather than
 *  failing the whole inventory — a short list for an unreadable reason is a
 *  lie, so the UI shows these. */
export type PluginEntry = {
  name: string;
  description: string | null;
  path: string;
  origin: string;
  scope: "user" | "project" | "plugin" | "system";
  skills: SkillEntry[];
  /** Whether the plugin is enabled under Kone's internal settings. */
  internalEnabled?: boolean;
};

export type InventoryError = { source: string; message: string };

export type AgentInventory = {
  scannedAt: number;
  projectPath: string | null;
  skills: SkillEntry[];
  plugins: PluginEntry[];
  mcpServers: McpServerEntry[];
  instructions: InstructionFile[];
  errors: InventoryError[];
};

export type KoneAgentInventoryApi = {
  /** Scan every discovery root, plus the given project's own config. Accepts a
   *  single path or every project added in the app. Never throws. */
  scan: (projectPath: string | string[] | null) => Promise<AgentInventory>;
  /** Read one SKILL.md's full detail for the detail view. Refuses anything
   *  that is not an absolute SKILL.md path, and never throws — an
   *  unresolvable path resolves to null. */
  readSkill: (skillMdPath: string) => Promise<SkillDetail | null>;
};

// ── Agents page: managing a skill ───────────────────────────────────────────
// Turning a skill off writes the setting file its own CLI already reads; kone
// holds no switch of its own. Not every CLI has such a setting, so `unsupported`
// is a real answer rather than a failure, and it must never be drawn as a
// switch that does nothing.

/** A skill's effective state. `unsupported` means this CLI offers no way to
 *  turn a skill off at all. */
export type SkillState =
  | "enabled"
  | "name-only"
  | "user-invocable-only"
  | "disabled"
  | "unsupported";

/** The states that can actually be written — everything but `unsupported`. */
export type WritableSkillState = Exclude<SkillState, "unsupported">;

/** What the renderer knows about a skill when asking about its state: the
 *  scan's own facts. */
export type SkillStateQuery = {
  origin: string;
  skillName: string;
  /** Absolute SKILL.md path — Codex's config selects skills by path. */
  skillPath?: string;
  scope?: SkillEntry["scope"];
  /** The pane's project path, for project-scope settings files. */
  projectPath?: string | null;
  frontmatter?: Record<string, string> | null;
};

/** `reason` is a finished sentence naming the exact file the state came from,
 *  written to be shown as-is; `source` is that file's path. Both are null for
 *  a plain enabled skill, which has nothing to explain. */
export type SkillStateResult = {
  state: SkillState;
  reason: string | null;
  source: string | null;
};

/** `ok` covers the "nothing needed writing" cases too; `reason` says which. */
export type StateWriteResult = { ok: boolean; wrotePath: string | null; reason: string };

/** One thing worth telling the author about their SKILL.md. `message` is a
 *  finished sentence, not a rule name. */
export type SkillFinding = {
  id: string;
  severity: "error" | "warning" | "info";
  message: string;
};

/** How much of an agent's at-rest reading budget the skill's listing spends. */
export type SkillCostFacts = {
  descriptionChars: number;
  listingChars: number;
  overSpecCap: boolean;
  overListingCap: boolean;
};

/** One informative fact about what a skill does. `detail` carries the
 *  specifics; `preview` shows decoded or redacted text where that is the
 *  point. */
export type SkillSecuritySignal = {
  id: string;
  label: string;
  detail: string | null;
  preview: string | null;
};

/** `limitation` states plainly what this reading cannot tell the user, so the
 *  signals are never mistaken for a verdict. */
export type SkillSignals = {
  cost: SkillCostFacts;
  security: SkillSecuritySignal[];
  limitation: string;
};

/** Where a skill came from — the scan knows this and the path does not. */
export type SkillSignalsContext = { origin: string; scope: SkillEntry["scope"] };

/** A folder one CLI reads skills out of. `exists` is false for a root nobody
 *  has written into yet — still a valid destination, since writing the first
 *  skill into it is what creates it. */
export type SkillRootTarget = {
  dir: string;
  origin: string;
  scope: "user" | "project";
  exists: boolean;
};

/** One surgical frontmatter edit: set replaces the key's line, delete removes
 *  it. The body is preserved byte for byte either way. */
export type SkillFrontmatterEdit =
  | { op: "set"; key: string; value: string }
  | { op: "delete"; key: string };

/** `detail` is one finished sentence describing what happened, on success and
 *  on failure alike — show it rather than composing wording of your own. */
export type SkillMutateResult = {
  ok: boolean;
  action: string;
  /** The path the action targeted, or null when it never reached one. */
  path: string | null;
  detail: string;
};

export type InternalSkillsSettings = {
  disabled: string[];
  disabledPlugins: string[];
};

export type KoneAgentSkillsApi = {
  /** Read a skill's effective state from whatever file its CLI keeps it in. */
  readState: (query: SkillStateQuery) => Promise<SkillStateResult>;
  /** Write the state into that same file, surgically — comments, key order and
   *  formatting in the user's config survive. */
  writeState: (query: SkillStateQuery, state: WritableSkillState) => Promise<StateWriteResult>;
  /** Read internal skills settings from backend persistence. */
  readInternalSettings?: () => Promise<InternalSkillsSettings>;
  /** Write internal skills settings to backend persistence. */
  writeInternalSettings?: (
    patch: Partial<InternalSkillsSettings>,
  ) => Promise<InternalSkillsSettings>;
  /** Set one skill's internal gate; the backend owns the disabled-list
   *  matching and returns the updated settings to adopt. */
  setSkillInternalState?: (
    skill: { path?: string; name: string },
    enabled: boolean,
  ) => Promise<InternalSkillsSettings>;
  /** Set one plugin's internal gate; same ownership as the skill variant. */
  setPluginInternalState?: (
    pluginIdOrDir: string,
    enabled: boolean,
  ) => Promise<InternalSkillsSettings>;
  /** Check one SKILL.md against the authoring rules. An unreadable path yields
   *  no findings. */
  lint: (skillMdPath: string) => Promise<SkillFinding[]>;
  /** Derive context cost and the honest signals about what a skill does.
   *  Resolves to null when the file cannot be read. */
  signals: (skillMdPath: string, context: SkillSignalsContext) => Promise<SkillSignals | null>;
  /** Every folder a new skill could be written into, whether or not it exists
   *  yet. The scan says what is installed; this says where something can go. */
  roots: (projectPath: string | string[] | null) => Promise<SkillRootTarget[]>;
  /** Create a new skill folder with a minimal SKILL.md under `root`. */
  scaffold: (root: string, name: string, description: string) => Promise<SkillMutateResult>;
  /** Edit frontmatter keys in place, leaving the body untouched. */
  editFrontmatter: (
    skillMdPath: string,
    edits: SkillFrontmatterEdit[],
  ) => Promise<SkillMutateResult>;
  /** Move a skill folder to the Trash. Never unlinks. */
  remove: (skillDir: string) => Promise<SkillMutateResult>;
  /** Clone a skill from a git URL into `destRoot`, confirming a SKILL.md
   *  actually arrived before calling it installed. */
  installFromGit: (url: string, destRoot: string) => Promise<SkillMutateResult>;
};

/** The user's per-thread picker knobs, persisted via agent:set-thread-selection
 *  so a reopened thread restores the picker exactly where it was left. Each
 *  knob is a ModelDescriptor axis id — the same values SendTurnInput carries;
 *  `model` lands on the thread's model column, the rest on the stored
 *  selection. Absent fields are left untouched. */
export type ThreadSelectionUpdate = {
  model?: string;
  effort?: string;
  serviceTier?: string;
  /** The chosen context-window id (ModelDescriptor.contextWindows[].id). */
  contextWindow?: string;
  mode?: InteractionMode;
};

/** The main process's disk-backed snapshot of the last known provider surface.
 *  Reading it spawns no CLI, so the picker can be genuinely populated the
 *  instant the app opens; a background refresh corrects it in place. */
export type ProviderSurfaceSnapshot = {
  version: number;
  /** ms epoch of the last write — 0 on a first-ever run (nothing cached yet). */
  savedAt: number;
  statuses: ProviderStatus[];
  models: Partial<Record<ProviderKind, ModelDescriptor[]>>;
};

export type KoneAgentApi = {
  /** Last known statuses + model catalogs, straight off disk. Instant. */
  surface: () => Promise<ProviderSurfaceSnapshot>;
  /** Ask the main process to re-probe every provider in the background. */
  warm: () => Promise<void>;
  /** Probe which agent CLIs are installed + logged in on this machine. */
  discover: () => Promise<ProviderStatus[]>;
  /** Provider health that changed on its own — a background re-probe, or a CLI
   *  the user signed into while the app was open. Fires only when a round
   *  actually differs. Returns an unsubscribe fn. */
  onProvidersChanged: (cb: (statuses: ProviderStatus[]) => void) => () => void;
  models: (provider: ProviderKind) => Promise<ModelDescriptor[]>;
  /** The user's persisted per-provider install settings (custom binary path, …). */
  getSettings: () => Promise<ProviderSettingsMap>;
  /** Persist one provider's install settings; re-points its live adapter and
   *  resolves to the updated full map. */
  setSettings: (
    provider: ProviderKind,
    config: ProviderConfig,
  ) => Promise<ProviderSettingsMap>;
  /** How each provider's CLI is installed, and whether it's behind. Passing
   *  `checkLatest: false` keeps it entirely local (no registry call). */
  maintenance: (options?: {
    checkLatest?: boolean;
    force?: boolean;
  }) => Promise<ProviderMaintenance[]>;
  /** Update one provider's CLI through the channel that installed it, then
   *  re-probe. Resolves with the transcript and the refreshed surface. */
  updateProvider: (provider: ProviderKind) => Promise<ProviderUpdateResult>;
  /** Persisted conversation history (read-only). */
  history: KoneAgentHistoryApi;
  /** Ranged token/cost accounting over the same per-turn rows history is built
   *  from — the Agents page's usage report. */
  usage: KoneAgentUsageApi;
  /** Live provider quota, strictly opt-in per provider. */
  quota: KoneAgentQuotaApi;
  /** Read-only scan of the skills, MCP servers and instruction files this
   *  machine's agent CLIs can reach. */
  inventory: KoneAgentInventoryApi;
  /** Managing a skill rather than reporting one: its state, its findings, and
   *  the writes — scaffold, edit, delete, install. */
  skills: KoneAgentSkillsApi;
  /** Persist the user's per-thread picker selection (model/effort/serviceTier/
   *  contextWindow) so a reopened thread restores it exactly. */
  setThreadSelection: (
    threadId: string,
    selection: ThreadSelectionUpdate,
  ) => Promise<void>;
  /** Rename a thread (user-initiated). Resolves true when the title changed.
   *  Does not touch recency ordering; the title.updated event follows on the
   *  runtime stream. */
  renameThread: (threadId: string, title: string) => Promise<boolean>;
  /** Start a thread; resolves once the session is ready. */
  startSession: (input: SessionStartInput) => Promise<Session>;
  /** Persist an attachment's bytes to disk; resolves to the bytes-free
   *  ChatAttachment the composer then carries on its next turn. */
  uploadAttachment: (input: UploadAttachmentInput) => Promise<ChatAttachment>;
  /** Return the verified absolute path on disk for an attachment ID. */
  getAttachmentPath: (attachmentId: string) => Promise<string | null>;
  /** Reveal an attachment in the host's file manager (Finder / Explorer). */
  showAttachmentInFolder: (attachmentId: string) => Promise<boolean>;
  /** Send a turn; resolves when accepted — output flows through onEvent. */
  sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
  /** Fork a side chat off a source thread. The renderer mints the thread id;
   *  a replayed id resolves "exists". The created fork streams as
   *  `thread.sidechat-created`; its first send carries the imported-transcript
   *  bootstrap. */
  createSideChat: (input: CreateSideChatInput) => Promise<CreateSideChatResult>;
  interrupt: (threadId: string) => Promise<void>;
  stopSession: (threadId: string) => Promise<void>;
  respond: (
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  /** Answer a pending mid-turn question (AskUserQuestion / requestUserInput),
   *  unblocking the parked turn. */
  respondUserInput: (
    threadId: string,
    requestId: string,
    answers: UserInputAnswers,
  ) => Promise<void>;
  /** Stop one nested subagent run without ending the parent turn. No-op on
   *  providers without a nested-agent surface. */
  stopSubagent: (threadId: string, toolUseId: string) => Promise<void>;
  /** Queue a mid-task message for a running nested subagent. Delivered on the
   *  child's next tool call. */
  steerSubagent: (threadId: string, toolUseId: string, message: string) => Promise<void>;
  /** The thread's durably enqueued follow-ups, in execution order (steers
   *  first, then FIFO) — the queue UI reads this to render its chips. */
  queuedTurns: (threadId: string) => Promise<QueuedTurnRow[]>;
  /** Drop one queued follow-up (cancels with reason "user"). Resolves false
   *  when no such row exists. */
  cancelQueuedTurn: (threadId: string, queueId: string) => Promise<boolean>;
  reorderQueuedTurns: (threadId: string, queueIds: string[]) => Promise<boolean>;
  /** Deliver a mid-turn message without starting a new turn boundary: routes
   *  to the live turn when the provider has a live-steer channel, else
   *  enqueues it as a steer (claiming first) — or sends normally when there
   *  is no live turn to steer. */
  steerTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
  /** The child threads this thread has spawned, projected fresh from the store.
   *  The spawn events aren't journaled, so a reloaded renderer has no record of
   *  them — this is how the Subagents dock repopulates after a reload. */
  spawnChildren: (threadId: string) => Promise<SpawnedThread[]>;
  /** Subscribe to the runtime event stream; returns an unsubscribe fn. */
  onEvent: (cb: (event: RuntimeEvent) => void) => () => void;
};

// ── Terminal layer ─────────────────────────────────────────────────────────

export type TerminalId = string;

export type TerminalStatus =
  | "starting"
  | "ready"
  | "exited"
  | "closed"
  | "error";

export type TerminalOpenInput = {
  terminalId: TerminalId;
  cwd: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
};

export type TerminalWriteInput = {
  terminalId: TerminalId;
  data: string;
};

export type TerminalResizeInput = {
  terminalId: TerminalId;
  cols: number;
  rows: number;
};

export type TerminalCloseInput = {
  terminalId: TerminalId;
  deleteHistory?: boolean;
};

export type TerminalRestartInput = {
  terminalId: TerminalId;
  cwd?: string;
  cols?: number;
  rows?: number;
};

export type TerminalAckInput = {
  terminalId: TerminalId;
  byteCount: number;
};

export type TerminalSessionSnapshot = {
  terminalId: TerminalId;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  status: TerminalStatus;
  /** Replay payload: a mode-restoring preamble followed by the sanitized,
   *  accumulated output (queries stripped, ANSI styling intact), capped to a
   *  byte ceiling. Safe to feed xterm verbatim. */
  history: string;
  /** Monotonic per-session event counter at snapshot time. Renderers use it to
   *  drop a stale re-seed (the manager re-emits `started` on re-attach). */
  sequence: number;
  exitCode: number | null;
  exitSignal: number | null;
  /** True while a non-shell subprocess (vim, `npm run dev`) is alive under the
   *  PTY. Drives the strip's busy state. */
  hasRunningSubprocess: boolean;
  /** Normalized command name of that subprocess, when known. */
  childCommandLabel: string | null;
};

export type TerminalEvent =
  | { terminalId: TerminalId; type: "started"; sequence: number; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "output"; sequence: number; data: string }
  | { terminalId: TerminalId; type: "exited"; sequence: number; exitCode: number | null; signal?: number }
  | { terminalId: TerminalId; type: "error"; sequence: number; message: string }
  | { terminalId: TerminalId; type: "restarted"; sequence: number; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "closed"; sequence: number }
  | {
      terminalId: TerminalId;
      type: "activity";
      sequence: number;
      hasRunningSubprocess: boolean;
      childCommandLabel: string | null;
    };

export type KoneTerminalApi = {
  open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
  write: (input: TerminalWriteInput) => Promise<void>;
  resize: (input: TerminalResizeInput) => Promise<void>;
  close: (input: TerminalCloseInput) => Promise<void>;
  restart: (input: TerminalRestartInput) => Promise<TerminalSessionSnapshot>;
  /** Flow-control: report consumed output bytes so the main process can
   *  pause/resume the PTY (backpressure). */
  ack: (input: TerminalAckInput) => Promise<void>;
  onEvent: (cb: (event: TerminalEvent) => void) => () => void;
};

export type ScratchpadRecord = {
  id: string;
  projectPath: string;
  title: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  sortIndex: number;
  /** Optimistic-concurrency counter, bumped on every write (store v15). The
   *  editor sends its last-known value with each save; gateway agent writes
   *  guard on it so user and agent edits never silently clobber each other. */
  revision: number;
};

export type ScratchpadListInput = {
  projectPath: string;
};

export type ScratchpadSaveInput = {
  scratchpadId: string;
  projectPath: string;
  title: string;
  body: string;
  /** The editor's last-known revision — the web editor always sends it so
   *  user and agent (gateway) writes never silently clobber each other.
   *  Omit to overwrite unconditionally. */
  expectedRevision?: number;
};

/** The result of scratchpad:save — the persisted state, or a revision
 *  conflict carrying the current revision so the editor can retry against
 *  fresh state. Null = store failure. */
export type ScratchpadSaveResult =
  | { savedAt: number; revision: number }
  | { conflict: number }
  | null;

/** Which agent session wrote a pad — carried by kone_scratchpad_write results
 *  and scratchpad.updated events so the studio can attribute agent edits.
 *  User edits (the web editor) carry no writer. */
export type ScratchpadWriter = {
  model?: string;
  provider: ProviderKind;
};

export type ScratchpadDeleteInput = {
  scratchpadId: string;
};

export type KoneScratchpadApi = {
  list: (input: ScratchpadListInput) => Promise<ScratchpadRecord[]>;
  save: (input: ScratchpadSaveInput) => Promise<ScratchpadSaveResult>;
  delete: (input: ScratchpadDeleteInput) => Promise<void>;
};

export type StudioSaveInput = {
  layout: StudioLayout;
};

/** The studio is one plane spanning every project, so a load has nothing to
 *  address — the whole document comes back or nothing does. */
export type KoneStudioApi = {
  load: () => Promise<StudioLayout | null>;
  save: (input: StudioSaveInput) => Promise<{ savedAt: number } | null>;
};

/** A skill an agent is assigned, keyed by the path the skills inventory uses.
 *  Name and origin ride along so a chip renders without a fresh scan (mirrors
 *  the desktop `AgentSkillRef`). */
export type AgentSkillRef = {
  path: string;
  name: string;
  origin: string;
};

/** A model an agent may run on — a provider and a model id within it, with a
 *  label for display (mirrors the desktop `AgentModelRef`). */
export type AgentModelRef = {
  provider: ProviderKind;
  model: string;
  label?: string;
};

/**
 * An agent's picture — what says who is speaking (mirrors the desktop
 * `AgentAvatarRef`).
 *
 * `src` is anything an `<img>` can load, which is what keeps one field able to
 * answer for every way of getting a picture: a data URL for one stored on the
 * row, an app-relative path for one that ships with the build. `source` is not
 * how to load it — it is where it came from, which is what a later "change
 * picture" flow needs in order to offer the right thing again.
 */
export type AgentAvatarRef = {
  source: "generated" | "upload" | "dicebear" | "shipped";
  src: string;
};

/** An agent's bot — the creature it drives, as the three ids that make one
 *  (mirrors the desktop `AgentBotRef`). Ids and nothing derived: the geometry
 *  behind them is the renderer's, so a stored bot never freezes a copy of it. */
export type AgentBotRef = {
  form: string;
  color: string;
  expression: string;
};

/**
 * An agent as it lives in the store (mirrors the desktop `AgentRecord`,
 * store v27).
 *
 * Every prose field is nullable and the null carries meaning: on a row with a
 * `presetId` it means "inherit whatever the shipped preset says", which this
 * side resolves — the presets live here, in `~/utils/agents`. `''` is a
 * different answer: a field the user deliberately emptied, which stays empty.
 *
 * Capabilities follow the same null-is-inherit rule: `skills` is additive so
 * `[]` is "none assigned", and `model` is the single model the agent runs on —
 * null inherits the preset's, a ref is the model it uses, and an agent that
 * names none lets the thread pick per turn.
 */
export type AgentRecord = {
  agentId: string;
  /** The shipped preset this row overlays, or null for a user-made agent. */
  presetId: string | null;
  name: string | null;
  /** One line under the name in the roster. Never sent to a provider. */
  role: string | null;
  instructions: string | null;
  /** The marble the face is drawn in, and the ink drawn on it. */
  faceBody: string | null;
  faceInk: string | null;
  /** The agent's picture (v27); null inherits the preset's, and an agent with
   *  none falls back to its drawn face. */
  avatar: AgentAvatarRef | null;
  /** The agent's bot (v27); null inherits the preset's, and an agent with none
   *  has no bot at all — which is different from having the default one. */
  bot: AgentBotRef | null;
  /** The skills assigned to the agent; null inherits, `[]` is none. */
  skills: AgentSkillRef[] | null;
  /** The one model the agent runs on; null inherits the preset's, a ref is the
   *  model it uses, and no model named means the thread picks per turn. */
  model: AgentModelRef | null;
  /** Models tried in order when `model` can't run. Only meaningful alongside a
   *  `model`; a null primary ignores the list. Null next to a null `model` is
   *  inherit; `[]` is a pinned model with no second choice. */
  modelFallbacks: AgentModelRef[] | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
  /** When the agent left the roster, or null while they're still in it. The row
   *  outlives the deletion so a finished thread can still name who worked it. */
  deletedAt: number | null;
};

export type AgentCreateInput = {
  agentId?: string;
  name: string;
  role?: string | null;
  instructions?: string | null;
  faceBody?: string | null;
  faceInk?: string | null;
  avatar?: AgentAvatarRef | null;
  bot?: AgentBotRef | null;
  skills?: AgentSkillRef[] | null;
  model?: AgentModelRef | null;
  modelFallbacks?: AgentModelRef[] | null;
};

/** An edit. A key left out is left alone; an explicit null clears the field —
 *  back to the shipped preset on an overlay row, unset on a user-made agent. */
export type AgentPatch = {
  name?: string | null;
  role?: string | null;
  instructions?: string | null;
  faceBody?: string | null;
  faceInk?: string | null;
  avatar?: AgentAvatarRef | null;
  bot?: AgentBotRef | null;
  skills?: AgentSkillRef[] | null;
  model?: AgentModelRef | null;
  modelFallbacks?: AgentModelRef[] | null;
};

/** A fork of an existing agent. `inherited` carries the shipped preset's values
 *  for whatever the source row leaves null, because a fork keeps no inheritance
 *  of its own: it copies what the source reads as. */
export type AgentDuplicateInput = {
  agentId: string;
  newAgentId?: string;
  name?: string;
  inherited?: {
    name?: string | null;
    role?: string | null;
    instructions?: string | null;
    faceBody?: string | null;
    faceInk?: string | null;
    avatar?: AgentAvatarRef | null;
    bot?: AgentBotRef | null;
    skills?: AgentSkillRef[] | null;
    model?: AgentModelRef | null;
    modelFallbacks?: AgentModelRef[] | null;
  };
};

export type RosterHydrateInput = {
  /** The built-ins this build ships, in the order it wants them. The store
   *  gives each one an overlay row if it hasn't got one, and never resurrects
   *  one the user deleted. */
  presetIds: string[];
};

export type RosterUpdateInput = {
  agentId: string;
  patch: AgentPatch;
};

export type RosterDeleteInput = {
  agentId: string;
};

export type RosterTeamInput = {
  projectPath: string;
};

export type RosterTeamMemberInput = {
  projectPath: string;
  agentId: string;
};

/**
 * Who worked a thread. `agentId` is null when it ran as a guest — a recorded
 * decision, not a missing one; a thread that never started has no binding at
 * all.
 */
export type ThreadAgentBinding = {
  threadId: string;
  agentId: string | null;
};

/** The whole roster layer in one reply: who exists, who worked what, and who is
 *  up next. `agents` includes deleted ones, so a thread they worked can still be
 *  captioned with their name. */
export type RosterSnapshot = {
  agents: AgentRecord[];
  bindings: ThreadAgentBinding[];
  selectedAgentId: string | null;
};

/** Settle who works a thread. Write-once: an already-settled thread keeps what
 *  it settled on, and the reply says what that is. A null `agentId` is a guest. */
export type RosterBindInput = {
  threadId: string;
  agentId: string | null;
};

/** Carry a binding onto a thread reborn under a new id. */
export type RosterCarryInput = {
  fromThreadId: string;
  toThreadId: string;
};

/** Point the next turn at an agent, or at a guest with null. */
export type RosterSelectInput = {
  agentId: string | null;
};

/** The roster: the agents you can hand work to, and each project's team.
 *  Separate from `agent` — that surface drives provider sessions, and an agent
 *  in this sense is somebody you work with, not a process. */
export type KoneRosterApi = {
  /** Ensure-and-list, in one round trip. */
  hydrate: (input: RosterHydrateInput) => Promise<RosterSnapshot>;
  create: (input: AgentCreateInput) => Promise<AgentRecord | null>;
  update: (input: RosterUpdateInput) => Promise<AgentRecord | null>;
  delete: (input: RosterDeleteInput) => Promise<boolean>;
  duplicate: (input: AgentDuplicateInput) => Promise<AgentRecord | null>;
  team: (input: RosterTeamInput) => Promise<AgentRecord[]>;
  addToTeam: (input: RosterTeamMemberInput) => Promise<boolean>;
  removeFromTeam: (input: RosterTeamMemberInput) => Promise<void>;
  bind: (input: RosterBindInput) => Promise<ThreadAgentBinding | null>;
  carry: (input: RosterCarryInput) => Promise<ThreadAgentBinding | null>;
  select: (input: RosterSelectInput) => Promise<void>;
};

/**
 * Fetching a picture for an agent from the web.
 *
 * It lives in the main process rather than the renderer because a cross-origin
 * image can be DISPLAYED in the renderer but not READ there: drawing one to a
 * canvas taints it, so the bytes can never come back out, and the bytes are the
 * whole point — a generated face is different on every request, so storing the
 * URL would hand the agent a new face on every paint.
 *
 * Bytes, not a picture: what the picture is scaled to and stored as is the
 * renderer's business (see `~/utils/agentAvatar`), and it is the only side with a
 * canvas to do it with.
 */
export type KoneAvatarApi = {
  /** Bytes and their MIME type, or null if the fetch failed — offline, or the
   *  source declined to answer. */
  fetch: (input: { url: string }) => Promise<{ mime: string; bytes: Uint8Array } | null>;
};

/**
 * A preset sub-agent as it lives in the store (mirrors the desktop
 * `SubagentPresetRecord`, store v26).
 *
 * A lightweight, globally-available definition an agent cuts a spawn from:
 * a name, standing instructions, and one model. Unlike an `AgentRecord` there
 * is no preset above it to inherit from, so nothing here is null-means-inherit
 * — `instructions` null is simply "none", and `model` null is "no model, let
 * the caller's own stand".
 */
export type SubagentPresetRecord = {
  presetId: string;
  name: string;
  instructions: string | null;
  /** The model a spawn from this preset runs on, or null for no preference. */
  model: AgentModelRef | null;
  /** Models tried in order when `model` can't run. Same rules as an agent's. */
  modelFallbacks: AgentModelRef[] | null;
  sortOrder: number;
  createdAt: number;
  updatedAt: number;
};

export type SubagentPresetCreateInput = {
  presetId?: string;
  name: string;
  instructions?: string | null;
  model?: AgentModelRef | null;
  modelFallbacks?: AgentModelRef[] | null;
};

/** An edit to a preset. A key left out is left alone; the name is the one field
 *  that can't be cleared, since a preset with no name is not one. */
export type SubagentPresetPatch = {
  name?: string;
  instructions?: string | null;
  model?: AgentModelRef | null;
  modelFallbacks?: AgentModelRef[] | null;
};

export type PresetUpdateInput = {
  presetId: string;
  patch: SubagentPresetPatch;
};

export type PresetDeleteInput = {
  presetId: string;
};

/** The preset sub-agents: reusable definitions a spawn is cut from. Separate
 *  from `roster` — a preset is a standing definition any agent can invoke, not
 *  a person you hand a thread to. */
export type KonePresetsApi = {
  list: () => Promise<SubagentPresetRecord[]>;
  create: (input: SubagentPresetCreateInput) => Promise<SubagentPresetRecord | null>;
  update: (input: PresetUpdateInput) => Promise<SubagentPresetRecord | null>;
  delete: (input: PresetDeleteInput) => Promise<boolean>;
};

/** One theme in the renderer's library as the shell mirrors it. Deliberately
 *  flatter than a `ThemeDefinition`: the shell needs a theme's identity and its
 *  two defining colours, not its role table. */
export type KoneThemeRosterEntry = {
  id: string;
  label: string;
  blurb: string;
  kind: "system" | "adaptive" | "fixed";
  appearance: "light" | "dark";
  schemes: ("light" | "dark")[];
  accent: string;
  ground: string;
  origin: "built-in" | "custom" | "imported";
};

/** One agent in the roster as the shell mirrors it. Resolved and flattened: the
 *  shell wants who an agent is and what it runs on, not a drawn face or a sort
 *  order. */
export type KoneAgentRosterEntry = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  face: { body: string; ink: string };
  model: { provider: string; model: string; label?: string } | null;
  /** Ordered fallbacks behind `model`. Empty when the agent inherits or has no second choice. */
  modelFallbacks: { provider: string; model: string; label?: string }[];
  skills: string[];
  /** True for an agent kone ships — the ones whose cleared fields fall back to
   *  a shipped preset rather than being unset. */
  builtIn: boolean;
  /** True for the agent the next turn is handed to. */
  active: boolean;
  /** The project paths whose team this agent is on. */
  teams: string[];
};

/** The thread strip's settings as the shell mirrors them. The ladder rides along
 *  because a width is a rung index rather than a size. */
export type KoneStripSettings = {
  centering: "never" | "on-overflow" | "always";
  defaultWidths: { thread: number; terminal: number; scratchpad: number };
  ladder: number[];
};

/** One project as the shell mirrors it: the folder the user opened and how the
 *  app is holding it. No git state — the gateway reads that from disk when an
 *  agent asks, so it is never a stale copy of a tile's last render. */
export type KoneProjectEntry = {
  path: string;
  name: string;
  /** The project the window is showing. At most one, and none on the home. */
  active: boolean;
  pinned: boolean;
  /** Epoch ms of the last open, or null if it has never been opened. */
  lastOpenedAt: number | null;
};

export type KoneDesktopApi = {
  platform: string;
  /** Hands the chosen appearance to the shell so native chrome follows it.
   *  `state` additionally mirrors which theme is painted, the scheme it
   *  resolved to, and the library it was chosen from — none of which the shell
   *  can derive from the mode alone, and all of which the agent gateway reads
   *  back to describe and change the interface. */
  setTheme: (
    mode: "light" | "dark" | "system",
    state?: {
      themeId: string;
      themeLabel: string;
      mode: "light" | "dark" | "system";
      scheme: "light" | "dark";
      locked: boolean;
      themes?: KoneThemeRosterEntry[];
    },
  ) => Promise<void>;
  /** Mirrors what the renderer knows about itself and the shell cannot derive:
   *  the resolved agent roster, the thread strip's settings, and the projects
   *  the user has opened. The agent gateway reads it back so its tools describe
   *  and change the surfaces the user is actually looking at. */
  setAppState: (state: {
    agents?: KoneAgentRosterEntry[];
    strip?: KoneStripSettings;
    projects?: KoneProjectEntry[];
  }) => Promise<void>;
  fs: KoneFsApi;
  git: KoneGitApi;
  system: KoneSystemApi;
  agent: KoneAgentApi;
  terminal: KoneTerminalApi;
  scratchpad: KoneScratchpadApi;
  studio: KoneStudioApi;
  roster: KoneRosterApi;
  presets: KonePresetsApi;
  avatars: KoneAvatarApi;
  window: KoneWindowApi;
};

export type KoneWindowApi = {
  minimize: () => Promise<void>;
  toggleMaximize: () => Promise<{ isMaximized: boolean; isFullscreen: boolean }>;
  close: () => Promise<void>;
  getState: () => Promise<{ isMaximized: boolean; isFullscreen: boolean }>;
  onState: (cb: (state: { isMaximized: boolean; isFullscreen: boolean }) => void) => () => void;
  onAssistantToggle: (cb: () => void) => () => void;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}
