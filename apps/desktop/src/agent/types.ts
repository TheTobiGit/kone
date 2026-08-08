// ── Agent provider data model ───────────────────────────────────────────────
// The load-bearing contract for kone's multi-provider agent layer. Everything
// here is flat and serializable — it all crosses the IPC boundary to the
// renderer. Mirror any change in apps/web/app/types/desktop.d.ts.
//
// The design: session control is request/ack — startSession/sendTurn/interrupt
// resolve as soon as the turn is
// *accepted* — and ALL streamed output flows through one normalized RuntimeEvent
// union. The renderer is written once against that union and never learns which
// CLI is underneath. Adding a provider is a new adapter, not a UI change.

/** A supported agent provider. `claudeAgent` drives Claude Code through the
 *  `@anthropic-ai/claude-agent-sdk` (which runs the user's own Claude login);
 *  `codex` drives `codex app-server`; `cursor` drives `cursor-agent acp`;
 *  `droid` drives Factory's `droid exec --output-format acp`.
 *  Grows as adapters land. */
export type ProviderKind = "codex" | "claudeAgent" | "opencode" | "cursor" | "droid";

// ── Discovery / health ───────────────────────────────────────────────────────

/** Whether the user's provider CLI is logged in (its own subscription/auth). */
export type AuthStatus = "authenticated" | "unauthenticated" | "unknown";

/** Rolled-up health for a provider row in the UI. */
export type ProviderReadiness = "ready" | "needs-login" | "not-installed" | "error";

/** The result of probing one provider on the user's machine. kone never holds
 *  provider credentials — this only *detects* an already-installed, already
 *  logged-in CLI. */
export type ProviderStatus = {
  provider: ProviderKind;
  /** Display name, e.g. "Codex". */
  label: string;
  /** Binary present on PATH and runnable. */
  available: boolean;
  authStatus: AuthStatus;
  readiness: ProviderReadiness;
  /** CLI version string, when detected. */
  version?: string;
  /** How the CLI is authenticated, e.g. "ChatGPT Sign-In" / "API Key". */
  authLabel?: string;
  /** Human message — a hint to fix a not-ready provider (e.g. run `codex login`). */
  message?: string;
};

/** A model the provider can run, from its own `list models` surface. */
export type ModelDescriptor = {
  /** Stable id passed back on a turn (what the CLI's --model flag expects). */
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
  /** The context-window sizes this model can run in, when it has a choice.
   *  For Claude this is the *auto-compact window* — the token budget Claude
   *  Code compacts the conversation at — not a raw model-capacity switch:
   *  current Claude models are natively 1M, so the real per-thread choice is
   *  whether to compact early at a safer 200k or run out to the full 1M.
   *  Absent for a model
   *  with a single fixed window (e.g. Haiku, 200k only). `tokens` is the raw
   *  budget the adapter applies; `id`/`label` drive the picker. */
  contextWindows?: { id: string; label: string; tokens: number; isDefault?: boolean }[];
};

// ── Session / turn IO ────────────────────────────────────────────────────────

/** How much the agent may do without asking. Mirrors the calm-UI intent. */
/** The approval-policy ladder — how much the agent may do without asking,
 *  from most to least restrictive: `ask` always asks first (read-only
 *  sandbox); `accept-edits` auto-approves file edits but still asks before
 *  commands/other actions; `full-access` never prompts. See CodexAdapter.ts's
 *  mapModeTo*Overrides for the per-mode mapping. kone deliberately stops short
 *  of a 4th `auto` rung (an AI-reviewed middle ground) — it's brand-new and
 *  unshipped. This is also deliberately NOT the same axis as a provider's
 *  separate plan/build turn mode (`ProviderInteractionMode`) — kone doesn't
 *  have that second toggle yet. */
export type InteractionMode = "ask" | "accept-edits" | "full-access";

