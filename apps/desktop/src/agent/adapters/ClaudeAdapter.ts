import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import {
  query,
  type AccountInfo,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type PermissionResult,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import {
  buildClaudeEnv,
  parseClaudeCliVersion,
  resolveClaudeExecutable,
  summarizeClaudeAccount,
} from "../claudeHome.js";
import { buildAgentEnv } from "../processEnv.js";
import { probe } from "../spawn.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  EmitEvent,
  InteractionMode,
  ModelDescriptor,
  PlanTask,
  ProviderAdapter,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeItemStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
  UserInputAnswers,
  UserInputQuestion,
  UserInputQuestionOption,
} from "../types.js";
import type { ClaudeTrackedTask } from "../claudeTaskTracker.js";
import {
  applyClaudeTaskToolResult,
  isClaudeTaskTool,
  planTasksFromClaudeTracked,
} from "../claudeTaskTracker.js";
import { formatPlanTasks, parseTodoWriteInput, reconcilePlanTasks } from "../planTasks.js";
import {
  buildClaudeAttachmentContent,
  composePromptText,
  type ClaudeImageBlock,
} from "../promptAttachments.js";

// Claude adapter — drives Claude Code through `@anthropic-ai/claude-agent-sdk`'s
// `query()`. One kone thread = one live `query()` session: prompts are pushed
// into an async queue the SDK consumes, and every SDKMessage the query yields is
// translated into kone's normalized RuntimeEvent union. This mirrors how the
// programmatic surface (raw `claude --output-format stream-json` is only for
// one-shot text generation there, not interactive tool/approval streaming).
//
// "Bring your own subscription": the SDK runs the user's own Claude Code login
// (macOS keychain OAuth / ~/.claude credentials / an external Bedrock-Vertex
// backend). kone never runs `claude login`, never writes or holds a token — see
// claudeHome.ts, which also strips a stray ANTHROPIC_API_KEY from the child env
// so the subscription always wins over a leaked key.
//
// No approval UI in kone v1: `canUseTool` auto-allows every tool call the
// instant it's asked, exactly like CodexAdapter's auto-resolving wireRequests().
// The InteractionMode still sets the SDK permissionMode (default / acceptEdits /
// bypassPermissions) — that's the real safety knob — it just never stops to ask.
//
// Effort is a spawn-time SDK option (`Options.effort`), not a live control, so
// the adapter advertises `sessionModelSwitch: "restart-session"`: changing the
// model or effort restarts the session (ProjectView drives that). The cheap
// live controls the SDK *does* expose — permission mode and fast mode — are
// applied in-place.
//
// "Fast mode" is Claude's low-latency tier. Unlike effort it's a session
// *Setting* (`Settings.fastMode`), so the SDK flips it live mid-session via
// `query.applyFlagSettings({ fastMode })` — no restart. kone surfaces it through
// the same generic "fast" service-tier the composer already renders for Codex:
// a model that reports `supportsFastMode` advertises one synthetic `fast` tier
// (FAST_SERVICE_TIER), and a turn carrying `serviceTier: "fast"` toggles the
// Setting on for the session (see sendTurn). This mirrors shipped research, which
// likewise drives fastMode through applyFlagSettings gated per-model.
//
// Context window is a second live Setting in the same shape. Current Claude
// models are natively 1M (not the legacy `context-1m` beta, which was Sonnet
// 4/4.5-only), so the real per-thread choice is the *auto-compact window* — the
// token budget Claude Code compacts the transcript at. kone offers 200k (a safer
// default) vs the full 1M on every non-Haiku model, carried per-turn as
// `contextWindow` and applied live via applyFlagSettings({ autoCompactWindow })
// — again mirroring research's Claude adapter, no session restart.

const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

// The one speed tier Claude exposes, surfaced as a plain on/off toggle (the
// composer renders any family whose descriptor carries a `fast` serviceTier).
// Only models that report `supportsFastMode` advertise it.
const FAST_SERVICE_TIER = { id: "fast", label: "Fast" };

// The context-window choice kone offers on 1M-capable Claude models. This is the
// *auto-compact window* — the token budget Claude Code compacts the transcript
// at — NOT the raw model capacity, and NOT the legacy `context-1m-2025-08-07`
// beta (that flag was Sonnet-4/4.5-only; every current Claude model is natively
// 1M). Mirrors research's Claude autoCompactWindowOptions: default to a safer 200k
// budget and let a thread opt into the full 1M. `tokens` is the value handed to
// the SDK's `autoCompactWindow` Setting (see sendTurn). Single-window models
// (Haiku, 200k) get no `contextWindows` and so no picker.
const CLAUDE_CONTEXT_WINDOWS = [
  { id: "200k", label: "200K", tokens: 200_000, isDefault: true as const },
  { id: "1m", label: "1M", tokens: 1_000_000 },
];

/** Token budget for a chosen context-window id, or undefined for an unknown id
 *  (which the caller treats as "leave the window at its current setting"). */
function contextWindowTokens(id: string | undefined): number | undefined {
  return CLAUDE_CONTEXT_WINDOWS.find((w) => w.id === id)?.tokens;
}

/** Claude's default auto-compact budget is the safer 200k window. The live
 * setting is only populated when a turn explicitly changes it. */
const DEFAULT_CLAUDE_CONTEXT_WINDOW = contextWindowTokens("200k");

/** Which context-window options a Claude model exposes. Current Claude models
 *  are natively 1M except the Haiku line (200k), so every non-Haiku Claude model
 *  gets the 200k/1M auto-compact choice; a single-window model gets none. The
 *  SDK's live ModelInfo carries no context-window field, so — like research's
 *  static capability table — this is derived from the id. */
function contextWindowsForModel(id: string): typeof CLAUDE_CONTEXT_WINDOWS | undefined {
  return /haiku/i.test(id) ? undefined : CLAUDE_CONTEXT_WINDOWS;
}

