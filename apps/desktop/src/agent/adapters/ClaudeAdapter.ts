import { homedir } from "node:os";

import {
  query,
  type AccountInfo,
  type CanUseTool,
  type EffortLevel,
  type ModelInfo,
  type Options as ClaudeQueryOptions,
  type PermissionMode,
  type Query,
  type SDKMessage,
  type SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { buildClaudeEnv, parseClaudeCliVersion, summarizeClaudeAccount } from "../claudeHome.js";
import { buildAgentEnv } from "../processEnv.js";
import { probe } from "../spawn.js";
import type {
  AdapterCapabilities,
  ApprovalDecision,
  EmitEvent,
  InteractionMode,
  ModelDescriptor,
  ProviderAdapter,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeItemStatus,
  Session,
  SendTurnInput,
  SessionStartInput,
  TurnStartResult,
} from "../types.js";

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
// live controls the SDK *does* expose — permission mode — are applied in-place.

const EFFORT_LEVELS = new Set<EffortLevel>(["low", "medium", "high", "xhigh", "max"]);

// Baked catalog used only when the SDK's live model list can't be read (e.g. no
// login yet). The live list from initializationResult() is preferred — this is
// just so the picker is never empty. Ids/efforts track the current Claude line.
const BAKED_CLAUDE_MODELS: ModelDescriptor[] = [
  { id: "claude-opus-5", label: "Claude Opus 5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-opus-4-8", label: "Claude Opus 4.8", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-sonnet-5", label: "Claude Sonnet 5", reasoningEfforts: ["low", "medium", "high", "xhigh", "max"] },
  { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", reasoningEfforts: ["low", "medium", "high"] },
];

type ClaudeItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
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
  turnSeq: number;
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

/** Render a TodoWrite tool call's streamed input as a plan_text body. */
function formatTodos(rawInput: string): string | undefined {
  try {
    const parsed = asRecord(JSON.parse(rawInput));
    const todos = Array.isArray(parsed?.todos) ? parsed.todos : undefined;
    if (!todos) return undefined;
    const lines = todos
      .map((entry) => {
        const t = asRecord(entry);
        const content = readString(t, "content") ?? readString(t, "activeForm");
        if (!content) return undefined;
        const status = readString(t, "status");
        const marker = status === "completed" ? "✓" : status === "in_progress" ? "→" : "○";
        return `${marker} ${content}`;
      })
      .filter((v): v is string => Boolean(v));
    return lines.length > 0 ? lines.join("\n") : undefined;
  } catch {
    return undefined;
  }
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
    supportsResume: false,
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
    const mapped = init ? mapClaudeModels(init.models) : [];
    return mapped.length > 0 ? mapped : BAKED_CLAUDE_MODELS;
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
        },
      });
      const init = await q.initializationResult();
      return { account: init.account, models: init.models };
    } catch {
      return null;
    } finally {
      controller.abort();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    const env = await buildClaudeEnv();
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
      permissionMode,
      ...(permissionMode === "bypassPermissions" ? { allowDangerouslySkipPermissions: true } : {}),
      canUseTool: this.autoApprove,
      systemPrompt: { type: "preset", preset: "claude_code" },
      settingSources: ["user", "project", "local"],
      includePartialMessages: true,
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
      turnSeq: 0,
      msgOrdinal: 0,
      blocks: new Map(),
      toolItems: new Map(),
      consumer: Promise.resolve(),
      disposed: false,
      interrupting: false,
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

  /** No approval UI in kone v1 — allow every tool call the instant it's asked
   *  (see the file header). Under `bypassPermissions` the SDK never even calls
   *  this; under default/acceptEdits it does, and we allow unchanged. */
  private readonly autoApprove: CanUseTool = async (_toolName, input) => ({ behavior: "allow", updatedInput: input });

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);

    const text = input.input.trim();
    if (text.length === 0) throw new Error("Turn input must include text.");

    // Permission mode is the one selection the SDK lets us change live; model
    // and effort are spawn-fixed and change via a session restart instead.
    const mode = input.mode ?? session.mode;
    if (mode !== session.mode) {
      await session.query.setPermissionMode(toPermissionMode(mode));
      session.mode = mode;
    }

    const turnId = `turn_${++session.turnSeq}`;
    session.activeTurnId = turnId;
    session.msgOrdinal = 0;
    session.blocks.clear();
    session.toolItems.clear();
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    const userMessage: SDKUserMessage = {
      type: "user",
      parent_tool_use_id: null,
      message: { role: "user", content: [{ type: "text", text: input.input }] },
    };
    session.prompt.push(userMessage);

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId) return;
    session.interrupting = true;
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
    session.prompt.close();
    session.abort.abort();
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      session.disposed = true;
      session.prompt.close();
      session.abort.abort();
    }
    this.sessions.clear();
  }

  async respondToRequest(_threadId: string, _requestId: string, _decision: ApprovalDecision): Promise<void> {
    // No-op — autoApprove resolves every tool call inline; nothing is left
    // pending for the UI to answer (matches CodexAdapter).
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
        const isPlan = toolName === "TodoWrite";
        const buffer: ClaudeItemBuffer = {
          itemId,
          kind: isPlan ? "plan_text" : "tool_call",
          name: isPlan ? undefined : toolName,
          text: "",
          detail: "",
          toolName,
        };
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
      else if (deltaType === "input_json_delta") buffer.detail += readString(delta, "partial_json") ?? "";
      else return;
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
        buffer.text = formatTodos(buffer.detail) ?? buffer.text;
        buffer.detail = "";
        this.emitItem(session, "item.completed", buffer, "completed");
      } else if (buffer.kind === "tool_call") {
        // Input finished streaming — summarize it, but the tool is now running:
        // stays in-progress until its tool_result lands in a later user message.
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
    const content = asRecord(message.message)?.content;
    if (!Array.isArray(content)) return;
    for (const rawBlock of content) {
      const block = asRecord(rawBlock);
      if (readString(block, "type") !== "tool_result") continue;
      const toolUseId = readString(block, "tool_use_id");
      if (!toolUseId) continue;
      const buffer = session.toolItems.get(toolUseId);
      if (!buffer) continue;
      session.toolItems.delete(toolUseId);
      const resultText = extractToolResultText(block?.content).trim();
      if (resultText.length > 0) buffer.detail = resultText;
      const failed = block?.is_error === true;
      this.emitItem(session, "item.completed", buffer, failed ? "failed" : "completed");
    }
  }

  private handleResult(session: ClaudeSession, message: Extract<SDKMessage, { type: "result" }>): void {
    const usage = asRecord((message as Record<string, unknown>).usage);
    if (usage) {
      const input = readNumber(usage, "input_tokens");
      const output = readNumber(usage, "output_tokens");
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: {
          input,
          output,
          total: input !== undefined || output !== undefined ? (input ?? 0) + (output ?? 0) : undefined,
        },
      });
    }

    const turnId = session.activeTurnId;
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
    });
  }
  return out;
}