export type SessionStartInput = {
  /** Caller-chosen thread id — kone owns this; the CLI's native id is mapped
   *  onto it via ProviderRefs. */
  threadId: string;
  provider: ProviderKind;
  /** Absolute path of the project/workspace root the agent operates in. */
  cwd: string;
  /** Provider model id (ModelDescriptor.id); provider default when omitted. */
  model?: string;
  mode?: InteractionMode;
  /** Reasoning-effort tier to run at. Flag-based providers (Codex) take effort
   *  per turn and ignore this; providers that fix effort when the session
   *  process spawns (Claude, whose SDK `effort` is a spawn-time option) read it
   *  here — changing it means restarting the session (AdapterCapabilities
   *  `sessionModelSwitch: "restart-session"`). */
  effort?: string;
  /** Provider-native conversation id to resume, when reopening a stored thread
   *  (StoredThreadMeta.conversationId). Present means "continue this prior
   *  conversation with its full context" — Codex resumes it via `thread/resume`,
   *  Claude passes it as the SDK `resume` option. Absent starts a fresh session.
   * Only meaningful when the provider matches the one that produced the id. */
  resume?: string;
  /** MCP gateway connection for this session, filled main-side by
   *  AgentService.startSession when the gateway is live. The adapter injects
   *  it into the provider session's mcpServers config so the agent can call
   *  kone tools. Renderer code never sets this. */
  gatewayConnection?: GatewayConnection;
};

export type Session = {
  threadId: string;
  provider: ProviderKind;
  cwd: string;
  status: RuntimeSessionState;
  /** Provider-native conversation id, once known — used to resume. */
  conversationId?: string;
  /** The resume id this session actually adopted, when `SessionStartInput.resume`
   *  was honored. Absent means the process came up with an empty context — either
   *  no resume was asked for, or the provider refused the one it was given
   *  (pruned/expired/foreign) and the adapter fell back to a fresh conversation,
   *  which every adapter does silently. Callers need the distinction: a thread
   *  with a stored transcript sitting on a blank process is the state where
   *  "continue" means nothing to the agent, so the send path replays the
   *  transcript as context instead. */
  resumedFrom?: string;
  /** Turn currently running, if any. */
  activeTurnId?: string;
  model?: string;
  mode: InteractionMode;
};

// ── Attachments ────────────────────────────────────────────────────────────
// Files/images the user attaches to a prompt. A turn carries only lightweight
// *metadata* (id + name + mime + size) — never bytes. The bytes are uploaded
// once over
// IPC (agent:upload-attachment), written to a per-user attachments dir, and
// read back off disk by each adapter at dispatch, where they're re-encoded
// into whatever that CLI wants (Codex data-URL image item / Claude base64
// image block / an on-disk-path text block for non-image files). Mirror any
// change in apps/web/app/types/desktop.d.ts.

/** How an attachment is fed to the agent. `image` → a native vision block for
 *  providers that support it; `file` (PDFs, docs, code, anything non-image, and
 *  images a provider can't render) → an on-disk path the agent reads with its
 *  own file tools. */
export type AttachmentKind = "image" | "file";

/** The bytes-free attachment metadata that rides a turn and is persisted with
 *  the user block. `id` doubles as the on-disk addressing key. */
export type ChatAttachment = {
  type: AttachmentKind;
  /** kone-minted id (also the stored file's name stem). */
  id: string;
  /** Original file name — shown in the chip and named in the path block. */
  name: string;
  mimeType: string;
  sizeBytes: number;
};

/** Upload payload: the renderer ships the raw bytes (base64, no data: prefix)
 *  exactly once; the main process persists them and returns the ChatAttachment
 *  the composer then carries on the turn. */
export type UploadAttachmentInput = {
  threadId: string;
  name: string;
  mimeType: string;
  /** Base64-encoded file bytes (no `data:…;base64,` prefix). */
  data: string;
};

/** Max bytes for an image attachment (10 MB). */
export const MAX_IMAGE_ATTACHMENT_BYTES = 10 * 1024 * 1024;
/** Max bytes for a non-image file attachment (25 MB). */
export const MAX_FILE_ATTACHMENT_BYTES = 25 * 1024 * 1024;
/** Image mime types Claude renders natively; anything else falls back to the
 *  on-disk path block. */
