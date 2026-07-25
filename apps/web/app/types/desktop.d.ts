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

// ── Agent layer ────────────────────────────────────────────────────────────
// Mirrors apps/desktop/src/agent/types.ts. "Bring your own subscription": kone
// drives the agent CLIs the user already installed + logged into; it never
// stores provider credentials.

export type ProviderKind = "codex";
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

export type ModelDescriptor = {
  id: string;
  label: string;
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
};

/** The approval-policy ladder — how much the agent may do without asking,
 *  from most to least restrictive: `ask` always asks first (read-only
 *  sandbox); `accept-edits` auto-approves file edits but still asks before
 *  commands/other actions; `full-access` never prompts. Maps onto research's
 *  own `RuntimeMode` axis (minus its unshipped 4th "auto" rung) — see
 *  CodexAdapter.ts. */
export type InteractionMode = "ask" | "accept-edits" | "full-access";

export type SessionStartInput = {
  threadId: string;
  provider: ProviderKind;
  cwd: string;
  model?: string;
  mode?: InteractionMode;
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

export type SendTurnInput = {
  threadId: string;
  input: string;
  model?: string;
  mode?: InteractionMode;
  /** Reasoning effort tier. Providers that bake effort into the model id
   *  ignore it; providers that expose it as a flag (Codex) use it. */
  effort?: string;
  /** A model's chosen service tier (e.g. Codex's "fast" tier id) for this
   *  turn. Absent means the provider's default tier. */
  serviceTier?: string;
};

export type TurnStartResult = { threadId: string; turnId: string };

export type ApprovalDecision = "allow-once" | "allow-always" | "reject-once";

export type RuntimeTurnState = "completed" | "failed" | "interrupted";

/** A shell command execution is a `tool_call` like any other — it doesn't get
 *  its own kind. */
export type RuntimeItemKind = "assistant_text" | "reasoning_text" | "plan_text" | "tool_call";

export type RuntimeItemStatus = "in-progress" | "completed" | "failed";

export type RuntimeItem = {
  itemId: string;
  kind: RuntimeItemKind;
  status: RuntimeItemStatus;
  /** Streamed narrative for text kinds, or a short inline target/summary for
   *  a tool_call. */
  text: string;
  name?: string;
  /** A tool_call's full result body (command output, a diff, a changed-file
   *  list) — shown on demand. Undefined when there's nothing to expand. */
  detail?: string;
};

export type TokenUsage = { input?: number; output?: number; total?: number };

export type ProviderRefs = { conversationId?: string; providerTurnId?: string };

export type RuntimeEventSource =
  | "codex.rpc.notification"
  | "codex.rpc.stderr"
  | "codex.rpc.lifecycle";

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
  | (AgentBaseEvent & { type: "turn.started"; turnId: string })
  | (AgentBaseEvent & { type: "turn.completed"; turnId: string; conversationId?: string })
  | (AgentBaseEvent & {
      type: "turn.aborted";
      turnId: string;
      reason: RuntimeTurnState;
      message?: string;
    })
  | (AgentBaseEvent & { type: "item.started"; turnId: string; item: RuntimeItem })
  | (AgentBaseEvent & { type: "item.updated"; turnId: string; item: RuntimeItem })
  | (AgentBaseEvent & { type: "item.completed"; turnId: string; item: RuntimeItem });

export type KoneAgentApi = {
  /** Probe which agent CLIs are installed + logged in on this machine. */
  discover: () => Promise<ProviderStatus[]>;
  models: (provider: ProviderKind) => Promise<ModelDescriptor[]>;
  /** Start a thread; resolves once the session is ready. */
  startSession: (input: SessionStartInput) => Promise<Session>;
  /** Send a turn; resolves when accepted — output flows through onEvent. */
  sendTurn: (input: SendTurnInput) => Promise<TurnStartResult>;
  interrupt: (threadId: string) => Promise<void>;
  stopSession: (threadId: string) => Promise<void>;
  respond: (
    threadId: string,
    requestId: string,
    decision: ApprovalDecision,
  ) => Promise<void>;
  listSessions: () => Promise<Session[]>;
  /** Subscribe to the runtime event stream; returns an unsubscribe fn. */
  onEvent: (cb: (event: RuntimeEvent) => void) => () => void;
};

export type KoneDesktopApi = {
  isDesktop: true;
  platform: string;
  version: string;
  fs: KoneFsApi;
  git: KoneGitApi;
  system: KoneSystemApi;
  agent: KoneAgentApi;
};

declare global {
  interface Window {
    koneDesktop?: KoneDesktopApi;
  }
}