// The effort ladders the current Claude line exposes (API-effort levels only —
// ultrathink/ultracode are separate prompt/provider modes kone doesn't surface).
// `full` = the Claude 5 xhigh/max ladder; `extended` = the pre-xhigh generation
// (4.6); `basic` = Opus 4.5's short ladder. Haiku carries no effort axis at all.
const CLAUDE_FULL_EFFORTS: string[] = ["low", "medium", "high", "xhigh", "max"];
const CLAUDE_EXTENDED_EFFORTS: string[] = ["low", "medium", "high", "max"];
const CLAUDE_BASIC_EFFORTS: string[] = ["low", "medium", "high"];

// kone's curated Claude catalog — the hand-maintained ground truth, ported from
// research's static MODEL_OPTIONS_BY_PROVIDER.claudeAgent table (packages/contracts
// model.ts). This is the *base* of the picker: listModels() merges whatever the
// live SDK reports on top of it (see mergeClaudeModels), so older versions the
// SDK no longer advertises still appear, and a brand-new release the SDK knows
// about surfaces even before it's baked here. Each entry mirrors research's
// verified per-model capabilities exactly:
//   • fast mode — only the Opus fast-mode lane (5 / 4.8 / 4.7 / 4.6) advertises
//     the `fast` tier; Fable, Sonnet and Haiku don't.
//   • context window — the 200k/1M auto-compact switch is present on every
//     natively-1M model; Opus 4.5 and Haiku 4.5 are 200k-only, so they get no
//     `contextWindows` and therefore no switch.
//   • reasoning effort — each model's real ladder, defaulting to `high`.
const CURATED_CLAUDE_MODELS: ModelDescriptor[] = [
  { id: "claude-fable-5", label: "Claude Fable 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-5", label: "Claude Opus 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-7", label: "Claude Opus 4.7", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-6", label: "Claude Opus 4.6", reasoningEfforts: CLAUDE_EXTENDED_EFFORTS, defaultReasoningEffort: "high", serviceTiers: [FAST_SERVICE_TIER], contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-opus-4-5", label: "Claude Opus 4.5", reasoningEfforts: CLAUDE_BASIC_EFFORTS, defaultReasoningEffort: "high" },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningEfforts: CLAUDE_FULL_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-sonnet-4-6", label: "Claude Sonnet 4.6", reasoningEfforts: CLAUDE_EXTENDED_EFFORTS, defaultReasoningEffort: "high", contextWindows: CLAUDE_CONTEXT_WINDOWS },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5" },
];

type ClaudeItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
  /** Raw streamed tool input JSON — kept for TaskCreate/TaskUpdate handling. */
  toolInputRaw?: string;
  /** Set for tool_use blocks — the raw tool name, used to shape the summary and
   *  to know the block is still executing after its input finishes streaming. */
  toolName?: string;
};

type ClaudeSession = {
  threadId: string;
  cwd: string;
  model?: string;
  effort?: EffortLevel;
  mode: InteractionMode;
  query: Query;
  prompt: MessageQueue;
  abort: AbortController;
  /** Claude-native session id (from system/init) — for display/resume. */
  sessionId?: string;
  activeTurnId?: string;
  /** Bumped on each message_start so item ids stay unique across a turn. */
  msgOrdinal: number;
  /** The current message's live content blocks, keyed by block index. Cleared
   *  on each message_start. Holds text/thinking/tool-input while they stream. */
  blocks: Map<number, ClaudeItemBuffer>;
  /** Tool items keyed by tool_use_id, so a tool_result arriving in a later
   *  `user` message can find and complete the right item after the block map
   *  has already rolled over. */
  toolItems: Map<string, ClaudeItemBuffer>;
  consumer: Promise<void>;
  /** True once we're tearing this session down on purpose (stopSession) — the
   *  consumer's finally then skips the "unexpected exit" event. */
  disposed: boolean;
  /** True between interruptTurn() and the result that lands from it, so the
   *  result is reported as `interrupted` rather than `failed`. */
  interrupting: boolean;
  /** Whether Claude's low-latency "fast mode" Setting is currently on for this
   *  session. Toggled live in sendTurn via applyFlagSettings when a turn's
   *  requested `fast` service tier differs from this. */
  fastMode: boolean;
  /** The auto-compact window (in tokens) currently applied to this session, or
   *  undefined while it's still at the CLI's default. Toggled live in sendTurn
   *  via applyFlagSettings when a turn's requested context window differs — the
   *  Claude analogue of a per-thread context-window size, no restart needed. */
  autoCompactWindow?: number;
  /** Claude Code TaskCreate/TaskUpdate checklist for the active turn. */
  trackedTasks: Map<string, ClaudeTrackedTask>;
  /** Whether a synthesized `${turnId}:plan` item has been started this turn. */
  taskPlanStarted: boolean;
  /** In-flight AskUserQuestion round-trips, keyed by our requestId. Each holds
   *  the resolver the parked `canUseTool` promise is awaiting — settled by
   *  respondToUserInput (the user answered) or drained on interrupt/stop. */
  pendingUserInputs: Map<string, PendingUserInput>;
};

/** A parked AskUserQuestion: the questions we emitted and the resolver that
 *  unblocks canUseTool once the renderer answers (or we drain on teardown). */
type PendingUserInput = {
  questions: UserInputQuestion[];
  resolve: (answers: UserInputAnswers) => void;
};

// ── small JSON helpers (defensive, like CodexAdapter) ────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  return typeof cursor === "string" ? cursor : undefined;
}

function readNumber(value: unknown, ...path: string[]): number | undefined {
  let cursor: unknown = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  return typeof cursor === "number" ? cursor : undefined;
}

/** Normalize the SDK's `AskUserQuestion` tool input into kone's neutral
 *  UserInputQuestion[]. Claude's shape is `{ questions: [{ question, header,
 *  multiSelect?, options: [{ label, description? }] }] }`; options may also
 *  arrive as bare strings. The id is set to the question TEXT because the SDK
 *  keys answers by text when mapping the tool result. */