export const CLAUDE_NATIVE_IMAGE_MIME_TYPES = new Set([
  "image/gif",
  "image/jpeg",
  "image/png",
  "image/webp",
]);

export type SendTurnInput = {
  threadId: string;
  /** The user's prompt text for this turn. Can be empty when `attachments`
   *  carries at least one file — an attachment-only turn is valid. */
  input: string;
  /** Files/images attached to this turn (metadata only; bytes live on disk). */
  attachments?: ChatAttachment[];
  /** Override the session model for this turn. */
  model?: string;
  mode?: InteractionMode;
  /** Reasoning effort tier. Providers that bake effort into the model id
   *  ignore it; flag-based providers (Codex) map it to their own turn param. */
  effort?: string;
  /** A model's chosen service tier (e.g. Codex's "fast" tier id) for this
   *  turn. Absent means the provider's default tier. */
  serviceTier?: string;
  /** A model's chosen context-window id (ModelDescriptor.contextWindows[].id,
   *  e.g. "200k"/"1m"). Like `serviceTier` this rides each turn: Claude maps it
   *  to a live `autoCompactWindow` Setting toggled without restarting the
   *  session. Absent means the model's default window. */
  contextWindow?: string;
};

export type TurnStartResult = {
  threadId: string;
  /** kone-owned id for the turn just accepted. */
  turnId: string;
};

// ── side chat creation (agent:create-side-chat) ─────────────────────────────
// A side chat is a root thread with a fork pointer back at its source: the
// renderer mints the threadId (kone owns thread ids, exactly like every other
// thread), the desktop side validates + imports the source transcript, and the
// result streams as `thread.sidechat-created`. Duplicate dispatch with the
// same threadId is a replay ("exists") — requireThreadAbsent idempotency;
// requestId makes that exactly-once across app restarts. Mirror any change in
// apps/web/app/types/desktop.d.ts.

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
  /** Caller-chosen idempotency key. The same requestId replayed with the same
   *  threadId resolves as "exists"; replayed with a different threadId is an
   *  idempotency conflict. For the agent/MCP path this is the deterministic
   *  operationId (callerThreadId, callerTurnId, requestId) once that surface
   *  lands. */
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

export type ApprovalDecision = "allow-once" | "allow-always" | "reject-once";

// ── mid-turn user-input questions ────────────────────────────────────────────
// When the agent needs to ask the user something mid-turn — Claude's built-in
// `AskUserQuestion` tool, Codex's `item/tool/requestUserInput` app-server
// request — both are normalized into this one provider-neutral shape.
// The adapter parks the provider callback on a promise, emits a
// `user-input.requested` event, and resolves the promise when the renderer calls
// respondToUserInput — which returns the answers to the provider so the turn
// continues. Mirror any change in apps/web/app/types/desktop.d.ts.

/** One choice offered for a question. `description` is a short gloss under the
 *  label (Claude's AskUserQuestion always provides one; Codex may not). */
export type UserInputQuestionOption = {
  label: string;
  description?: string;
};

/** One question the agent asks the user mid-turn. A question with no `options`
 *  is a free-text prompt. */
export type UserInputQuestion = {
  /** Stable key the answer is filed under. For Claude this MUST equal the full
   *  question text — the SDK looks answers up by text, not by a synthetic id
   *  (see ClaudeAdapter.handleAskUserQuestion). */
  id: string;
  /** Short category/label shown as the question's chip. */
  header: string;
  /** The full question prompt shown to the user. */
  question: string;
  /** The choices offered; empty means a free-text answer. */
  options: UserInputQuestionOption[];
  /** Whether more than one option may be picked. Defaults to single-select. */
  multiSelect?: boolean;
};

/** The user's answers, keyed by question id → a single value (free text, or a
 *  single choice's label) or an array of labels (multi-select). `null` means the
 *  question was skipped — e.g. the whole request was cancelled/interrupted. */
