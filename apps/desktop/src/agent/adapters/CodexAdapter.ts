import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { readCodexAuth, isCodexCliVersionSupported, MIN_CODEX_CLI_VERSION, parseCodexCliVersion } from "../codexHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
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
  ProviderConfig,
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
import { formatPlanTasks, parseCodexPlanSnapshot, reconcilePlanTasks } from "../planTasks.js";
import {
  buildCodexAttachmentInput,
  composePromptText,
  type CodexImageItem,
} from "../promptAttachments.js";

// Codex adapter — drives `codex app-server` as a persistent JSON-RPC-over-stdio
// child process per thread (transport: jsonRpc.ts). One session = one live
// app-server process bound to a Codex-native "thread" (kone's threadId maps
// 1:1 onto it — there's no separate kone-side turn-id scheme, we just use
// Codex's own turn ids directly).
//
// "Bring your own subscription": kone never runs `codex login` or writes
// auth.json — see codexHome.ts. discover() only reads what's already there.
//
// No approval UI in kone v1: every server-initiated approval request (command
// execution, file change, file read, permissions) is auto-resolved the
// instant it arrives — see wireRequests(). respondToRequest() is therefore a
// no-op; nothing is ever left pending for the UI to answer. This mirrors
// running every turn as if in "full-access" mode from Codex's own point of
// view even when kone's InteractionMode is more conservative — the mode still
// controls the sandbox (what Codex is actually allowed to touch), just not
// whether it stops to ask first.
//
// kone's three InteractionModes ARE the approval-policy ladder. research (a WIP
// branch of the same product) has expanded this to a 4-rung `RuntimeMode`
// (approval-required/auto-accept-edits/auto/full-access), but the 4th rung
// ("auto", an AI-reviewed middle ground via `approvalsReviewer: "auto_review"`)
// only landed there 2 days ago and has never shipped in the actual product —
// kone deliberately tracks the proven 3-rung shape instead: ask → research's
// "approval-required", accept-edits → "auto-accept-edits", full-access →
// "full-access". (There's also a second, orthogonal "ProviderInteractionMode"
// expose yet; don't confuse it with this ladder.) mapModeTo*Overrides below is
// the exact per-rung mapping (approvalPolicy/sandbox/approvalsReviewer),
// ported from research's runtimeModeToThreadConfig / runtimeModeToTurnSandboxPolicy
// rather than reasoned out independently.
//
// Verified directly against research's generated JSON-RPC method table
// (meta.gen.ts): the current app-server protocol has no standalone
// `turn/aborted` server notification — interruption/failure surfaces via
// `turn/completed` with `status: "interrupted" | "failed" | "cancelled"`. We
// rely on that alone; a reference implementation elsewhere handles a
// `turn/aborted` notification too, but that appears to target an older
// protocol revision this file doesn't need to match.

const CODEX_BINARY = "codex";

const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  capabilities: { experimentalApi: true },
} as const;

const NON_FATAL_CODEX_ERROR_SNIPPETS = ["write_stdin failed: stdin is closed for this session"];

type CodexItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
};

type CodexSession = {
  threadId: string;
  cwd: string;
  model?: string;
  mode: InteractionMode;
  conversationId?: string;
  activeTurnId?: string;
  rpc: JsonRpcClient;
  items: Map<string, CodexItemBuffer>;
  /** In-flight `item/tool/requestUserInput` round-trips, keyed by our requestId.
   *  The JSON-RPC handler awaits `promise`; respondToUserInput resolves it (or
   *  we drain empty on interrupt/stop) — its answers become the RPC reply. */
  pendingUserInputs: Map<string, PendingUserInput>;
};

/** A parked Codex user-input request: the questions we emitted and the resolver
 *  the awaited RPC handler is blocked on. */
type PendingUserInput = {
  questions: UserInputQuestion[];
  resolve: (answers: UserInputAnswers) => void;
};

// ── small JSON helpers ───────────────────────────────────────────────────────

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

function readString(value: unknown, ...path: string[]): string | undefined {
  let cursor: unknown = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  return typeof cursor === "string" ? cursor : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" ? value : undefined;
}