function parseAskUserQuestions(input: unknown): UserInputQuestion[] {
  const rawQuestions = asRecord(input)?.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const out: UserInputQuestion[] = [];
  for (const raw of rawQuestions) {
    const record = asRecord(raw);
    const question = readString(record, "question")?.trim();
    if (!question) continue;
    const header = readString(record, "header")?.trim() || "Question";

    const options: UserInputQuestionOption[] = [];
    const rawOptions = Array.isArray(record?.options) ? record!.options : [];
    for (const rawOption of rawOptions) {
      if (typeof rawOption === "string") {
        const label = rawOption.trim();
        if (label) options.push({ label });
        continue;
      }
      const optionRecord = asRecord(rawOption);
      const label = readString(optionRecord, "label")?.trim();
      if (!label) continue;
      const description = readString(optionRecord, "description")?.trim();
      options.push(description ? { label, description } : { label });
    }

    out.push({
      id: question,
      header,
      question,
      options,
      multiSelect: record?.multiSelect === true,
    });
  }
  return out;
}

function normalizeEffort(value: string | undefined): EffortLevel | undefined {
  return value && EFFORT_LEVELS.has(value as EffortLevel) ? (value as EffortLevel) : undefined;
}

/** kone's InteractionMode → the SDK's spawn-time permission mode. `ask` maps to
 *  `default` (canUseTool is consulted — and auto-allows in v1); `accept-edits`
 *  to `acceptEdits`; `full-access` to `bypassPermissions`. */
function toPermissionMode(mode: InteractionMode): PermissionMode {
  switch (mode) {
    case "ask":
      return "default";
    case "full-access":
      return "bypassPermissions";
    case "accept-edits":
    default:
      return "acceptEdits";
  }
}

/** A short inline summary for a tool call, dug out of its (parsed) input — the
 *  command run, the file touched, the query searched — mirroring Codex's
 *  itemDetail(). Everything else becomes the expandable body. */
function summarizeToolInput(toolName: string | undefined, rawInput: string): { text: string; detail: string } {
  let parsed: Record<string, unknown> | undefined;
  try {
    parsed = asRecord(JSON.parse(rawInput));
  } catch {
    parsed = undefined;
  }
  if (!parsed) return { text: "", detail: rawInput.trim() };

  const target = [
    parsed.command,
    parsed.file_path,
    parsed.path,
    parsed.pattern,
    parsed.query,
    parsed.url,
    parsed.description,
    parsed.prompt,
  ].find((v) => typeof v === "string" && v.trim().length > 0) as string | undefined;

  const detail = JSON.stringify(parsed, null, 2);
  return { text: target?.trim() ?? toolName ?? "", detail };
}

// The empty placeholder a streaming tool_use carries before its input_json_delta
// chunks arrive — an empty object (or empty string). Seeding a buffer with it
// then appending deltas would produce unparseable JSON, so we skip it.
function isEmptyToolInput(input: unknown): boolean {
  if (typeof input === "string") return input.trim().length === 0;
  if (typeof input === "object" && input !== null && !Array.isArray(input)) {
    return Object.keys(input).length === 0;
  }
  return false;
}

// Claude's file-mutating tools — the ones whose `tool_use_result` carries a
// structured diff we can surface. Kept lowercase for name-agnostic matching.
const FILE_EDIT_TOOLS = new Set(["edit", "write", "multiedit", "notebookedit"]);

function isClaudeFileEditTool(toolName: string | undefined): boolean {
  return !!toolName && FILE_EDIT_TOOLS.has(toolName.trim().toLowerCase());
}

/** Rebuild a unified-diff body from a file tool's structured `tool_use_result`.
 *  Edit/Write/MultiEdit return a `structuredPatch` (hunks of `+`/`-`/context
 *  lines); joining every hunk's lines gives the thread — and the Changes dock's
 *  +/− counts — a real diff, matching what CodexAdapter already emits as `diff`.
 *  Returns undefined when there's no patch (falls back to the result text). */
function fileEditDiffBody(structuredResult: unknown): string | undefined {
  const record = asRecord(structuredResult);
  if (!record) return undefined;

  const patch = record.structuredPatch;
  if (Array.isArray(patch) && patch.length > 0) {
    const lines: string[] = [];
    for (const hunk of patch) {
      const hunkLines = asRecord(hunk)?.lines;
      if (!Array.isArray(hunkLines)) continue;
      for (const line of hunkLines) if (typeof line === "string") lines.push(line);
    }
    if (lines.length > 0) return lines.join("\n");
  }

  // A brand-new file write has no prior version to diff against, so there's no
  // patch — treat the whole written content as additions so the dock shows +N.
  if (record.originalFile == null && typeof record.content === "string" && record.content.length > 0) {
    return record.content
      .replace(/\n$/, "")
      .split("\n")
      .map((line) => `+${line}`)
      .join("\n");
  }
  return undefined;
}

/** Apply a TodoWrite snapshot to a plan_text buffer when JSON parsing succeeds. */
function applyPlanSnapshot(buffer: ClaudeItemBuffer, rawJson: string): boolean {
  const snapshot = parseTodoWriteInput(rawJson);
  if (!snapshot) return false;
  buffer.tasks = reconcilePlanTasks(buffer.tasks ?? [], snapshot);
  buffer.text = formatPlanTasks(buffer.tasks);
  return true;
}

/** Pull display text out of a tool_result's `content` (string, or an array of
 *  content blocks). */
function extractToolResultText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((block) => readString(block, "text") ?? "")
      .filter((v) => v.length > 0)
      .join("\n");
  }
  return "";
}

// ── prompt queue ──────────────────────────────────────────────────────────────
// The SDK's `prompt` is an async iterable it pulls from; we feed it one
// SDKUserMessage per turn. A pull that outruns the pushes parks until the next
// prompt (or close) arrives.

class MessageQueue {
  private readonly items: SDKUserMessage[] = [];
  private readonly waiters: ((result: IteratorResult<SDKUserMessage>) => void)[] = [];
  private closed = false;