export type UserInputAnswers = Record<string, string | string[] | null>;

// ── persisted conversation history ───────────────────────────────────────────
// What the ConversationStore reads back off disk. Kept in the renderer's own
// UserBlock | AssistantBlock timeline shape so a reloaded thread drops straight
// into `blocks` with no translation. Mirror in apps/web/app/types/desktop.d.ts.

/** A stored thread's metadata, without its transcript. */
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
  /** Agent-generated (or first-turn word-fallback) working title. Absent on
   *  threads that predate title persistence or have never received a turn. */
  title?: string;
  /** Present when this thread is a side chat (or any future fork): the
   *  handoff context — source thread, fork point, import time, bootstrap
   *  status. The renderer reads it to label + filter the timeline. */
  forkContext?: ForkContext;
  /** Present for app-owned relationships (side chats today, subagents with
   *  the spawn design). `relationshipToParent === "side_chat"` is the
   *  discriminator. */
  lineage?: ThreadLineage;
};

/** One reconstructed block — the persisted form of a renderer timeline block. */
export type StoredBlock =
  | {
      id: string;
      role: "user";
      text: string;
      at: number;
      attachments?: ChatAttachment[];
      /** Where the block came from. Absent = `"native"` (a live conversation
       *  row); `"fork-import"` = copied in from a side chat's source thread,
       *  carrying its original `at` and never refreshing `updated_at`. */
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

/** A thread reloaded from disk: metadata plus its blocks in arrival order. */
export type StoredThread = StoredThreadMeta & { blocks: StoredBlock[] };

// ── thread lineage & fork context (side chats) ───────────────────────────────
// A side chat is a user-initiated child conversation forked from a parent
// thread (docs/side-chat-design.md): it inherits the parent's transcript as
// *reference-only* context, runs as its own root thread, and never pollutes
// the parent. The data model extends the thread-spawning design's lineage
// block — side chats are still ROOTS for archive/retention subtree logic, so
// the relationship is a pointer, not a containment edge (`parentThreadId`
// stays null, subtree walks ignore them).
//
// The discriminator for "is this thread a side chat" is
// `lineage.relationshipToParent === "side_chat"` — never a title prefix, never
// a message source. Mirror any change in apps/web/app/types/desktop.d.ts.

/** How an app-owned thread relates to another thread. `"subagent"` =
 *  agent-initiated work unit (the spawn design's lineage, Phase 0 — not yet
 *  persisted by kone); `"side_chat"` = user-initiated fork. */
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
   *  only — the import is never truncated, so this does not mark a cut. */
  forkPointMessageId: string | null;
  /** Epoch millis when the fork was created. */
  importedAt: number;
  /** One-shot bootstrap flag: `"pending"` until the thread's first turn
   *  completes, then `"completed"`. Gates the `<sidechat_context>` injection
   *  (see sidechat.ts) so the imported transcript is handed to the model
   *  exactly once. */
  bootstrapStatus: "pending" | "completed";
};

/** Where a stored block came from: a live conversation row (`"native"`) or a
 *  fork import (`"fork-import"`). Imported rows carry their original `at` and
 *  are not activity — they never refresh a thread's `updated_at`. */
export type BlockSource = "native" | "fork-import";

// ── Normalized runtime event model ───────────────────────────────────────────
// Every adapter translates its transport (print-mode stdout, JSON-RPC, ACP, an
// SDK) into this union. Keep it flat + serializable.

export type RuntimeSessionState =
  | "starting"
  | "ready"
  | "running"
  | "waiting"
  | "stopped"
  | "error";

export type RuntimeTurnState = "completed" | "failed" | "interrupted";

/** A unit of work inside a turn the UI renders as one block. A shell command
 *  execution is a `tool_call` like any other — it doesn't get its own kind. */
export type RuntimeItemKind = "assistant_text" | "reasoning_text" | "plan_text" | "tool_call";

export type RuntimeItemStatus = "in-progress" | "completed" | "failed";

/** One entry in the agent's working checklist. Matches the shared vocabulary of
 *  Claude's TodoWrite and Codex's TurnPlanStep — the only two producers. */
