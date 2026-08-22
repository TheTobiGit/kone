import { randomUUID } from "node:crypto";
import { homedir } from "node:os";

import { readCodexAuth, isCodexCliVersionSupported, MIN_CODEX_CLI_VERSION, parseCodexCliVersion } from "../codexHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
import { buildAgentEnv } from "../processEnv.js";
import { probe } from "../spawn.js";
import type {
  AdapterCapabilities,
  AgentPersona,
  ApprovalDecision,
  ApprovalRequest,
  ApprovalRequestKind,
  EmitEvent,
  GatewayConnection,
  InteractionMode,
  ModelDescriptor,
  PlanTask,
  ProviderAdapter,
  ProviderConfig,
  ProviderStatus,
  RuntimeItem,
  RuntimeItemKind,
  RuntimeItemStatus,
  RuntimeEvent,
  Session,
  SendTurnInput,
  SessionStartInput,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
  UserInputQuestion,
  UserInputQuestionOption,
} from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";
import {
  isNonFatalCodexError,
  isRecoverableCodexResumeError,
} from "./errors.js";
import { buildCodexTurnCollaborationMode, type CodexTurnCollaborationMode } from "../gateway/appContext.js";
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
// Every server-initiated approval request (command execution, file change,
// file read, permissions) is parked and surfaced to the user via an
// `approval.requested` event instead of being auto-resolved — see
// wireRequests(). The user's decision (respondToRequest) resolves the parked
// RPC handler with Codex's own reply. This makes the mode ladder honest: in
// `ask` (approvalPolicy "untrusted") every action stops to ask, in
// `accept-edits` ("on-request") only the non-file-edit actions do, and in
// `full-access` ("never") nothing does. The mode still controls the sandbox
// (what Codex is actually allowed to touch) and whether it stops to ask first.
//
// kone's three InteractionModes ARE the approval-policy ladder: ask →
// "approval-required", accept-edits → "auto-accept-edits", full-access →
// "full-access". kone deliberately tracks this 3-rung shape rather than a 4th
// "auto" rung (an AI-reviewed middle ground via `approvalsReviewer:
// "auto_review"`) that's brand-new and unshipped. (There's also a second,
// orthogonal "ProviderInteractionMode" plan/build toggle in the Codex protocol
// — a different axis kone doesn't expose yet; don't confuse it with this
// ladder.) mapModeTo*Overrides below is the exact per-rung mapping
// (approvalPolicy/sandbox/approvalsReviewer).
//
// Verified against the app-server protocol's generated JSON-RPC method table
// (meta.gen.ts): there's no standalone `turn/aborted` server notification —
// interruption/failure surfaces via `turn/completed` with `status:
// "interrupted" | "failed" | "cancelled"`. We rely on that alone; a
// `turn/aborted` notification would target an older protocol revision this file
// doesn't need to match.

const CODEX_BINARY = "codex";

const CODEX_INITIALIZE_PARAMS = {
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  capabilities: { experimentalApi: true },
} as const;

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
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  /** The session's loopback gateway connection (minted at startSession),
   *  present exactly when the kone MCP server is live for this thread — gates
   *  the collaborationMode/developer_instructions injection in sendTurn. */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one.
   *  Held on the session because codex takes its developer instructions per
   *  turn: every turn re-states who is answering, so a resumed conversation
   *  keeps its name without kone having to replay anything. */
  agent?: AgentPersona;
  activeTurnId?: string;
  rpc: JsonRpcClient;
  items: Map<string, CodexItemBuffer>;
  /** In-flight `item/tool/requestUserInput` round-trips, keyed by our requestId.
   *  The JSON-RPC handler awaits `promise`; respondToUserInput resolves it (or
   *  we drain empty on interrupt/stop) — its answers become the RPC reply. */
  pendingUserInputs: Map<string, PendingUserInput>;
  /** In-flight approval requests, keyed by our requestId. The RPC handler
   *  awaits `promise`; respondToRequest resolves it (or we drain on
   *  interrupt/stop) — the decision becomes the `requestApproval` reply. */
  pendingApprovals: Map<string, PendingApproval>;
};