  push(message: SDKUserMessage): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter) waiter({ value: message, done: false });
    else this.items.push(message);
  }

  close(): void {
    this.closed = true;
    let waiter: ((result: IteratorResult<SDKUserMessage>) => void) | undefined;
    while ((waiter = this.waiters.shift())) waiter({ value: undefined as never, done: true });
  }

  iterable(): AsyncIterable<SDKUserMessage> {
    const self = this;
    return {
      [Symbol.asyncIterator]() {
        return {
          next(): Promise<IteratorResult<SDKUserMessage>> {
            if (self.items.length > 0) return Promise.resolve({ value: self.items.shift()!, done: false });
            if (self.closed) return Promise.resolve({ value: undefined as never, done: true });
            return new Promise((resolve) => self.waiters.push(resolve));
          },
        };
      },
    };
  }
}

/** A prompt iterable that yields nothing and only completes when `signal`
 *  aborts — used for the throwaway discovery/model-list probe, which needs the
 *  session to initialize but must never run a turn. */
function idlePrompt(signal: AbortSignal): AsyncIterable<SDKUserMessage> {
  return {
    [Symbol.asyncIterator]() {
      return {
        next(): Promise<IteratorResult<SDKUserMessage>> {
          return new Promise((resolve) => {
            if (signal.aborted) return resolve({ value: undefined as never, done: true });
            signal.addEventListener("abort", () => resolve({ value: undefined as never, done: true }), { once: true });
          });
        },
      };
    },
  };
}

export class ClaudeAdapter implements ProviderAdapter {
  readonly provider = "claudeAgent" as const;
  readonly capabilities: AdapterCapabilities = {
    // Model + effort are baked when the SDK subprocess spawns, so a change
    // restarts the session (ProjectView handles that). Permission mode is the
    // one thing switched live, in sendTurn.
    sessionModelSwitch: "restart-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, ClaudeSession>();
  /** One throwaway `initializationResult()` probe, cached — it returns both the
   *  account (for discover) and the model list (for listModels). Only successes
   *  are cached; a failed probe is retried next call (auth may have changed). */
  private initCache: Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> | null = null;

  constructor(emit: EmitEvent) {
    this.emit = emit;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const [init, version] = await Promise.all([this.probeInit(), this.probeVersion()]);

    if (!init) {
      // The SDK ships its own CLI, so "installed" isn't the failure mode here —
      // an un-initializable session almost always means no login.
      return {
        provider: this.provider,
        label: "Claude",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `claude login` to sign in to Claude Code.",
      };
    }

    const auth = summarizeClaudeAccount(init.account);
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Claude",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `claude login` to sign in to Claude Code.",
      };
    }

    return {
      provider: this.provider,
      label: "Claude",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    const init = await this.probeInit();
    const discovered = init ? mapClaudeModels(init.models) : [];
    return mergeClaudeModels(CURATED_CLAUDE_MODELS, discovered);
  }

  /** Best-effort installed-CLI version, for the status row only. */
  private async probeVersion(): Promise<string | undefined> {
    const env = await buildAgentEnv();
    const output = await probe("claude", ["--version"], env, 5_000);
    return output ? parseClaudeCliVersion(output) : undefined;
  }

  private probeInit(): Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> {
    if (!this.initCache) {
      this.initCache = this.runInitProbe().then((result) => {
        if (!result) this.initCache = null; // don't cache a failure
        return result;
      });
    }
    return this.initCache;
  }

  /** Spawn a throwaway session that never runs a turn, read its init handshake
   *  (account + model list), then abort it. This is the Claude analogue of
   *  CodexAdapter's short-lived app-server spawn for model/list. */
  private async runInitProbe(): Promise<{ account?: AccountInfo; models: ModelInfo[] } | null> {
    const controller = new AbortController();
    try {
      const env = await buildClaudeEnv();
      const executable = resolveClaudeExecutable();
      const q = query({
        prompt: idlePrompt(controller.signal),
        options: {
          cwd: homedir(),
          env: env as Record<string, string | undefined>,
          abortController: controller,
          // Plan mode + a deny-all callback guarantee no tool ever executes even
          // if a turn somehow started; the idle prompt means none will.
          permissionMode: "plan",
          canUseTool: async () => ({ behavior: "deny", message: "kone discovery probe" }),
          settingSources: [],
          includePartialMessages: false,
          systemPrompt: { type: "preset", preset: "claude_code" },
          ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
        },
      });
      const init = await q.initializationResult();
      return { account: init.account, models: init.models };
    } catch (error) {
      // A failed probe is reported to the user as the generic "Needs sign-in",
      // which is indistinguishable from a real logged-out state. Log the actual
      // reason so a spawn/auth failure in a packaged build is diagnosable.
      console.error("[kone] Claude discovery probe failed:", error);
      return null;
    } finally {
      controller.abort();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    const env = await buildClaudeEnv();
    const executable = resolveClaudeExecutable();
    const mode: InteractionMode = input.mode ?? "accept-edits";
    const effort = normalizeEffort(input.effort);
    const abort = new AbortController();
    const prompt = new MessageQueue();

    const permissionMode = toPermissionMode(mode);
    const options: ClaudeQueryOptions = {
      cwd: input.cwd,
      additionalDirectories: [input.cwd],
      env: env as Record<string, string | undefined>,
      abortController: abort,
      ...(input.model ? { model: input.model } : {}),
      ...(effort ? { effort } : {}),
      // Resume a prior Claude Code conversation by its session id so the new
      // query continues with its full transcript/context (the SDK's supported
      // resume surface — mirrors research's ClaudeAdapter). The resumed
      // run reports its own session id via system/init, which refreshes the
      // stored conversationId on the next turn.completed.
      ...(input.resume ? { resume: input.resume } : {}),
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      // Session-bound so the callback knows which thread asked — a shared arrow
      // can't tell sessions apart. Only `AskUserQuestion` parks for a real
      // answer; every other tool auto-allows (see canUseTool below).
      canUseTool: (toolName, toolInput, opts) => this.canUseTool(session, toolName, toolInput, opts),
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
    };

    const q = query({ prompt: prompt.iterable(), options });
    const session: ClaudeSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      effort,
      mode,
      query: q,
      prompt,
      abort,
      msgOrdinal: 0,
      blocks: new Map(),
      toolItems: new Map(),
      consumer: Promise.resolve(),
      disposed: false,
      interrupting: false,
      fastMode: false,
      trackedTasks: new Map(),
      taskPlanStarted: false,
      pendingUserInputs: new Map(),
    };
    session.consumer = this.consume(session);

    try {
      // Resolves once the CLI subprocess has initialized — our request/ack point.
      await q.initializationResult();
    } catch (error) {
      abort.abort();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.started" });
    return this.toSession(session);
  }

  /** kone's permission callback. Every tool but `AskUserQuestion` auto-allows
   *  unchanged (there's no approval UI in v1 — see the file header). The
   *  `AskUserQuestion` built-in is special: it's how Claude asks the user a
   *  multiple-choice / free-text question mid-turn, so we park it for a real
   *  answer from the renderer instead of allowing it to resolve empty. Under
   *  `bypassPermissions` the SDK never calls this at all. */
  private canUseTool(
    session: ClaudeSession,
    toolName: string,
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") {
      return this.askUserQuestion(session, input, options);
    }
    return Promise.resolve({ behavior: "allow", updatedInput: input });
  }