export type PlanTaskStatus = "pending" | "in-progress" | "completed";

export type PlanTask = {
  /** kone-minted and held stable across snapshots. Providers send no ids (see
   *  agent-plan-tasks-plan.md §0), and the renderer needs a stable key:
   *  content is not one, because a checklist may legitimately repeat a label.
   *  Render identity only — nothing addresses a task by it. */
  id: string;
  /** Imperative form: TodoWrite `content`, Codex `step`. */
  content: string;
  /** Present-continuous form for the in-progress row. TodoWrite only; Codex
   *  sends no equivalent. */
  activeForm?: string;
  status: PlanTaskStatus;
};

// ── provider-native subagents ────────────────────────────────────────────────
// A provider can spawn *its own* nested agents inside a single turn: Claude
// Code's `Task`/`Agent` tool hands a scoped brief to a fresh agent with its own
// model, effort, tool allowlist and transcript, then folds that agent's final
// report back into the parent turn as the tool's result.
//
// This is NOT kone spawning a second thread/session (a separate conversation
// with its own provider process). It's one provider process running nested
// agents: the Task tool call is the run's identity (`tool_use_id`), the SDK's
// task lifecycle (`task_started`/`task_progress`/`task_notification`) carries
// its status and spend, and every message the child emits is tagged with
// `parent_tool_use_id` = that same tool-use id so it can be projected onto the
// child rather than the parent.
//
// kone keeps the child traffic nested inside the parent turn: the run hangs off
// the `tool_call` item that spawned it (`RuntimeItem.subagent`) and carries its
// own ordered `items`. Same data, one less concept — and it persists and
// rehydrates with the turn.

/** Lifecycle of one subagent run. `stopped` is a user/parent-initiated kill
 *  (Claude's `task_notification` status), distinct from a `failed` run. */
export type SubagentStatus = "starting" | "running" | "completed" | "failed" | "stopped";

/** Identity + status for one subagent run, without its transcript. Every
 *  `subagent.*` event carries a full snapshot (the same whole-value convention
 *  the `item.*` events use), so a consumer merges rather than patches. */
export type SubagentRunSnapshot = {
  /** The spawning Task/Agent tool-use id — the run's stable id, and the value
   *  every child message carries as `parent_tool_use_id`. */
  toolUseId: string;
  /** The provider's own task id, once known. Needed to stop the run. */
  taskId?: string;
  /** `itemId` of the parent turn's `tool_call` item this run hangs under, when
   *  it was still open when the run was recognized. Absent leaves the run an
   *  orphan the UI can render at the top level of the turn. */
  parentItemId?: string;
  /** The agent definition that was invoked, e.g. `explore` / `worker-high`. */
  agentType?: string;
  /** The Task tool's one-line `description` — the run's label. */
  description?: string;
  /** The brief the parent handed the child. */
  prompt?: string;
  /** Model the child runs (the Agent tool's `model` param), when reported. */
  model?: string;
  /** Reasoning effort the child runs at, when derivable (for Claude that's the
   *  `worker-<tier>` agent type, since the Agent tool has no effort param). */
  effort?: string;
  /** True for a fire-and-forget background run (the parent didn't block on it). */
  background?: boolean;
  status: SubagentStatus;
  /** The child's final report, once it settles. */
  summary?: string;
  /** Name of the tool the child ran most recently — a live progress hint. */
  lastToolName?: string;
  /** Tokens the child spent (its own meter, not the parent's). */
  tokens?: number;
  /** How many tool calls the child has made. */
  toolUses?: number;
  startedAt: number;
  endedAt?: number;
};

/** A subagent run plus the transcript it produced, in arrival order. Items are
 *  ordinary RuntimeItems — a child that itself delegates nests one level deeper. */
export type SubagentRun = SubagentRunSnapshot & { items: RuntimeItem[] };

