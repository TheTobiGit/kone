// Shape of the Electron preload bridge, as seen from the renderer.
// Mirrors apps/desktop/src/git.ts and apps/desktop/src/types/global.d.ts.
export {};

import type { BoardLayout } from "~/types/board";

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

// ── Git Space surface (mirrors apps/desktop/src/git/types.ts) ────────────────

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
  mergeability:
    | "clean"
    | "conflicting"
    | "blocked"
    | "behind"
    | "unstable"
    | "draft"
    | "unknown";
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
// Mirrors apps/desktop/src/agent/types.ts. "Bring your own subscription": kone
// drives the agent CLIs the user already installed + logged into; it never
// stores provider credentials.

export type ProviderKind = "codex" | "claudeAgent" | "cursor" | "opencode" | "droid";
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";
export type ProviderReadiness = "ready" | "needs-login" | "not-installed" | "error";

export type ProviderStatus = {
  provider: ProviderKind;
  label: string;
  available: boolean;
  authStatus: AuthStatus;
  readiness: ProviderReadiness;
  version?: string;
  authLabel?: string;
  message?: string;
};

/** The user's persisted per-provider install settings (mirrors
 *  apps/desktop/src/agent/types.ts). Credential-free by design — only how to
 *  reach the CLI the user already installed + logged into. */
export type ProviderConfig = {
  /** Override the CLI executable (absolute path or a name on PATH). Empty falls
   *  back to the adapter default (`codex` / `opencode`); ignored by providers
   *  with no external binary (Claude). */
  binaryPath?: string;
};

export type ProviderSettingsMap = Partial<Record<ProviderKind, ProviderConfig>>;

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
  activeTurnId?: string;
  model?: string;
  mode: InteractionMode;
};

// ── Attachments (mirror apps/desktop/src/agent/types.ts) ─────────────────────
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

export type ApprovalDecision = "allow-once" | "allow-always" | "reject-once";

// ── mid-turn user-input questions (mirror apps/desktop/src/agent/types.ts) ────
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
// off the `tool_call` item that spawned it. Mirrors apps/desktop/src/agent/types.ts.

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

export type ProviderRefs = { conversationId?: string; providerTurnId?: string };

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
  // Main-process store / side-channel work (e.g. first-turn title rename).
  | "kone.store";

type AgentBaseEvent = {
  threadId: string;
  provider: ProviderKind;
  at: number;
  source: RuntimeEventSource;
  refs?: ProviderRefs;
};