function isNonFatalCodexError(message: string): boolean {
  const lower = message.trim().toLowerCase();
  return NON_FATAL_CODEX_ERROR_SNIPPETS.some((snippet) => lower.includes(snippet));
}

/** Coerce a resolved answer value (string | string[] | null) into the flat
 *  string[] Codex expects per question. */
function toStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.filter((entry): entry is string => typeof entry === "string" && entry.length > 0);
  if (typeof value === "string" && value.length > 0) return [value];
  return [];
}

/** Normalize a Codex `item/tool/requestUserInput` payload into kone's neutral
 *  UserInputQuestion[]. Codex questions carry their own `id` (echoed back in the
 *  answer map) and options are `{ label, description }`; Codex has no per-question
 *  multi-select flag, so it's always single-select. */
function parseCodexUserInputQuestions(params: unknown): UserInputQuestion[] {
  const rawQuestions = asRecord(params)?.questions;
  if (!Array.isArray(rawQuestions)) return [];

  const out: UserInputQuestion[] = [];
  for (const raw of rawQuestions) {
    const record = asRecord(raw);
    const question = readString(record, "question")?.trim();
    const id = readString(record, "id")?.trim();
    if (!question || !id) continue;
    const header = readString(record, "header")?.trim() || "Question";

    const options: UserInputQuestionOption[] = [];
    const rawOptions = Array.isArray(record?.options) ? record!.options : [];
    for (const rawOption of rawOptions) {
      const optionRecord = asRecord(rawOption);
      const label = readString(optionRecord, "label")?.trim();
      if (!label) continue;
      const description = readString(optionRecord, "description")?.trim();
      options.push(description ? { label, description } : { label });
    }

    out.push({ id, header, question, options, multiSelect: false });
  }
  return out;
}

// ── mode → Codex approval/sandbox mapping ───────────────────────────────────
// Thread-level `sandbox` is a flat kebab-case enum; turn-level `sandboxPolicy`
// is an object with a camelCase `type` — this asymmetry is Codex's own, not a
// typo (confirmed from the reference implementation's turn/thread param
// builders). `approvalsReviewer` is sent explicitly on every mode change
// (thread AND turn) regardless — it's always "user" here since kone's ladder
// stops short of research's unshipped "auto" rung (the only one that ever sets
// it to "auto_review").

function mapModeToThreadOverrides(
  mode: InteractionMode,
): { approvalPolicy: string; sandbox: string; approvalsReviewer: string } {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", sandbox: "read-only", approvalsReviewer: "user" };
    case "full-access":
      return { approvalPolicy: "never", sandbox: "danger-full-access", approvalsReviewer: "user" };
    case "accept-edits":
    default:
      return { approvalPolicy: "on-request", sandbox: "workspace-write", approvalsReviewer: "user" };
  }
}

function mapModeToTurnOverrides(mode: InteractionMode): {
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: { type: string };
} {
  switch (mode) {
    case "ask":
      return { approvalPolicy: "untrusted", approvalsReviewer: "user", sandboxPolicy: { type: "readOnly" } };
    case "full-access":
      return { approvalPolicy: "never", approvalsReviewer: "user", sandboxPolicy: { type: "dangerFullAccess" } };
    case "accept-edits":
    default:
      return { approvalPolicy: "on-request", approvalsReviewer: "user", sandboxPolicy: { type: "workspaceWrite" } };
  }
}

// ── item type canonicalization ───────────────────────────────────────────────
// Codex's raw item.type spellings vary (camelCase/kebab/etc.); normalize then
// substring-match down to kone's 4-kind RuntimeItem model. Types kone doesn't
// render (the user's own message echoed back, review-mode markers, raw
// protocol errors, anything unrecognized) return null and are dropped.