/** One rendered item within a turn (text block or tool call). */
export type RuntimeItem = {
  itemId: string;
  kind: RuntimeItemKind;
  status: RuntimeItemStatus;
  /** Accumulated text for this item: the streamed narrative for the three text
   *  kinds, or a short inline target/summary (path, command, query) for a
   *  tool_call. */
  text: string;
  /** For `plan_text` items: the agent's checklist as data. `text` keeps the
   *  markdown rendering for the transcript and for threads stored before this
   *  landed; this is what the dock reads. */
  tasks?: PlanTask[];
  /** Tool/command name, for tool_call items. */
  name?: string;
  /** A tool_call's full result body — command stdout/stderr, a diff, a
   *  changed-file list — shown on demand. Undefined when there's nothing to
   *  expand. */
  detail?: string;
  /** For a `tool_call` that spawned a provider-native subagent (Claude's
   *  Task/Agent tool): the child run and its own transcript. Consumers build
   *  this from the `subagent.*` events plus the `item.*` events tagged with the
   *  run's `subagentToolUseId` — adapters emit the pieces, never the tree. */
  subagent?: SubagentRun;
};

/** Token accounting for a thread, when the provider exposes it. */
export type TokenUsage = {
  input?: number;
  output?: number;
  total?: number;
  /** Tokens currently occupying the provider's context window. This is separate
   * from `total`, which is cumulative for some providers and per-turn for others. */
  contextUsed?: number;
  /** The active model context/auto-compact budget, when the provider reports it. */
  contextWindow?: number;
  /** Whether the provider automatically compacts this context when needed. */
  compactsAutomatically?: boolean;
};

/** Maps kone ids to the provider's native ids — needed for resume/interrupt. */
export type ProviderRefs = {
  conversationId?: string;
  providerTurnId?: string;
};

/** Which agent session wrote a pad — carried by kone_scratchpad_write results
 *  and scratchpad.updated events so the board can attribute agent edits.
 *  User edits (the web editor) carry no writer. */
export type ScratchpadWriter = {
  model?: string;
  provider: ProviderKind;
};

/** Loopback MCP gateway connection for one provider session
 *  (apps/desktop/src/agent/gateway). Filled main-side at startSession — the
 *  renderer never sends it. */
export type GatewayConnection = {
  url: string;
  bearerToken: string;
};

/** Tags the transport an event came from — for debugging + provider-specific
 *  extension without polluting the union. */
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
  // Cursor speaks ACP (Agent Client Protocol) over `cursor-agent acp`'s stdio:
  // `notification` = a `session/update` notification, `stderr` = the CLI's
  // stderr line, `lifecycle` = process/session start+exit.
  | "cursor.acp.notification"
  | "cursor.acp.stderr"
  | "cursor.acp.lifecycle"
  // Factory Droid speaks the same ACP dialect over `droid exec --output-format
  // acp`'s stdio, so it carries the same three sources. Unlike Cursor's, this
  // agent advertises `loadSession` + session list/resume, so a stored thread
  // resumes in-protocol rather than starting cold.
  | "droid.acp.notification"
  | "droid.acp.stderr"
  | "droid.acp.lifecycle"
  // Main-process store / side-channel work (e.g. first-turn title rename).
  | "kone.store";

type BaseEvent = {
  threadId: string;
  provider: ProviderKind;
  /** Epoch millis when the event was produced. */
  at: number;
  source: RuntimeEventSource;
  refs?: ProviderRefs;
};