  /** Park an AskUserQuestion round-trip: parse the questions, emit
   *  `user-input.requested`, and await the renderer's answer. The SDK keys
   *  answers by the question TEXT, so our UserInputQuestion.id === the question
   *  text and the resolved answers map passes straight back as `updatedInput`.
   *  If the turn is interrupted (abort signal) or torn down, the parked promise
   *  resolves empty and we deny so the SDK stops waiting. */
  private async askUserQuestion(
    session: ClaudeSession,
    input: Parameters<CanUseTool>[1],
    options: Parameters<CanUseTool>[2],
  ): Promise<PermissionResult> {
    const questions = parseAskUserQuestions(input);
    if (questions.length === 0) {
      // Nothing coherent to ask — let the SDK proceed unchanged.
      return { behavior: "allow", updatedInput: input };
    }

    const requestId = randomUUID();
    const answers = await new Promise<UserInputAnswers>((resolve) => {
      session.pendingUserInputs.set(requestId, { questions, resolve });
      this.emit({
        ...this.base(session),
        type: "user-input.requested",
        requestId,
        turnId: session.activeTurnId,
        questions,
      });
      // Unblock if the turn aborts mid-question so the query can settle.
      const signal = options?.signal;
      if (signal) {
        if (signal.aborted) this.resolveUserInput(session, requestId, {});
        else signal.addEventListener("abort", () => this.resolveUserInput(session, requestId, {}), { once: true });
      }
    });

    this.emit({ ...this.base(session), type: "user-input.resolved", requestId, answers });

    const answered = Object.values(answers).some((value) =>
      Array.isArray(value) ? value.length > 0 : typeof value === "string" && value.length > 0,
    );
    if (!answered) {
      return { behavior: "deny", message: "The user dismissed the question without answering." };
    }
    return { behavior: "allow", updatedInput: { ...(input as Record<string, unknown>), answers } };
  }

  /** Settle one parked AskUserQuestion (idempotent — a no-op once drained). */
  private resolveUserInput(session: ClaudeSession, requestId: string, answers: UserInputAnswers): void {
    const pending = session.pendingUserInputs.get(requestId);
    if (!pending) return;
    session.pendingUserInputs.delete(requestId);
    pending.resolve(answers);
  }

  /** Resolve every parked question empty — on interrupt/stop so no canUseTool
   *  promise leaks and the renderer's pending prompt clears. */
  private drainUserInputs(session: ClaudeSession): void {
    for (const [requestId] of [...session.pendingUserInputs]) {
      this.resolveUserInput(session, requestId, {});
    }
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);

    const text = input.input.trim();

    // Build the user message's content up front (reads any attachment bytes off
    // disk): the prompt text — with non-image / unsupported-image files folded
    // in as an <attached_files> path block — plus native image blocks for
    // gif/jpeg/png/webp. An attachment-only turn is valid; we just skip text.
    const { imageBlocks, fileBlock } = await buildClaudeAttachmentContent(input.attachments);
    const promptText = composePromptText(text, fileBlock);
    const content: Array<{ type: "text"; text: string } | ClaudeImageBlock> = [];
    if (promptText.length > 0) content.push({ type: "text", text: promptText });
    content.push(...imageBlocks);
    if (content.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }

    // Permission mode is the one selection the SDK lets us change live; model
    // and effort are spawn-fixed and change via a session restart instead.
    const mode = input.mode ?? session.mode;
    if (mode !== session.mode) {
      await session.query.setPermissionMode(toPermissionMode(mode));
      session.mode = mode;
    }

    // Fast mode is a live session Setting — flip it in place when the turn's
    // requested `fast` service tier differs from the session's current state.
    // This is the Claude analogue of CodexAdapter honoring `serviceTier`, but
    // the SDK carries it as a persistent per-session Setting it toggles via
    // applyFlagSettings rather than a per-turn flag. The composer only sends
    // `fast` for models that advertise it, so no per-model gate is needed here.
    const wantsFast = input.serviceTier === FAST_SERVICE_TIER.id;
    if (wantsFast !== session.fastMode) {
      try {
        await session.query.applyFlagSettings({ fastMode: wantsFast ? true : null });
        session.fastMode = wantsFast;
      } catch {
        // The Setting can be refused (model doesn't support fast mode, or it's
        // on cooldown / disabled upstream) — leave state as-is; a later turn
        // retries. The turn itself still runs, just at the standard tier.
      }
    }