/** A parked Codex user-input request: the questions we emitted and the resolver
 *  the awaited RPC handler is blocked on. */
type PendingUserInput = {
  questions: UserInputQuestion[];
  resolve: (answers: UserInputAnswers) => void;
};

/** A parked Codex approval request: what we asked the user to approve and the
 *  resolver the awaited `requestApproval` RPC handler is blocked on. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
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

/** Normalize one Codex `requestApproval` payload into the neutral ask the
 *  renderer shows. Each request kind has its own fields — command execution
 *  carries the command line, file change/read carry the path (or root), the
 *  permissions grant carries no single subject. */
function buildApprovalRequest(kind: ApprovalRequestKind, params: unknown): ApprovalRequest {
  const reason = readString(params, "reason")?.trim();
  switch (kind) {
    case "command": {
      const command = readString(params, "command")?.trim();
      const request: ApprovalRequest = {
        kind,
        title: command ?? "Run a command",
      };
      if (reason) request.detail = reason;
      return request;
    }
    case "file-change": {
      const grantRoot = readString(params, "grantRoot")?.trim();
      const request: ApprovalRequest = {
        kind,
        title: grantRoot ?? "Change files",
      };
      if (reason) request.detail = reason;
      return request;
    }
    case "file-read": {
      const path = readString(params, "path")?.trim() ?? readString(params, "grantRoot")?.trim();
      const request: ApprovalRequest = {
        kind,
        title: path ?? "Read files",
      };
      if (reason) request.detail = reason;
      return request;
    }
    case "permission":
    default: {
      const request: ApprovalRequest = {
        kind,
        title: "Grant expanded permissions",
      };
      if (reason) request.detail = reason;
      return request;
    }
  }
}

/** kone's ApprovalDecision → Codex's `requestApproval` reply vocabulary.
 *  `reject-and-stop` is Codex's `cancel` — the command is denied AND the turn
 *  is immediately interrupted (the app-server's own schema words it exactly
 *  that: "User denied the command. The turn will also be immediately
 *  interrupted."), so no extra work is needed on our side. */