function normalizeItemType(raw: unknown): string {
  if (typeof raw !== "string") return "";
  return raw
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[._/-]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function toRuntimeItemKind(rawType: unknown): { kind: RuntimeItemKind; defaultName?: string } | null {
  const type = normalizeItemType(rawType);
  if (!type || type.includes("user")) return null;
  if (type.includes("agent message") || type.includes("assistant") || type.includes("exited review")) {
    return { kind: "assistant_text" };
  }
  if (type.includes("reasoning") || type.includes("thought")) return { kind: "reasoning_text" };
  // `defaultName` is the tool *identity* (a canonical keyword the thread's
  // tool-family table + phrasing understand), NOT the target — the command,
  // path, or query goes into the item's `text`. Keep these keywords in sync
  // with ConversationThread.vue's TOOL_TABLE / toolPhrase vocabulary.
  if (type.includes("command")) return { kind: "tool_call", defaultName: "run" };
  if (type.includes("file change") || type.includes("patch") || type.includes("edit")) {
    return { kind: "tool_call", defaultName: "edit_file" };
  }
  if (type.includes("mcp")) return { kind: "tool_call", defaultName: "mcp" };
  if (type.includes("dynamic tool") || type.includes("collab")) return { kind: "tool_call", defaultName: "tool" };
  if (type.includes("web search")) return { kind: "tool_call", defaultName: "web_search" };
  if (type.includes("image")) {
    return { kind: "tool_call", defaultName: type.includes("generat") ? "generate_image" : "image" };
  }
  return null; // review_entered, context_compaction, error, unknown
}

/** Scavenges a human-readable blob out of an item's many possible shapes —
 *  Codex item payloads vary too much for a per-type field map. */
function itemDetail(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const nestedResult = asRecord(item.result);
  const candidates = [
    item.command,
    item.title,
    item.summary,
    item.text,
    item.path,
    item.file_path,
    item.prompt,
    nestedResult?.command,
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate.trim();
  }
  return undefined;
}

/** The richer body for a tool call's expandable `detail` — a diff, a before/
 *  after text pair, stdout/stderr, or a changed-file list. Only consulted on
 *  completion, when a delta stream hasn't already accumulated one. */
function itemDetailBody(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const nestedResult = asRecord(item.result);

  if (typeof item.diff === "string" && item.diff.trim().length > 0) return item.diff;

  const oldText = typeof item.oldText === "string" ? item.oldText : undefined;
  const newText = typeof item.newText === "string" ? item.newText : undefined;
  if (oldText || newText) {
    const parts: string[] = [];
    if (oldText) parts.push(`--- before\n${oldText}`);
    if (newText) parts.push(`+++ after\n${newText}`);
    return parts.join("\n\n");
  }

  const stdout = typeof item.stdout === "string" ? item.stdout : undefined;
  const stderr = typeof item.stderr === "string" ? item.stderr : undefined;
  if (stdout || stderr) return [stdout, stderr].filter((v): v is string => Boolean(v)).join("\n");

  const output = [item.output, nestedResult?.output].find((v) => typeof v === "string") as string | undefined;
  if (output && output.trim().length > 0) return output;

  const fileList = Array.isArray(item.files) ? item.files : Array.isArray(item.paths) ? item.paths : undefined;
  if (fileList) {
    const joined = fileList.filter((v): v is string => typeof v === "string").join("\n");
    if (joined.length > 0) return joined;
  }

  return undefined;
}

function parseModelListResponse(response: Record<string, unknown> | undefined): ModelDescriptor[] {
  const list =
    (Array.isArray(response?.items) && (response.items as unknown[])) ||
    (Array.isArray(response?.data) && (response.data as unknown[])) ||
    (Array.isArray(response?.models) && (response.models as unknown[])) ||
    [];
  const seen = new Set<string>();
  const models: ModelDescriptor[] = [];
  for (const entry of list) {
    const record = asRecord(entry);
    if (!record) continue;
    const id = [record.id, record.slug, record.model].find((v) => typeof v === "string") as string | undefined;
    if (!id || seen.has(id)) continue;
    seen.add(id);
    // Real `model/list` responses carry the human name as `displayName` (e.g.
    // "GPT-5.6-Terra" for id `gpt-5.6-terra`) — `label` was a guess at a field
    // name that doesn't actually appear in the response.
    const label = [record.displayName, record.label].find((v) => typeof v === "string") as string | undefined;
    // Real efforts vary per model (e.g. gpt-5.6-terra: low/medium/high/xhigh/max/ultra) —
    // read them straight off the response rather than assuming a fixed ladder.
    const effortEntries = Array.isArray(record.supportedReasoningEfforts)
      ? (record.supportedReasoningEfforts as unknown[])
      : [];
    const reasoningEfforts = effortEntries
      .map((entry) => asRecord(entry)?.reasoningEffort)
      .filter((v): v is string => typeof v === "string");
    const defaultReasoningEffort =
      typeof record.defaultReasoningEffort === "string" ? record.defaultReasoningEffort : undefined;
    // Real `serviceTiers` entries carry {id, name, description}; the older
    // `additionalSpeedTiers` a bare id list (deprecated, "fast" in practice).
    // Either way we normalize to the same {id, label, description} shape.
    const serviceTierEntries = Array.isArray(record.serviceTiers) ? (record.serviceTiers as unknown[]) : [];
    const serviceTiers = serviceTierEntries
      .map((entry) => {
        const r = asRecord(entry);
        const tierId = typeof r?.id === "string" ? r.id : undefined;
        const name = typeof r?.name === "string" ? r.name : undefined;
        if (!tierId) return undefined;
        return {
          id: tierId,
          label: name ?? tierId,
          ...(typeof r?.description === "string" && r.description ? { description: r.description } : {}),
        };
      })
      .filter((v): v is { id: string; label: string; description?: string } => v !== undefined);
    if (!serviceTiers.length && Array.isArray(record.additionalSpeedTiers)) {
      for (const tierId of record.additionalSpeedTiers as unknown[]) {
        if (typeof tierId === "string") serviceTiers.push({ id: tierId, label: tierId === "fast" ? "Fast" : tierId });
      }
    }
    models.push({
      id,
      label: label ?? id,
      ...(reasoningEfforts.length ? { reasoningEfforts } : {}),
      ...(defaultReasoningEffort ? { defaultReasoningEffort } : {}),
      ...(serviceTiers.length ? { serviceTiers } : {}),
    });
  }
  return models;
}

export class CodexAdapter implements ProviderAdapter {
  readonly provider = "codex" as const;
  readonly capabilities: AdapterCapabilities = {
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // Codex has no nested-agent surface of its own (no Task/Agent tool), so a
    // turn never fans out into runs kone could project.
    supportsSubagents: false,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, CodexSession>();
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  /** The CLI executable to spawn — the user's override or the `codex` default. */
  private binary = CODEX_BINARY;

  constructor(emit: EmitEvent) {
    this.emit = emit;
  }

  /** Adopt the user's persisted install settings. A blank binaryPath falls back
   *  to the default; drop the model cache so the next probe uses the new binary. */
  setConfig(config: ProviderConfig): void {
    const next = config.binaryPath?.trim() || CODEX_BINARY;
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildAgentEnv();
    const output = await probe(this.binary, ["--version"], env, 5_000);
    if (output === null) {
      return {
        provider: this.provider,
        label: "Codex",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message: "Codex CLI not found. Install it and run `codex login`.",
      };
    }

    const version = parseCodexCliVersion(output) ?? undefined;
    if (!isCodexCliVersionSupported(version ?? null)) {
      return {
        provider: this.provider,
        label: "Codex",
        available: true,
        authStatus: "unknown",
        readiness: "error",
        version,
        message: `Codex CLI v${version} is too old — upgrade to v${MIN_CODEX_CLI_VERSION} or newer.`,
      };
    }

    const auth = readCodexAuth();
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Codex",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `codex login` to sign in.",
      };
    }

    return {
      provider: this.provider,
      label: "Codex",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.modelsCache) {
      this.modelsCache = this.fetchModels().catch((error: unknown) => {
        this.modelsCache = null;
        throw error;
      });
    }
    return this.modelsCache;
  }

  /** A short-lived handshake-only app-server just to call model/list — spawned
   *  fresh and killed immediately after, since there's no thread to keep alive
   *  for it. Result is cached for the adapter's lifetime (kone's warmup plugin
   *  calls this once at app open). */
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildAgentEnv();
    const rpc = new JsonRpcClient(this.binary, ["app-server"], { cwd: homedir(), env });
    try {
      await rpc.call("initialize", CODEX_INITIALIZE_PARAMS);
      rpc.notify("initialized");
      const response = await rpc.call<Record<string, unknown>>("model/list", {
        cursor: null,
        limit: 50,
        includeHidden: false,
      });
      return parseModelListResponse(response);
    } finally {
      rpc.kill();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    const env = await buildAgentEnv();
    const rpc = new JsonRpcClient(this.binary, ["app-server"], { cwd: input.cwd, env });
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: CodexSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      rpc,
      items: new Map(),
      pendingUserInputs: new Map(),
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      this.sessions.delete(input.threadId);
      this.emit({ ...this.base(session), type: "session.exited", code });
    });

    try {
      await rpc.call("initialize", CODEX_INITIALIZE_PARAMS);
      rpc.notify("initialized");

      const overrides = {
        model: input.model ?? null,
        cwd: input.cwd,
        ...mapModeToThreadOverrides(mode),
      };

      // Resume the prior Codex thread by id (via `thread/resume`) so the
      // conversation continues with its full context — mirrors research's
      // app-server resume path. If resume is refused (thread pruned/expired),
      // fall back to a fresh `thread/start` rather than failing the open.
      let response: Record<string, unknown> | undefined;
      let openMethod: "thread/start" | "thread/resume" = "thread/start";
      if (input.resume) {
        try {
          openMethod = "thread/resume";
          response = await rpc.call<Record<string, unknown>>("thread/resume", {
            ...overrides,
            threadId: input.resume,
          });
        } catch {
          openMethod = "thread/start";
          response = undefined;
        }
      }
      if (!response) {
        response = await rpc.call<Record<string, unknown>>("thread/start", {
          ...overrides,
          experimentalRawEvents: false,
        });
      }
      const thread = asRecord(response)?.thread;
      const conversationId = readString(thread, "id") ?? readString(response, "threadId");
      if (!conversationId) throw new Error(`${openMethod} response did not include a thread id.`);
      session.conversationId = conversationId;
    } catch (error) {
      rpc.kill();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const mode = input.mode ?? session.mode;
    session.mode = mode;
    if (input.model) session.model = input.model;

    const text = input.input.trim();

    // Compose the turn's input items: the prompt text (with any non-image files
    // folded in as an <attached_files> path block) followed by native image
    // items. An attachment-only turn is valid — we just skip the text item.
    const { imageItems, fileBlock } = await buildCodexAttachmentInput(input.attachments);
    const promptText = composePromptText(text, fileBlock);
    const inputItems: Array<
      { type: "text"; text: string; text_elements: [] } | CodexImageItem
    > = [];
    if (promptText.length > 0) inputItems.push({ type: "text", text: promptText, text_elements: [] });
    inputItems.push(...imageItems);
    if (inputItems.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }

    const response = await session.rpc.call<Record<string, unknown>>("turn/start", {
      threadId: session.conversationId,
      input: inputItems,
      ...mapModeToTurnOverrides(mode),
      ...(session.model ? { model: session.model } : {}),
      ...(input.effort ? { effort: input.effort } : {}),
      ...(input.serviceTier ? { serviceTier: input.serviceTier } : {}),
    });
    const turnId = readString(response, "turn", "id") ?? readString(response, "turnId");
    if (!turnId) throw new Error("turn/start response did not include a turn id.");
    session.activeTurnId = turnId;
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    // Unblock any parked user-input request so the interrupt lands cleanly.
    this.drainUserInputs(session);
    await session.rpc.call("turn/interrupt", {
      threadId: session.conversationId,
      turnId: session.activeTurnId,
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainUserInputs(session);
    session.rpc.kill();
    this.sessions.delete(threadId);
  }

  async stopAll(): Promise<void> {
    for (const session of this.sessions.values()) {
      this.drainUserInputs(session);
      session.rpc.kill();
    }
    this.sessions.clear();
  }

  async respondToRequest(_threadId: string, _requestId: string, _decision: ApprovalDecision): Promise<void> {
    // No-op — see wireRequests(): every Codex approval prompt is auto-resolved
    // the instant it arrives, so nothing is ever left pending to respond to.
    // User-input questions use respondToUserInput instead.
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

  // ── notifications / server requests ─────────────────────────────────────

  private wireNotifications(session: CodexSession): void {
    const { rpc } = session;

    rpc.onNotification("turn/started", (params) => {
      const turnId = readString(params, "turn", "id") ?? readString(params, "turnId");
      if (!turnId) return;
      session.activeTurnId = turnId;
      this.emit({ ...this.base(session), type: "turn.started", turnId });
    });

    rpc.onNotification("turn/plan/updated", (params) => {
      // Honor the turn the notification names, not `activeTurnId`. Codex forwards
      // child/collaboration-turn plans while the parent turn is still active, so
      // keying off `activeTurnId` would let a child plan clobber the parent's and
      // emit under the wrong turn. Fall back to `activeTurnId` only when the
      // notification carries no turn id of its own.
      const turnId =
        readString(params, "turn", "id") ??
        readString(params, "turnId") ??
        readString(params, "msg", "turn_id") ??
        readString(params, "msg", "turnId") ??
        session.activeTurnId;
      if (!turnId) return;
      const snapshot = parseCodexPlanSnapshot(params);
      if (!snapshot) return;
      const itemId = `${turnId}:plan`;
      const existing = session.items.get(itemId);
      const tasks = reconcilePlanTasks(existing?.tasks ?? [], snapshot);
      const buffer: CodexItemBuffer = {
        itemId,
        kind: "plan_text",
        text: formatPlanTasks(tasks),
        detail: "",
        tasks,
      };
      session.items.set(itemId, buffer);
      this.emitItem(
        session,
        existing ? "item.updated" : "item.started",
        buffer,
        "in-progress",
        turnId,
      );
    });

    rpc.onNotification("turn/completed", (params) => {
      const turn = asRecord(params)?.turn;
      const turnId = readString(turn, "id") ?? readString(params, "turnId") ?? session.activeTurnId;
      const status = readString(turn, "status") ?? "completed";
      if (turnId) this.completePlanItem(session, turnId);
      session.activeTurnId = undefined;
      if (!turnId) return;
      if (status === "completed") {
        this.emit({
          ...this.base(session),
          type: "turn.completed",
          turnId,
          conversationId: session.conversationId,
        });
        return;
      }
      const reason = status === "failed" ? "failed" : "interrupted";
      const message = readString(turn, "errorMessage") ?? readString(asRecord(turn)?.error, "message");
      this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason, message });
    });

    rpc.onNotification("thread/tokenUsage/updated", (params) => {
      // Codex shape (confirmed in research): `{ tokenUsage: { last, total } }`
      // where each side is a breakdown with `totalTokens` / `inputTokens` / …
      // `total` is the running thread cumulative — ConversationStore keeps MAX
      // of it. Looking for a flat `params.usage.totalTokens` silently drops
      // every update.
      const payload = asRecord(params);
      const tokenUsage =
        asRecord(payload?.tokenUsage) ??
        asRecord(payload?.usage) ??
        payload;
      const totalBreakdown =
        asRecord(tokenUsage?.total) ??
        asRecord(tokenUsage?.total_token_usage);
      const lastBreakdown =
        asRecord(tokenUsage?.last) ??
        asRecord(tokenUsage?.last_token_usage);
      // Prefer the cumulative thread total; fall back to last-turn if Codex
      // only sent `last` (or an older flat payload).
      const breakdown = totalBreakdown ?? lastBreakdown ?? tokenUsage;
      if (!breakdown) return;
      const contextUsed =
        numberOrUndefined(lastBreakdown?.totalTokens) ??
        numberOrUndefined(lastBreakdown?.total_tokens) ??
        numberOrUndefined(lastBreakdown?.total);
      const contextWindow =
        numberOrUndefined(tokenUsage?.modelContextWindow) ??
        numberOrUndefined(tokenUsage?.model_context_window) ??
        numberOrUndefined(payload?.modelContextWindow) ??
        numberOrUndefined(payload?.model_context_window);
      const total =
        numberOrUndefined(totalBreakdown?.totalTokens) ??
        numberOrUndefined(totalBreakdown?.total_tokens) ??
        numberOrUndefined(lastBreakdown?.totalTokens) ??
        numberOrUndefined(lastBreakdown?.total_tokens) ??
        numberOrUndefined(breakdown.totalTokens) ??
        numberOrUndefined(breakdown.total_tokens) ??
        numberOrUndefined(breakdown.total);
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: {
          input:
            numberOrUndefined(breakdown.inputTokens) ??
            numberOrUndefined(breakdown.input_tokens) ??
            numberOrUndefined(breakdown.input),
          output:
            numberOrUndefined(breakdown.outputTokens) ??
            numberOrUndefined(breakdown.output_tokens) ??
            numberOrUndefined(breakdown.output),
          total,
          ...(contextUsed !== undefined ? { contextUsed } : {}),
          ...(contextWindow !== undefined ? { contextWindow } : {}),
          ...(contextWindow !== undefined ? { compactsAutomatically: true } : {}),
        },
      });
    });

    rpc.onNotification("item/started", (params) => this.handleItemLifecycle(session, params, "started"));
    rpc.onNotification("item/completed", (params) => this.handleItemLifecycle(session, params, "completed"));

    const deltaMethods = [
      "item/agentMessage/delta",
      "item/reasoning/textDelta",
      "item/reasoning/summaryTextDelta",
      "item/commandExecution/outputDelta",
      "item/fileChange/outputDelta",
      "item/plan/delta",
    ];
    for (const method of deltaMethods) {
      rpc.onNotification(method, (params) => this.handleDelta(session, params));
    }

    rpc.onNotification("error", (params) => {
      const message = readString(params, "message") ?? "Codex reported an error.";
      if (isNonFatalCodexError(message)) return;
      this.emit({ ...this.base(session), type: "session.state.changed", state: "error", message });
    });
  }

  /** No approval UI in kone v1 — auto-resolve every server-initiated approval
   *  request the instant it arrives (see the file header comment). Unhandled
   *  methods fall through to jsonRpc.ts's own "method not found" reply. */
  private wireRequests(session: CodexSession): void {
    const { rpc } = session;
    const autoApprove = async () => ({ decision: "acceptForSession" });
    rpc.onRequest("item/commandExecution/requestApproval", autoApprove);
    rpc.onRequest("item/fileChange/requestApproval", autoApprove);
    rpc.onRequest("item/fileRead/requestApproval", autoApprove);
    rpc.onRequest("item/permissions/requestApproval", autoApprove);
    // Unlike the approval prompts above, a user-input request is a real
    // question for the human — park it for a renderer answer. The handler is
    // async and jsonRpc.ts awaits its promise, so blocking here is the reply.
    rpc.onRequest("item/tool/requestUserInput", (params) => this.requestUserInput(session, params));
  }

  /** Handle a Codex `item/tool/requestUserInput`: parse its questions, emit
   *  `user-input.requested`, and block on the parked resolver until the renderer
   *  answers (or we drain on interrupt/stop). The resolved answers become the
   *  RPC reply, shaped as `{ answers: { [questionId]: { answers: string[] } } }`. */
  private async requestUserInput(
    session: CodexSession,
    params: unknown,
  ): Promise<{ answers: Record<string, { answers: string[] }> }> {
    const questions = parseCodexUserInputQuestions(params);
    if (questions.length === 0) return { answers: {} };

    const requestId = randomUUID();
    const turnId = readString(params, "turnId") ?? session.activeTurnId;
    const answers = await new Promise<UserInputAnswers>((resolve) => {
      session.pendingUserInputs.set(requestId, { questions, resolve });
      this.emit({
        ...this.base(session),
        type: "user-input.requested",
        requestId,
        turnId,
        questions,
      });
    });

    this.emit({ ...this.base(session), type: "user-input.resolved", requestId, answers });

    // Codex keys answers by question id, each a { answers: string[] }.
    const reply: Record<string, { answers: string[] }> = {};
    for (const question of questions) {
      reply[question.id] = { answers: toStringArray(answers[question.id]) };
    }
    return { answers: reply };
  }

  /** Settle one parked user-input request (idempotent — a no-op once drained). */
  private resolveUserInput(session: CodexSession, requestId: string, answers: UserInputAnswers): void {
    const pending = session.pendingUserInputs.get(requestId);
    if (!pending) return;
    session.pendingUserInputs.delete(requestId);
    pending.resolve(answers);
  }

  /** Resolve every parked question empty — on interrupt/stop so no RPC handler
   *  hangs and the renderer's pending prompt clears. */
  private drainUserInputs(session: CodexSession): void {
    for (const [requestId] of [...session.pendingUserInputs]) {
      this.resolveUserInput(session, requestId, {});
    }
  }

  private handleItemLifecycle(session: CodexSession, params: unknown, lifecycle: "started" | "completed"): void {
    const payload = asRecord(params);
    const raw = asRecord(payload?.item) ?? payload;
    if (!raw) return;
    const itemId = readString(raw, "id") ?? readString(raw, "itemId");
    if (!itemId) return;

    const mapped = toRuntimeItemKind(raw.type);

    if (lifecycle === "started") {
      if (!mapped) return;
      const isTextKind =
        mapped.kind === "assistant_text" || mapped.kind === "reasoning_text" || mapped.kind === "plan_text";
      const buffer: CodexItemBuffer = {
        itemId,
        kind: mapped.kind,
        // Identity keyword drives the icon/hue/phrasing; the target (command,
        // path, query) rides along in `text`.
        name: isTextKind ? undefined : mapped.defaultName,
        text: isTextKind ? "" : (itemDetail(raw) ?? ""),
        detail: "",
      };
      session.items.set(itemId, buffer);
      this.emitItem(session, "item.started", buffer, "in-progress");
      return;
    }

    const existing = session.items.get(itemId);
    const kind = existing?.kind ?? mapped?.kind;
    if (!kind) return;
    const label = itemDetail(raw);
    const body = itemDetailBody(raw);
    const buffer: CodexItemBuffer = {
      itemId,
      kind,
      name: existing?.name ?? mapped?.defaultName,
      text: existing?.text && existing.text.length > 0 ? existing.text : (label ?? existing?.text ?? ""),
      detail: existing?.detail && existing.detail.length > 0 ? existing.detail : (body ?? existing?.detail ?? ""),
    };
    session.items.set(itemId, buffer);
    const failed = readString(raw, "status") === "failed" || Boolean(asRecord(raw.error));
    this.emitItem(session, "item.completed", buffer, failed ? "failed" : "completed");
  }

  private handleDelta(session: CodexSession, params: unknown): void {
    const payload = asRecord(params);
    if (!payload) return;
    const itemId = readString(payload, "itemId") ?? readString(payload.item, "id");
    if (!itemId) return;
    const delta = readString(payload, "delta") ?? readString(payload, "text") ?? readString(payload.content, "text");
    if (!delta) return;
    const buffer = session.items.get(itemId);
    if (!buffer) return;
    // Text kinds stream their narrative into `text`; a tool call's output
    // deltas (command stdout, file-change progress) accumulate in `detail`
    // instead so they never clobber the short inline summary.
    if (buffer.kind === "tool_call") {
      buffer.detail += delta;
    } else {
      buffer.text += delta;
    }
    this.emitItem(session, "item.updated", buffer, "in-progress");
  }

  private completePlanItem(session: CodexSession, turnId: string): void {
    const itemId = `${turnId}:plan`;
    const buffer = session.items.get(itemId);
    if (!buffer) return;
    this.emitItem(session, "item.completed", buffer, "completed", turnId);
    session.items.delete(itemId);
  }

  private emitItem(
    session: CodexSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: CodexItemBuffer,
    status: RuntimeItemStatus,
    turnId: string | undefined = session.activeTurnId,
  ): void {
    if (!turnId) return;
    const item: RuntimeItem = {
      itemId: buffer.itemId,
      kind: buffer.kind,
      status,
      text: buffer.text,
      name: buffer.name,
      ...(buffer.tasks?.length ? { tasks: buffer.tasks } : {}),
      ...(buffer.detail.length > 0 ? { detail: buffer.detail } : {}),
    };
    this.emit({ ...this.base(session), type, turnId, item });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private base(session: CodexSession) {
    return {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "codex.rpc.notification" as const,
    };
  }

  private toSession(session: CodexSession): Session {
    return {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.conversationId,
      activeTurnId: session.activeTurnId,
      model: session.model,
      mode: session.mode,
    };
  }

  private requireSession(threadId: string): CodexSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Codex session for thread ${threadId}`);
    return session;
  }
}