export type RuntimeEvent =
  | (AgentBaseEvent & { type: "session.started" })
  | (AgentBaseEvent & {
      type: "session.state.changed";
      state: RuntimeSessionState;
      message?: string;
    })
  | (AgentBaseEvent & { type: "session.exited"; code: number | null })
  | (AgentBaseEvent & { type: "thread.token-usage.updated"; usage: TokenUsage })
  | (AgentBaseEvent & { type: "thread.title.updated"; title: string })
  | (AgentBaseEvent & { type: "turn.started"; turnId: string })
  | (AgentBaseEvent & { type: "turn.completed"; turnId: string; conversationId?: string })
  | (AgentBaseEvent & {
      type: "turn.aborted";
      turnId: string;
      reason: RuntimeTurnState;
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
  | (AgentBaseEvent & {
      type: "user-input.requested";
      requestId: string;
      turnId?: string;
      questions: UserInputQuestion[];
    })
  | (AgentBaseEvent & { type: "user-input.resolved"; requestId: string; answers: UserInputAnswers });

// ── persisted conversation history ───────────────────────────────────────────
// What the main-process ConversationStore reads back off disk. Kept in the same
// UserBlock | AssistantBlock timeline shape the renderer uses, so a reloaded
// thread drops straight into `blocks`. Mirrors apps/desktop/src/agent/types.ts.

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
  /** Last context-window snapshot the thread reported, so a reopened thread can
   *  restore its meter fill immediately instead of showing empty until the next
   *  turn. Overwritten (not accumulated) at each token-usage event. */
  contextUsed?: number;
  contextWindow?: number;
  compactsAutomatically?: boolean;
  /** Agent-generated (or first-turn word-fallback) working title. */
  title?: string;
};

export type StoredBlock =
  | { id: string; role: "user"; text: string; at: number; attachments?: ChatAttachment[] }
  | {
      id: string;
      role: "assistant";
      turnId: string;
      items: RuntimeItem[];
      state: "running" | RuntimeTurnState;
      error?: string;
      at: number;
      endedAt?: number;
    };

export type StoredThread = StoredThreadMeta & { blocks: StoredBlock[] };

export type KoneAgentHistoryApi = {
  /** The project's most recently active thread, fully reconstructed — or null. */
  latest: (projectPath: string) => Promise<StoredThread | null>;
  /** One stored thread by id, fully reconstructed — or null. */
  thread: (threadId: string) => Promise<StoredThread | null>;
  /** Every stored thread for a project (metadata only), newest first. Excludes
   *  archived threads. */
  list: (projectPath: string) => Promise<StoredThreadMeta[]>;
  /** Hide a thread from the recent list (recoverable), or restore it. */
  archive: (threadId: string, archived: boolean) => Promise<void>;
  /** Permanently delete a thread and its transcript. Irreversible. */
  remove: (threadId: string) => Promise<void>;
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
  models: (provider: ProviderKind) => Promise<ModelDescriptor[]>;
  /** The user's persisted per-provider install settings (custom binary path, …). */
  getSettings: () => Promise<ProviderSettingsMap>;
  /** Persist one provider's install settings; re-points its live adapter and
   *  resolves to the updated full map. */
  setSettings: (
    provider: ProviderKind,
    config: ProviderConfig,
  ) => Promise<ProviderSettingsMap>;
  /** Persisted conversation history (read-only). */
  history: KoneAgentHistoryApi;
  /** Start a thread; resolves once the session is ready. */
  startSession: (input: SessionStartInput) => Promise<Session>;
  /** Persist an attachment's bytes to disk; resolves to the bytes-free
   *  ChatAttachment the composer then carries on its next turn. */
  uploadAttachment: (input: UploadAttachmentInput) => Promise<ChatAttachment>;
  /** Send a turn; resolves when accepted — output flows through onEvent. */
  sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
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
  listSessions: () => Promise<Session[]>;
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

export type TerminalSessionSnapshot = {
  terminalId: TerminalId;
  pid: number;
  cols: number;
  rows: number;
  cwd: string;
  status: TerminalStatus;
  history: string;
};

export type TerminalEvent =
  | { terminalId: TerminalId; type: "started"; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "output"; data: string }
  | { terminalId: TerminalId; type: "exited"; exitCode: number | null; signal?: number }
  | { terminalId: TerminalId; type: "error"; message: string }
  | { terminalId: TerminalId; type: "cleared" }
  | { terminalId: TerminalId; type: "restarted"; snapshot: TerminalSessionSnapshot }
  | { terminalId: TerminalId; type: "closed" };

export type KoneTerminalApi = {
  open: (input: TerminalOpenInput) => Promise<TerminalSessionSnapshot>;
  write: (input: TerminalWriteInput) => Promise<void>;
  resize: (input: TerminalResizeInput) => Promise<void>;
  clear: (terminalId: TerminalId) => Promise<void>;
  close: (input: TerminalCloseInput) => Promise<void>;
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
};

export type ScratchpadListInput = {
  projectPath: string;
};

export type ScratchpadSaveInput = {
  padId: string;
  projectPath: string;
  title: string;
  body: string;
};

export type ScratchpadDeleteInput = {
  padId: string;
};

export type KoneScratchpadApi = {
  list: (input: ScratchpadListInput) => Promise<ScratchpadRecord[]>;
  save: (input: ScratchpadSaveInput) => Promise<{ savedAt: number } | null>;
  delete: (input: ScratchpadDeleteInput) => Promise<void>;
};

export type BoardLoadInput = {
  projectPath: string;
};

export type BoardSaveInput = {
  projectPath: string;
  layout: BoardLayout;
};

export type KoneBoardApi = {
  load: (input: BoardLoadInput) => Promise<BoardLayout | null>;
  save: (input: BoardSaveInput) => Promise<{ savedAt: number } | null>;
};

export type KoneDesktopApi = {
  isDesktop: true;
  platform: string;
  version: string;
  fs: KoneFsApi;
  git: KoneGitApi;
  system: KoneSystemApi;
  agent: KoneAgentApi;
  terminal: KoneTerminalApi;
  scratchpad: KoneScratchpadApi;
  board: KoneBoardApi;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}