function toCodexApprovalDecision(decision: ApprovalDecision): string {
  switch (decision) {
    case "allow-always":
      return "acceptForSession";
    case "allow-once":
      return "accept";
    case "reject-once":
      return "decline";
    case "reject-and-stop":
      return "cancel";
  }
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
// typo. `approvalsReviewer` is sent explicitly on every mode change (thread AND
// turn) regardless — it's always "user" here since kone's ladder has no "auto"
// rung (the only one that would set it to "auto_review").

type CodexThreadModeOverrides = {
  approvalPolicy: string;
  sandbox: string;
  approvalsReviewer: string;
};

function mapModeToThreadOverrides(
  mode: InteractionMode,
): CodexThreadModeOverrides {
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

function mapModeToTurnOverrides(mode: InteractionMode): Pick<
  CodexTurnStartParams,
  "approvalPolicy" | "approvalsReviewer" | "sandboxPolicy"
> {
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

// The codex-rs turn/start payload. Always-present keys come from the envelope
// and the mode overrides; model/effort/serviceTier/collaborationMode are
// optional per the app-server protocol (only those four ride a turn, see the
// context-window note at the call site).
type CodexTurnStartParams = {
  threadId: string;
  input: Array<{ type: "text"; text: string; text_elements: [] } | CodexImageItem>;
  approvalPolicy: string;
  approvalsReviewer: string;
  sandboxPolicy: { type: string };
  model?: string;
  effort?: string;
  serviceTier?: string;
  collaborationMode?: CodexTurnCollaborationMode;
};

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

/** Join a multi-part string array (Codex sometimes sends `summary`/`content`
 */
export function joinedText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const parts = value
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

/** Scavenges a human-readable blob out of an item's many possible shapes —
 *  Codex item payloads vary too much for a per-type field map. */
export function itemDetail(item: Record<string, unknown> | undefined): string | undefined {
  if (!item) return undefined;
  const nestedResult = asRecord(item.result);
  const candidates = [
    item.command,
    item.title,
    item.summary,
    joinedText(item.summary),
    joinedText(item.content),
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

/** Map a Codex item/completed `status` onto kone's terminal item states.
 *  `declined` (the user declined the action). kone's RuntimeItemStatus has no
 *  declined state, so a declined item folds into `failed` — the closest
 *  terminal state — instead of masquerading as a successful completion. */
export function mapCodexItemStatus(status: string | undefined, hasError: boolean): "completed" | "failed" {
  return status === "failed" || status === "declined" || hasError ? "failed" : "completed";
}

/** Surface an "already has an active writer" thread/resume refusal as a human
 *  message instead of a raw protocol error. The thread is genuinely open in
 *  another Codex client, so this is NOT a recoverable refusal — a fresh
 *  start would abandon the original thread and the user would never know why
 */
export function formatCodexThreadResumeError(error: unknown, threadId: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (!message.toLowerCase().includes("already has an active writer")) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(
    `Codex thread ${threadId} is open in another Codex client. Close that client before continuing the original thread, or start a new thread instead.`,
    { cause: error },
  );
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
        const tier = { id: tierId, label: name ?? tierId };
        return typeof r?.description === "string" && r.description
          ? { ...tier, description: r.description }
          : tier;
      })
      .filter((v): v is { id: string; label: string; description?: string } => v !== undefined);
    if (!serviceTiers.length && Array.isArray(record.additionalSpeedTiers)) {
      for (const tierId of record.additionalSpeedTiers as unknown[]) {
        if (typeof tierId === "string") serviceTiers.push({ id: tierId, label: tierId === "fast" ? "Fast" : tierId });
      }
    }
    // Real `model/list` models carry the catalog's default speed tier
    // (`defaultServiceTier`, e.g. "fast") so the picker can pre-set the
    // fast-mode toggle to the provider's default instead of guessing.
    const defaultServiceTier =
      typeof record.defaultServiceTier === "string" ? record.defaultServiceTier : undefined;
    const model: ModelDescriptor = {
      id,
      label: label ?? id,
    };
    if (reasoningEfforts.length) model.reasoningEfforts = reasoningEfforts;
    if (defaultReasoningEffort) model.defaultReasoningEffort = defaultReasoningEffort;
    if (serviceTiers.length) model.serviceTiers = serviceTiers;
    if (defaultServiceTier) model.defaultServiceTier = defaultServiceTier;
    models.push(model);
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
      await rpc.kill();
    }
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before spawning its replacement.
    // The map is overwritten unconditionally at the end of this method, so
    // without this the previous `codex app-server` child is never killed — it
    // lingers holding the workspace. OpenCodeAdapter has always done this.
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);

    const env = await buildAgentEnv();
    const rpc = new JsonRpcClient(this.binary, ["app-server"], { cwd: input.cwd, env });
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: CodexSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      gatewayConnection: input.gatewayConnection,
      agent: input.agent,
      rpc,
      items: new Map(),
      pendingUserInputs: new Map(),
      pendingApprovals: new Map(),
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      // Only the session the map still points at may retire the entry. A
      // replacement can claim this threadId while this child is shutting down,
      // and deleting then would drop a live session and report it as exited.
      // No entry at all means stopSession already removed ours, so the exit is
      // still genuinely this session's to announce.
      const current = this.sessions.get(input.threadId);
      if (current && current !== session) {
        // A replacement owns the thread now — the old session's parked asks
        // still die with it.
        this.drainApprovals(session);
        this.drainUserInputs(session);
        return;
      }
      if (current) this.sessions.delete(input.threadId);
      // Fail closed on the way out: resolve every parked approval/user-input
      // request so no RPC handler hangs on a promise nothing will settle.
      this.drainApprovals(session);
      this.drainUserInputs(session);
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
      // conversation continues with its full context. If resume is refused
      // (thread pruned/expired),
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
        } catch (error) {
          // Only a refusal-class failure (thread pruned/expired/foreign, or a
          // dead app-server) deserves the fresh-start fallback. A transport or
          // protocol error must surface — silently starting fresh would reopen
          // the thread on a blank conversation and the user would never know
          // isRecoverableThreadResumeError gate. An "already has an active
          // writer" refusal is non-recoverable too, but it gets a human
          // message (the thread is open elsewhere) instead of the raw error.
          if (!isRecoverableCodexResumeError(error)) {
            throw formatCodexThreadResumeError(error, input.resume);
          }
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
      // Only when resume was the method that actually opened this thread — the catch
      // above swallows a refused resume, so `input.resume` alone proves nothing about
      // whether the context came back. See Session.resumedFrom.
      if (openMethod === "thread/resume") session.resumedFrom = input.resume;
    } catch (error) {
      await rpc.kill();
      throw error;
    }

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    // startSession throws unless the open call returned a thread id, so a live
    // session always carries one; re-check it here to keep turn/start typed.
    const conversationId = session.conversationId;
    if (!conversationId) throw new Error(`No Codex conversation for thread ${input.threadId}`);
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

    // The kone host-context block rides the codex-rs `developer_instructions`
    // both use). Delivered on EVERY turn, which covers resumed threads too:
    // a resumed conversation gets it on its next turn/start, same as fresh.
    // Gated on the gateway connection so an agent is never told about tools
    // it doesn't have.
    const collaborationMode = buildCodexTurnCollaborationMode({
      model: session.model,
      effort: input.effort,
      gatewayControlAvailable: session.gatewayConnection !== undefined,
      agent: session.agent,
    });
    const turnStartInput: CodexTurnStartParams = {
      threadId: conversationId,
      input: inputItems,
      ...mapModeToTurnOverrides(mode),
    };
    if (session.model) turnStartInput.model = session.model;
    if (input.effort) turnStartInput.effort = input.effort;
    if (input.serviceTier) turnStartInput.serviceTier = input.serviceTier;
    // `contextWindow` is deliberately not sent: the app-server's turn/start
    // protocol has no context-window axis (verified against the generated
    // schema — only model/effort/serviceTier ride a turn). The model's
    // window is fixed by the catalog, so a per-turn value could only be a
    // stale selection.
    if (collaborationMode) turnStartInput.collaborationMode = collaborationMode;
    const response = await session.rpc.call<Record<string, unknown>>("turn/start", turnStartInput);
    const turnId = readString(response, "turn", "id") ?? readString(response, "turnId");
    if (!turnId) throw new Error("turn/start response did not include a turn id.");
    // Codex accepts queued follow-ups while the current turn is still
    // running: the turn/start response carries the queued turn id, but
    // turn/interrupt only accepts the id of the turn that's active right
    // now. Keep the active id; the queued turn's own `turn/started`
    // CodexSessionRuntime fix.
    session.activeTurnId = session.activeTurnId ?? turnId;
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    // Unblock any parked user-input request so the interrupt lands cleanly.
    this.drainUserInputs(session);
    this.drainApprovals(session);
    await session.rpc.call("turn/interrupt", {
      threadId: session.conversationId,
      turnId: session.activeTurnId,
    });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainUserInputs(session);
    this.drainApprovals(session);
    this.abortLiveTurn(session);
    this.sessions.delete(threadId);
    await session.rpc.kill();
  }

  /** Seal a turn that's still live as we tear the session down. Killing the
   *  transport means Codex's own cancellation reply never arrives, so nothing
   *  else will ever speak for this turn — without this the journaled assistant
   *  block stays 'running' forever and the thread reopens permanently busy.
   *  `session.exited` (from the kill) can't cover it: that seals as 'failed',
   *  and a deliberate stop is an interrupt, not a failure. */
  private abortLiveTurn(session: CodexSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async stopAll(): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
      this.drainUserInputs(session);
      this.drainApprovals(session);
      // Seal a still-live turn as `interrupted` BEFORE the kill: the child's
      // exit only seals as 'failed', and a deliberate stop is an interrupt,
      // not a failure. Same guard stopSession's kill path relies on.
      this.abortLiveTurn(session);
      kills.push(session.rpc.kill());
    }
    this.sessions.clear();
    await Promise.all(kills);
  }

  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.resolveApproval(session, requestId, decision);
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
      // Codex shape: `{ tokenUsage: { last, total } }` where each side is a
      // breakdown with `totalTokens` / `inputTokens` / … `total` is the running
      // thread cumulative — ConversationStore keeps MAX
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
      // The same breakdown already carries the prompt-cache and reasoning
      // splits Codex's Responses-API usage reports — `cachedInputTokens` /
      // `reasoningOutputTokens` (or their snake_case wire form on older
      // builds) — which this adapter previously never read at all. Codex has
      // no separate "cache write" bucket distinct from the cached-read count
      // (unlike Anthropic's two-sided cache accounting), so cache-creation is
      // always 0 for this provider.
      const cacheReadTokens =
        numberOrUndefined(breakdown.cachedInputTokens) ??
        numberOrUndefined(breakdown.cached_input_tokens);
      const reasoningTokens =
        numberOrUndefined(breakdown.reasoningOutputTokens) ??
        numberOrUndefined(breakdown.reasoning_output_tokens);
      const usageWithSplits: TokenUsage & TokenUsageSplits = {
        input:
          numberOrUndefined(breakdown.inputTokens) ??
          numberOrUndefined(breakdown.input_tokens) ??
          numberOrUndefined(breakdown.input),
        output:
          numberOrUndefined(breakdown.outputTokens) ??
          numberOrUndefined(breakdown.output_tokens) ??
          numberOrUndefined(breakdown.output),
        total,
        cacheReadTokens: cacheReadTokens ?? 0,
        cacheCreationTokens: 0,
        reasoningTokens: reasoningTokens ?? 0,
      };
      if (contextUsed !== undefined) usageWithSplits.contextUsed = contextUsed;
      if (contextWindow !== undefined) {
        usageWithSplits.contextWindow = contextWindow;
        usageWithSplits.compactsAutomatically = true;
      }
      this.emit({
        ...this.base(session),
        type: "thread.token-usage.updated",
        usage: usageWithSplits,
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
      // Real app-server shape: `{ error: { message, additionalDetails,
      // codexErrorInfo }, threadId, turnId, willRetry }` — the message is
      // ServerNotification__ErrorNotification / __TurnError). Reading a flat
      // `params.message` always missed it, so every real Codex error surfaced
      // as the generic "Codex reported an error."
      const errorRecord = asRecord(params)?.error;
      const message =
        readString(errorRecord, "message") ??
        readString(params, "message") ??
        "Codex reported an error.";
      const additionalDetails = readString(errorRecord, "additionalDetails");
      const fullMessage = additionalDetails ? `${message}\n${additionalDetails}` : message;
      // `willRetry` (schema: `error.willRetry`) means the app-server is going
      // to retry the turn itself — the session continues, so this is a warning,
      // `runtime.warning`). The notification's own `turnId` (schema:
      // `error.turnId`) is the turn in trouble — consume it instead of
      // guessing from activeTurnId, and seal that turn when the error is fatal.
      const willRetry = asRecord(params)?.willRetry === true;
      const turnId = readString(params, "turnId") ?? session.activeTurnId;
      if (willRetry || isNonFatalCodexError(fullMessage)) {
        this.emit({ ...this.base(session), type: "session.warning", message: fullMessage });
        return;
      }
      // Fatal: seal the turn the notification names (still live → failed), then
      // flip the session to error so the renderer surfaces it and the composer
      // stops pretending a turn is running.
      if (turnId && session.activeTurnId === turnId) {
        session.activeTurnId = undefined;
        this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "failed", message: fullMessage });
      }
      this.emit({ ...this.base(session), type: "session.state.changed", state: "error", message: fullMessage });
    });

    rpc.onNotification("model/rerouted", (params) => {
      // The app-server swapped the request to a different model mid-session
      // (e.g. an unavailable model falling back to the catalog default).
      // Surface it so the UI stops showing a stale model label.
      const fromModel = readString(params, "fromModel") ?? "unknown";
      const toModel = readString(params, "toModel") ?? "unknown";
      const reason = readString(params, "reason");
      if (session.model === toModel) return;
      session.model = toModel;
      const reroutedEvent: RuntimeEvent = {
        ...this.base(session),
        type: "model.rerouted",
        fromModel,
        toModel,
      };
      if (reason) reroutedEvent.reason = reason;
      this.emit(reroutedEvent);
    });
  }

  /** Every server-initiated approval request is parked and surfaced to the
   *  renderer (`approval.requested`), blocking the RPC handler until the user
   *  decides via respondToRequest — the decision becomes the `requestApproval`
   *  reply, so the action runs (or not) exactly as approved. Unhandled methods
   *  fall through to jsonRpc.ts's own "method not found" reply. Unlike the
   *  approval prompts, a user-input request is a real question for the human —
   *  park it for a renderer answer too. The handlers are async and jsonRpc.ts
   *  awaits their promises, so blocking here is the reply. */
  private wireRequests(session: CodexSession): void {
    const { rpc } = session;
    rpc.onRequest("item/commandExecution/requestApproval", (params) =>
      this.requestApproval(session, params, "command"),
    );
    rpc.onRequest("item/fileChange/requestApproval", (params) =>
      this.requestApproval(session, params, "file-change"),
    );
    rpc.onRequest("item/fileRead/requestApproval", (params) =>
      this.requestApproval(session, params, "file-read"),
    );
    rpc.onRequest("item/permissions/requestApproval", (params) =>
      this.requestApproval(session, params, "permission"),
    );
    rpc.onRequest("item/tool/requestUserInput", (params) => this.requestUserInput(session, params));
  }

  /** Park one Codex approval request: normalize the ask, emit
   *  `approval.requested`, and block the RPC handler on the resolver until the
   *  renderer answers (or we drain on interrupt/stop). The user's decision is
   *  mapped to Codex's own reply vocabulary. */
  private async requestApproval(
    session: CodexSession,
    params: unknown,
    kind: ApprovalRequestKind,
  ): Promise<{ decision: string }> {
    // Fail closed: a permission request with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — decline rather than park a gate nobody is watching.
    if (!session.activeTurnId) {
      return { decision: "decline" };
    }
    const requestId = randomUUID();
    const turnId = readString(params, "turnId") ?? session.activeTurnId;
    const approval = buildApprovalRequest(kind, params);
    const decision = await new Promise<ApprovalDecision>((resolve) => {
      session.pendingApprovals.set(requestId, { approval, resolve });
      this.emit({
        ...this.base(session),
        type: "approval.requested",
        requestId,
        turnId,
        approval,
      });
    });
    this.emit({ ...this.base(session), type: "approval.resolved", requestId, decision });
    return { decision: toCodexApprovalDecision(decision) };
  }

  /** Settle one parked approval (idempotent — a no-op once drained). */
  private resolveApproval(session: CodexSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked approval — on interrupt/stop so no RPC handler hangs
   *  and the renderer's pending prompt clears. */
  private drainApprovals(session: CodexSession): void {
    for (const [requestId] of session.pendingApprovals) {
      this.resolveApproval(session, requestId, "reject-once");
    }
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
    for (const [requestId] of session.pendingUserInputs) {
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
    this.emitItem(
      session,
      "item.completed",
      buffer,
      mapCodexItemStatus(readString(raw, "status"), Boolean(asRecord(raw.error))),
    );
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
    };
    if (buffer.tasks?.length) item.tasks = buffer.tasks;
    if (buffer.detail.length > 0) item.detail = buffer.detail;
    this.emit({ ...this.base(session), type, turnId, item });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  private base(session: CodexSession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "codex.rpc.notification" as const,
    };
    // See ClaudeAdapter.base: the resume id rides every envelope so a turn that
    // never completes still leaves the thread resumable.
    if (session.conversationId) {
      return { ...envelope, refs: { conversationId: session.conversationId } };
    }
    return envelope;
  }

  private toSession(session: CodexSession): Session {
    return {
      threadId: session.threadId,
      provider: this.provider,
      cwd: session.cwd,
      status: session.activeTurnId ? "running" : "ready",
      conversationId: session.conversationId,
      resumedFrom: session.resumedFrom,
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