    // Context window is the other live session Setting: the auto-compact budget
    // Claude Code compacts the transcript at. Like fast mode it's carried as a
    // persistent per-session Setting toggled via applyFlagSettings (research's
    // Claude adapter drives it exactly this way). The composer only sends a
    // contextWindow for models that advertise the choice, and an unknown id
    // resolves to undefined here — meaning "leave the window where it is".
    const wantWindow = contextWindowTokens(input.contextWindow);
    if (wantWindow !== undefined && wantWindow !== session.autoCompactWindow) {
      try {
        await session.query.applyFlagSettings({ autoCompactWindow: wantWindow });
        session.autoCompactWindow = wantWindow;
      } catch {
        // Refused (window unsupported, or auto-compact disabled upstream) —
        // leave state as-is; the turn still runs at the current window.
      }
    }

    // Globally-unique turn id (a UUID, matching Codex's app-server ids and both
    // collides across threads in the shared store. See assistantBlockId.
    const turnId = randomUUID();
    session.activeTurnId = turnId;
    session.msgOrdinal = 0;
    session.blocks.clear();
    session.toolItems.clear();
    session.trackedTasks.clear();
    session.taskPlanStarted = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    const userMessage: SDKUserMessage = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content },
    };
    session.prompt.push(userMessage);

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId) return;
    session.interrupting = true;
    // Unblock any parked AskUserQuestion so the interrupt can land cleanly.
    this.drainUserInputs(session);
    try {
      await session.query.interrupt();
    } catch {
      // The query may already be settling; the result event still lands.
    }
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    session.disposed = true;
    this.drainUserInputs(session);
    session.prompt.close();
    session.abort.abort();
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.disposed = true;
      this.drainUserInputs(session);
      session.prompt.close();
      session.abort.abort();
    }
    this.sessions.clear();
  }

  async respondToRequest(_threadId: string, _requestId: string, _decision: ApprovalDecision): Promise<void> {
    // No-op — non-question tools auto-allow inline; nothing is left pending for
    // the UI to approve (matches CodexAdapter). Questions use respondToUserInput.
  }

  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveUserInput(session, requestId, answers);
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((s) => this.toSession(s));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── message stream → RuntimeEvents ─────────────────────────────────────────

  private async consume(session: ClaudeSession): Promise<void> {
    try {
      for await (const message of session.query) {
        this.handleMessage(session, message);
      }
    } catch (error) {
      if (!session.disposed) {
        this.emit({
          ...this.base(session, "claude.sdk.lifecycle"),
          type: "session.state.changed",
          state: "error",
          message: error instanceof Error ? error.message : String(error),
        });
      }
    } finally {
      if (this.sessions.get(session.threadId) === session) this.sessions.delete(session.threadId);
      if (!session.disposed) {
        this.emit({ ...this.base(session, "claude.sdk.lifecycle"), type: "session.exited", code: null });
      }
    }
  }

  private handleMessage(session: ClaudeSession, message: SDKMessage): void {
    switch (message.type) {
      case "system":
        if (message.subtype === "init") {
          session.sessionId = message.session_id;
          if (!session.model) session.model = message.model;
        }
        return;
      case "stream_event":
        this.handleStreamEvent(session, message.event);
        return;
      case "user":
        this.handleToolResults(session, message);
        return;
      case "result":
        this.handleResult(session, message);
        return;
      default:
        // assistant/status/tool_progress/etc. — the stream_event deltas above
        // are authoritative for rendering, so we don't double-handle them.
        return;
    }
  }

  private handleStreamEvent(session: ClaudeSession, rawEvent: unknown): void {
    const event = asRecord(rawEvent);
    const type = readString(event, "type");
    if (!event || !type) return;

    if (type === "message_start") {
      session.msgOrdinal += 1;
      session.blocks.clear();
      return;
    }

    if (type === "content_block_start") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const block = asRecord(event.content_block);
      const blockType = readString(block, "type");
      const itemId = `${session.activeTurnId ?? "turn"}:${session.msgOrdinal}:${index}`;

      if (blockType === "text") {
        this.beginBlock(session, index, { itemId, kind: "assistant_text", text: "", detail: "" });
      } else if (blockType === "thinking" || blockType === "redacted_thinking") {
        this.beginBlock(session, index, { itemId, kind: "reasoning_text", text: "", detail: "" });
      } else if (blockType === "tool_use") {
        const toolName = readString(block, "name");
        const toolUseId = readString(block, "id");
        const isPlan = toolName?.toLowerCase() === "todowrite";
        const buffer: ClaudeItemBuffer = {
          itemId,
          kind: isPlan ? "plan_text" : "tool_call",
          name: isPlan ? undefined : toolName,
          text: "",
          detail: "",
          toolName,
        };
        // A streaming tool_use opens with an empty `{}` (or "") placeholder and
        // fills its input in via input_json_delta; seeding detail with that
        // placeholder would corrupt the concatenated JSON ("{}" + "{...}" =
        // unparseable), leaving the tool with no target. Only seed when the
        // start block already carries real input (the non-streaming case).
        const blockInput = block?.input;
        if (blockInput !== undefined && blockInput !== null && !isEmptyToolInput(blockInput)) {
          const raw =
            typeof blockInput === "string" ? blockInput : JSON.stringify(blockInput);
          buffer.detail = raw;
          buffer.toolInputRaw = raw;
        }
        session.blocks.set(index, buffer);
        if (toolUseId) session.toolItems.set(toolUseId, buffer);
        this.emitItem(session, "item.started", buffer, "in-progress");
      }
      return;
    }

    if (type === "content_block_delta") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const buffer = session.blocks.get(index);
      if (!buffer) return;
      const delta = asRecord(event.delta);
      const deltaType = readString(delta, "type");
      if (deltaType === "text_delta") buffer.text += readString(delta, "text") ?? "";
      else if (deltaType === "thinking_delta") buffer.text += readString(delta, "thinking") ?? "";
      else if (deltaType === "input_json_delta") {
        buffer.detail += readString(delta, "partial_json") ?? "";
        if (buffer.kind === "plan_text") applyPlanSnapshot(buffer, buffer.detail);
      } else return;
      this.emitItem(session, "item.updated", buffer, "in-progress");
      return;
    }

    if (type === "content_block_stop") {
      const index = readNumber(event, "index");
      if (index === undefined) return;
      const buffer = session.blocks.get(index);
      if (!buffer) return;
      session.blocks.delete(index);

      if (buffer.kind === "plan_text") {
        applyPlanSnapshot(buffer, buffer.detail);
        buffer.detail = "";
        this.emitItem(session, "item.completed", buffer, "completed");
      } else if (buffer.kind === "tool_call") {
        // Input finished streaming — summarize it, but the tool is now running:
        // stays in-progress until its tool_result lands in a later user message.
        buffer.toolInputRaw = buffer.detail;
        const { text, detail } = summarizeToolInput(buffer.toolName, buffer.detail);
        buffer.text = text;
        buffer.detail = detail;
        this.emitItem(session, "item.updated", buffer, "in-progress");
      } else {
        this.emitItem(session, "item.completed", buffer, "completed");
      }
      return;
    }
  }

  private beginBlock(session: ClaudeSession, index: number, buffer: ClaudeItemBuffer): void {
    session.blocks.set(index, buffer);
    this.emitItem(session, "item.started", buffer, "in-progress");
  }

  /** Complete tool_call items when their result arrives in a `user` message. */
  private handleToolResults(session: ClaudeSession, message: Extract<SDKMessage, { type: "user" }>): void {
    const structuredResult = (message as { tool_use_result?: unknown }).tool_use_result;
    const content = asRecord(message.message)?.content;
    const blocks = Array.isArray(content) ? content : [];
    let handledTaskTool = false;

    for (const rawBlock of blocks) {
      const block = asRecord(rawBlock);
      if (readString(block, "type") !== "tool_result") continue;
      const toolUseId = readString(block, "tool_use_id");
      if (!toolUseId) continue;
      const buffer = session.toolItems.get(toolUseId);
      if (!buffer) continue;
      const failed = block?.is_error === true;

      if (
        this.applyTaskToolResult(session, buffer, block ?? {}, structuredResult, failed)
      ) {
        handledTaskTool = true;
      }

      session.toolItems.delete(toolUseId);
      const resultText = extractToolResultText(block?.content).trim();
      // Prefer the structured diff for file edits so the thread and the Changes
      // dock see real +/− lines; fall back to the plain result text otherwise.
      const diffBody = isClaudeFileEditTool(buffer.toolName)
        ? fileEditDiffBody(structuredResult)
        : undefined;
      if (diffBody) buffer.detail = diffBody;
      else if (resultText.length > 0) buffer.detail = resultText;
      this.emitItem(session, "item.completed", buffer, failed ? "failed" : "completed");
    }

    // Some SDK user messages carry structured output on the envelope instead of
    // (or in addition to) parseable tool_result text — TaskCreate's `{ task }`
    // object lives here.
    if (!handledTaskTool && structuredResult !== undefined && message.parent_tool_use_id) {
      const buffer = session.toolItems.get(message.parent_tool_use_id);
      if (buffer && isClaudeTaskTool(buffer.toolName)) {
        if (
          this.applyTaskToolResult(session, buffer, {}, structuredResult, false)
        ) {
          session.toolItems.delete(message.parent_tool_use_id);
          this.emitItem(session, "item.completed", buffer, "completed");
        }
      }
    }
  }

  private applyTaskToolResult(
    session: ClaudeSession,
    buffer: ClaudeItemBuffer,
    resultBlock: Record<string, unknown>,
    structuredResult: unknown,
    isError: boolean,
  ): boolean {
    if (!isClaudeTaskTool(buffer.toolName)) return false;

    const toolInput = this.parseToolInputRaw(buffer.toolInputRaw ?? buffer.detail);
    if (
      applyClaudeTaskToolResult(
        session.trackedTasks,
        { toolName: buffer.toolName!, input: toolInput },
        resultBlock,
        structuredResult,
        isError,
      )
    ) {
      this.emitTaskPlan(session);
      return true;
    }
    return false;
  }

  private parseToolInputRaw(raw: string): Record<string, unknown> {
    if (!raw.trim()) return {};
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null) return parsed as Record<string, unknown>;
    } catch {
      /* malformed */
    }
    return {};
  }

  private handleResult(session: ClaudeSession, message: Extract<SDKMessage, { type: "result" }>): void {
    const usage = asRecord((message as Record<string, unknown>).usage);
    if (usage) {
      // The Anthropic usage object splits prompt tokens across three fields:
      // `input_tokens` is ONLY the fresh, uncached bytes; the bulk of an
      // agentic turn's prompt is re-read from the cache and lands in
      // `cache_read_input_tokens` (plus `cache_creation_input_tokens` when a
      // new prefix is written). Reading `input_tokens` alone dropped the
      // cached reads — which dominate — so Claude threads reported a tiny
      // fraction of their real spend. Fold all three in, matching Codex (whose
      // total already counts re-sent context) and research's canonical formula.
      const freshInput = readNumber(usage, "input_tokens");
      const cacheRead = readNumber(usage, "cache_read_input_tokens");
      const cacheCreation = readNumber(usage, "cache_creation_input_tokens");
      const output = readNumber(usage, "output_tokens");
      const hasInput =
        freshInput !== undefined || cacheRead !== undefined || cacheCreation !== undefined;
      const input = hasInput
        ? (freshInput ?? 0) + (cacheRead ?? 0) + (cacheCreation ?? 0)
        : undefined;
      const total = hasInput || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined;
      const contextWindow = session.autoCompactWindow ?? DEFAULT_CLAUDE_CONTEXT_WINDOW;
      const contextUsed =
        total !== undefined && contextWindow !== undefined
          ? Math.min(total, contextWindow)
          : total;
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: {
          input,
          output,
          total,
          ...(contextUsed !== undefined ? { contextUsed } : {}),
          ...(contextWindow !== undefined ? { contextWindow, compactsAutomatically: true } : {}),
        },
      });
    }

    const turnId = session.activeTurnId;
    if (turnId) this.completeTaskPlan(session, turnId);
    session.activeTurnId = undefined;
    if (!turnId) return;

    const interrupting = session.interrupting;
    session.interrupting = false;

    if (message.subtype === "success" && !message.is_error) {
      this.emit({
        ...this.base(session),
        type: "turn.completed",
        turnId,
        conversationId: session.sessionId,
      });
      return;
    }

    const errors = "errors" in message && Array.isArray(message.errors) ? message.errors : [];
    const reason = interrupting || isInterruptedResult(message, errors) ? "interrupted" : "failed";
    const detail = errors.join("; ") || readString(message, "result");
    this.emit({
      ...this.base(session),
      type: "turn.aborted",
      turnId,
      reason,
      ...(detail ? { message: detail } : {}),
    });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private emitTaskPlan(session: ClaudeSession): void {
    const turnId = session.activeTurnId;
    if (!turnId || session.trackedTasks.size === 0) return;

    const tasks = planTasksFromClaudeTracked(session.trackedTasks);
    const buffer: ClaudeItemBuffer = {
      itemId: `${turnId}:plan`,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    const type = session.taskPlanStarted ? "item.updated" : "item.started";
    session.taskPlanStarted = true;
    this.emitItem(session, type, buffer, "in-progress");
  }

  private completeTaskPlan(session: ClaudeSession, turnId: string): void {
    if (!session.taskPlanStarted || session.trackedTasks.size === 0) {
      session.taskPlanStarted = false;
      session.trackedTasks.clear();
      return;
    }
    const tasks = planTasksFromClaudeTracked(session.trackedTasks);
    const buffer: ClaudeItemBuffer = {
      itemId: `${turnId}:plan`,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    this.emitItem(session, "item.completed", buffer, "completed");
    session.taskPlanStarted = false;
    session.trackedTasks.clear();
  }

  private emitItem(
    session: ClaudeSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: ClaudeItemBuffer,
    status: RuntimeItemStatus,
  ): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    const item: RuntimeItem = {
      itemId: buffer.itemId,
      kind: buffer.kind,
      status,
      text: buffer.text,
      ...(buffer.tasks?.length ? { tasks: buffer.tasks } : {}),
      ...(buffer.name ? { name: buffer.name } : {}),
      ...(buffer.detail.length > 0 ? { detail: buffer.detail } : {}),
    };
    this.emit({ ...this.base(session), type, turnId, item });
  }

  private base(session: ClaudeSession, source: "claude.sdk.message" | "claude.sdk.lifecycle" = "claude.sdk.message") {
    return {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source,
    };
  }

  private toSession(session: ClaudeSession): Session {
    return {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.sessionId,
      activeTurnId: session.activeTurnId,
      model: session.model,
      mode: session.mode,
    };
  }

  private requireSession(threadId: string): ClaudeSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Claude session for thread ${threadId}`);
    return session;
  }
}

/** A Claude turn `result` is an interruption (not a hard failure) when the CLI
function isInterruptedResult(
  message: Extract<SDKMessage, { type: "result" }>,
  errors: string[],
): boolean {
  if (message.subtype === "error_during_execution" && message.is_error === false) return true;
  const haystack = errors.join(" ").toLowerCase();
  return ["interrupt", "aborted", "request was aborted"].some((needle) => haystack.includes(needle));
}

/** Map the SDK's live ModelInfo list to kone's ModelDescriptor, preferring the
 *  canonical `claude-*` id, deduping alias rows, and carrying each model's real
 *  effort ladder. Skips the `default` alias so the model it resolves to keeps
 *  its own name (e.g. "Sonnet") rather than the generic "Default (recommended)". */
function mapClaudeModels(models: ModelInfo[]): ModelDescriptor[] {
  const seen = new Set<string>();
  const out: ModelDescriptor[] = [];
  for (const model of models) {
    if (model.value === "default") continue;
    const id = model.resolvedModel ?? model.value;
    if (!id || !id.startsWith("claude") || seen.has(id)) continue;
    seen.add(id);
    const efforts = model.supportsEffort && model.supportedEffortLevels?.length ? [...model.supportedEffortLevels] : undefined;
    out.push({
      id,
      label: model.displayName || id,
      ...(efforts ? { reasoningEfforts: efforts } : {}),
      // The SDK's model list is authoritative for fast-mode support — surface it
      // as the generic `fast` service tier the composer's toggle keys off.
      ...(model.supportsFastMode ? { serviceTiers: [FAST_SERVICE_TIER] } : {}),
      // ModelInfo carries no context-window field, so the 200k/1m auto-compact
      // choice is derived from the id (every current non-Haiku Claude is 1M).
      ...(contextWindowsForModel(id) ? { contextWindows: contextWindowsForModel(id) } : {}),
    });
  }
  return out;
}

/** Merge kone's curated Claude catalog with whatever the live SDK reports.
 *  Mirrors research's mergeDynamicModelOptions (static table + dynamic discovery):
 *  the curated list is authoritative for capability *shape* — the fast-mode lane
 *  and, crucially, the 200k-only vs 200k/1M auto-compact switch, which the SDK's
 *  ModelInfo simply can't express — so a model the curated list already knows
 *  keeps its verified toggles rather than the id-derived guesses mapClaudeModels
 *  would make. The SDK only contributes genuinely *new* ids (a release we haven't
 *  baked yet), surfaced at the top so the latest model is reachable immediately.
 *  Curated entries always show, so older versions the SDK dropped don't vanish. */
function mergeClaudeModels(
  curated: ModelDescriptor[],
  discovered: ModelDescriptor[],
): ModelDescriptor[] {
  const curatedIds = new Set(curated.map((m) => m.id));
  const fresh = discovered.filter((m) => !curatedIds.has(m.id));
  return [...fresh, ...curated];
}