export type RuntimeEvent =
  | (BaseEvent & { type: "session.started" })
  | (BaseEvent & { type: "session.state.changed"; state: RuntimeSessionState; message?: string })
  | (BaseEvent & { type: "session.exited"; code: number | null })
  | (BaseEvent & { type: "thread.token-usage.updated"; usage: TokenUsage })
  | (BaseEvent & { type: "thread.title.updated"; title: string })
  // A side chat fork was persisted (agent:create-side-chat). `threadId` is the
  // new side chat's id; `sourceThreadId` is the thread it was forked from.
  | (BaseEvent & {
      type: "thread.sidechat-created";
      sourceThreadId: string;
      requestId: string;
    })
  // An agent gateway write landed on a project's scratchpad
  // (kone_scratchpad_write). `projectPath` scopes it to the project the pad
  // belongs to (the board is project-scoped, not thread-scoped); `writer` is
  // the agent session that wrote, null/absent for user edits. Consumers apply
  // it only when `revision` is newer than their own.
  | (BaseEvent & {
      type: "scratchpad.updated";
      padId: string;
      projectPath: string;
      title: string;
      body: string;
      revision: number;
      savedAt: number;
      writer: ScratchpadWriter | null;
    })
  | (BaseEvent & { type: "turn.started"; turnId: string })
  | (BaseEvent & { type: "turn.completed"; turnId: string; conversationId?: string })
  | (BaseEvent & { type: "turn.aborted"; turnId: string; reason: RuntimeTurnState; message?: string })
  // `subagentToolUseId` scopes the item to a nested subagent run instead of the
  // turn itself: it belongs in that run's `items`, not the assistant block's.
  | (BaseEvent & {
      type: "item.started";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  | (BaseEvent & {
      type: "item.updated";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  | (BaseEvent & {
      type: "item.completed";
      turnId: string;
      item: RuntimeItem;
      subagentToolUseId?: string;
    })
  // A provider-native subagent run was recognized / changed / settled. Each
  // carries the full snapshot; the run's transcript arrives as `item.*` events
  // tagged with its `subagentToolUseId`.
  | (BaseEvent & { type: "subagent.started"; turnId: string; subagent: SubagentRunSnapshot })
  | (BaseEvent & { type: "subagent.updated"; turnId: string; subagent: SubagentRunSnapshot })
  | (BaseEvent & { type: "subagent.completed"; turnId: string; subagent: SubagentRunSnapshot })
  // The agent is asking the user one or more questions mid-turn and the turn is
  // parked until they answer (respondToUserInput). `turnId` is the turn that
  // raised it, when known.
  | (BaseEvent & {
      type: "user-input.requested";
      requestId: string;
      turnId?: string;
      questions: UserInputQuestion[];
    })
  // The parked question has been answered (or cancelled) — clear the prompt.
  | (BaseEvent & { type: "user-input.resolved"; requestId: string; answers: UserInputAnswers });

/** The sink an adapter pushes every event into. AgentService owns it and fans
 *  events out to the renderer over IPC. */
export type EmitEvent = (event: RuntimeEvent) => void;

// ── Adapter interface ────────────────────────────────────────────────────────

/** Static feature flags so the facade/UI can pick fallbacks per provider. */
export type AdapterCapabilities = {
  /** How switching model mid-thread behaves. */
  sessionModelSwitch: "in-session" | "restart-session" | "unsupported";
  /** Emits incremental text deltas (vs one final blob). */
  streamsText: boolean;
  /** Surfaces structured tool-call events. */
  supportsToolEvents: boolean;
  /** Can resume a prior conversation. */
  supportsResume: boolean;
  /** Exposes a model list. */
  supportsModelList: boolean;
  /** Spawns provider-native subagents inside a turn and reports their nested
   *  transcripts (`subagent.*` events + items tagged with a run). */
  supportsSubagents: boolean;
};

/** Every provider implements this. Methods return once the request is accepted;
 *  results arrive asynchronously via the EmitEvent sink passed at construction. */
export interface ProviderAdapter {
  readonly provider: ProviderKind;
  readonly capabilities: AdapterCapabilities;

  /** Probe the user's machine: is the CLI installed and logged in? Read-only. */
  discover(): Promise<ProviderStatus>;

  /** List the models the CLI offers (empty when unsupported/unauthenticated). */
  listModels(): Promise<ModelDescriptor[]>;

  // lifecycle — request/ack
  startSession(input: SessionStartInput): Promise<Session>;
  sendTurn(input: SendTurnInput): Promise<TurnStartResult>;
  interruptTurn(threadId: string): Promise<void>;
  stopSession(threadId: string): Promise<void>;
  stopAll(): Promise<void>;

  // interactivity (no-ops on providers that don't prompt inline)
  respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void>;

  /** Answer a pending mid-turn question (Claude's AskUserQuestion / Codex's
   *  requestUserInput), unblocking the parked provider callback so the turn
   *  continues. No-op when nothing is pending for that requestId. */
  respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void>;

  /** Kill one running subagent without touching the rest of the turn (Claude:
   *  `query.stopTask`). The parent's Task tool call settles with a stopped
   *  result and the turn carries on. Optional — omitted by providers with no
   *  native subagents. */
  stopSubagent?(threadId: string, toolUseId: string): Promise<void>;

  /** Deliver a mid-task message to a *running* subagent, so the user can nudge
   *  a child agent without interrupting the parent turn (Claude: queued and
   *  injected as `additionalContext` on the child's next tool call, the only
   *  SDK channel that reaches a live subagent).
   *  Optional; a no-op resolve when the run already finished. */
  steerSubagent?(threadId: string, toolUseId: string, message: string): Promise<void>;

  // introspection
  listSessions(): Promise<Session[]>;
  hasSession(threadId: string): Promise<boolean>;

  /** Apply the user's persisted install settings for this provider (e.g. a
   *  custom CLI binary path). Optional — adapters with nothing to configure
   *  (Claude runs the SDK's embedded CLI) omit it. Takes effect on the next
   *  discover / session; running sessions keep the binary they spawned with. */
  setConfig?(config: ProviderConfig): void;
}

/** The user's persisted install settings for one provider. "Bring your own
 *  subscription" holds: kone never stores credentials — only how to reach the
 *  CLI the user already installed + logged into. An empty/absent field means
 *  "use the adapter's built-in default" (e.g. resolve `codex` on PATH). */
export type ProviderConfig = {
  /** Override the CLI executable — an absolute path or a name on PATH. Empty
   *  falls back to the adapter's default (`codex` / `opencode`). Ignored by
   *  providers with no external binary (Claude). */
  binaryPath?: string;
};

/** Persisted install settings for every provider, keyed by provider. */
export type ProviderSettingsMap = Partial<Record<ProviderKind, ProviderConfig>>;

// ── Install maintenance (see providerMaintenance.ts) ─────────────────────────

/** Which channel installed a provider's CLI, and therefore which one has to
 *  update it. `native` — the CLI's own updater; `bundled` — kone ships the
 *  runtime, so there's no user install at all; `unknown` — found on PATH but in
 *  a layout kone doesn't recognise, so it won't guess an update command. */
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
  /** The executable name/path kone resolves this provider by. */
  binary: string | null;
  /** Where that resolved on disk (the PATH entry), and what it points at when
   *  it's a shim into a versioned directory. */
  resolvedPath: string | null;
  realPath: string | null;
  /** Registry package the CLI publishes under, when it has one. */
  packageName: string | null;
  currentVersion: string | null;
  latestVersion: string | null;
  /** False when there's no registry kone can read a "latest" from — a
   *  self-updating CLI. Such a provider must never be shown as out of date. */
  latestKnowable: boolean;
  standing: VersionStanding;
  /** The exact shell command kone would run, shown so the user can run it
   *  themselves instead of trusting a button. */
  updateCommand: string | null;
  canUpdate: boolean;
  /** ms epoch of the last successful "latest version" lookup. */
  checkedAt: number | null;
};

export type ProviderUpdateOutcome = "succeeded" | "failed" | "unchanged" | "unsupported";

/** The result of running one provider's update, with the installer's own
 *  transcript and the re-probed provider surface. */
export type ProviderUpdateResult = {
  provider: ProviderKind;
  outcome: ProviderUpdateOutcome;
  message: string | null;
  output: string | null;
  /** Fresh maintenance for this provider, after the update ran. */
  maintenance: ProviderMaintenance;
  /** Re-probed statuses for every provider — an update changes the version the
   *  status row reports, so the pane refreshes from this rather than guessing. */
  statuses: ProviderStatus[];
};
