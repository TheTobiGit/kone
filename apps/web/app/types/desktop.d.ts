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
  files: (dir: string, query?: string) => Promise<GitProjectFile[]>;
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
  /** Switch the working tree to a local branch; rejects when git blocks it. */
  checkout: (dir: string, branch: string) => Promise<void>;
};

export type KoneSystemApi = {
  username: () => Promise<string | null>;
  reveal: (path: string) => Promise<void>;
};

// ── Agent layer ────────────────────────────────────────────────────────────
// Mirrors apps/desktop/src/agent/types.ts. "Bring your own subscription": kone
// drives the agent CLIs the user already installed + logged into; it never
// stores provider credentials.

export type ProviderKind = "codex" | "claudeAgent" | "opencode";
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
  /** The context-window sizes this model can run in, when it has a choice. For
   *  Claude this is the auto-compact window (compact early at 200k vs run to the
   *  full native 1M), not a raw capacity switch. Absent for a single-window
   *  model (Haiku). `tokens` is the raw budget the adapter applies. */
  contextWindows?: { id: string; label: string; tokens: number; isDefault?: boolean }[];
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
};

export type TokenUsage = { input?: number; output?: number; total?: number };

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
  | (AgentBaseEvent & { type: "item.started"; turnId: string; item: RuntimeItem })
  | (AgentBaseEvent & { type: "item.updated"; turnId: string; item: RuntimeItem })
  | (AgentBaseEvent & { type: "item.completed"; turnId: string; item: RuntimeItem })
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

export type KoneAgentApi = {
  /** Probe which agent CLIs are installed + logged in on this machine. */
  discover: () => Promise<ProviderStatus[]>;
  models: (provider: ProviderKind) => Promise<ModelDescriptor[]>;
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
