import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

import {
  CURSOR_BINARY,
  buildCursorEnv,
  buildCursorProbeEnv,
  parseCursorAuth,
  parseCursorCliModels,
  parseCursorVersion,
  resolveCursorBinary,
} from "../cursorHome.js";
import { JsonRpcClient } from "../jsonRpc.js";
import type { JsonObject, JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { formatPlanTasks, reconcilePlanTasks } from "@kone/protocol/plan-tasks";
import { isResumeRefusalError } from "./errors.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { acpAgentSupportsHttp, acpMcpServers } from "../gateway/injection.js";
import type { CursorImageBlock } from "../promptAttachments.js";
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
  Session,
  SendTurnInput,
  SessionStartInput,
  TokenUsage,
  TurnStartResult,
  UserInputAnswers,
} from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";

// Cursor adapter — drives `cursor-agent acp`, a persistent JSON-RPC-over-stdio
// child per thread speaking ACP (the Agent Client Protocol), reusing the same
// transport as CodexAdapter (jsonRpc.ts).
//
// `acp` is an undocumented subcommand — it doesn't appear in `cursor-agent
// --help` — but it is the transport that gives a real session, and everything
// below was verified live against cursor-agent 2026.07.23. The documented
// alternative,
// `--print --output-format stream-json`, is one-shot: it re-spawns per turn,
// can't be cancelled at the protocol level, and offers no permission
// round-trip. ACP gives a real session instead: mid-session model/mode
// switching, structured tool calls, server→client permission requests, and
// resume — which is what kone's ProviderAdapter contract is shaped around.
//
// "Bring your own subscription" holds: Cursor keeps its login in the OS
// keychain and kone never runs `cursor-agent login` — discover() only reads
// what `cursor-agent status` already reports.
//
// The ACP `session/request_permission` reverse request is parked and surfaced
// to the user via an `approval.requested` event (see wireRequests); the user's
// decision selects the reply option. The InteractionMode still matters too —
// it picks Cursor's *session mode*, which decides how often the agent is even
// allowed to ask.
//
// Protocol facts worth knowing before editing this file — all confirmed live,
// none of them guessable from the ACP spec:
//
//  1. A cancelled turn still resolves `session/prompt` with
//     `stopReason: "end_turn"`, not `"cancelled"`. The stop reason cannot tell
//     you a turn was interrupted, so we track our own `interrupting` flag
//     (same shape as OpenCodeAdapter's) and let that decide the terminal event.
//  2. `session/set_config_option` takes `configId` — not `configOptionId` — and
//     answers with the *entire* refreshed config matrix (mode, model, effort,
//     context, fast, thinking). There is no separate "list config options"
//     method; that response is the only way to *refresh* the matrix from a
//     session. The starting matrix is free: both `session/new` and
//     `session/load` carry a `configOptions` bag, and startSession must seed
//     `session.configOptions` from it — a session opened on the CLI's default
//     model never goes through set_model, so its model id is only knowable
//     from that starting matrix.
//  3. Declaring `_meta.parameterizedModelPicker` at initialize changes the
//     model catalog's shape: with it, `availableModels` are clean base ids
//     (`claude-opus-5`) whose axes are separate config options; without it the
//     axes are baked into the id (`claude-opus-5[thinking=true,effort=high]`)
//     and only the one advertised combination is selectable. We declare it —
//     kone's ModelDescriptor already models effort/tier/context as real axes.
//  4. `authenticate` is safe to call when the user is already logged in (it
//     answers `{}`), so it runs unconditionally on every session start.
//  5. Cursor advertises `loadSession: true` but no `sessionCapabilities.resume`,
//     so resuming a stored thread goes through `session/load`, never
//     `session/resume`.
//  6. There is no usage event over ACP at all. Across every live session on
//     2026.07.23 — multi-tool turns, big contexts, follow-up turns — no
//     `usage_update` notification ever fired, no `_meta` bag appeared on any
//     notification or result, and the `session/prompt` result was always bare
//     `{ "stopReason": "end_turn" }` even with usage-requesting extra params
//     (`usage: true`, `_meta.includeUsage`, `includeUsage: true`). The only
//     real usage Cursor exposes in-band is in the one-shot
//     `--print --output-format stream-json` result event (`usage.inputTokens` /
//     `outputTokens` / `cacheReadTokens` / `cacheWriteTokens`), which ACP does
//     not carry. But the numbers ARE on disk: `cursor-agent` writes a context
//     record to `~/.cursor/acp-sessions/<sessionId>/store.db` the moment a turn
//     resolves — a root blob whose trailing protobuf carries the session's
//     running context fill and window (parseStoredCursorContext). emitUsageFallback
//     reads it at turn end, so the ring gets real numbers instead of a 0% guess.

/** How this adapter's child is named in transport-level errors (JsonRpcClient
 *  is shared with Codex and Droid, so each names its own). */
const CURSOR_RPC_LABEL = "cursor-agent";

const CURSOR_INITIALIZE_PARAMS = {
  protocolVersion: 1,
  clientInfo: { name: "kone", title: "kone", version: "0.1.0" },
  clientCapabilities: {
    // kone doesn't proxy the filesystem or a terminal for the agent — Cursor
    // runs its own tools in the workspace it was spawned in.
    fs: { readTextFile: false, writeTextFile: false },
    terminal: false,
    _meta: { parameterizedModelPicker: true },
  },
} as const;

/** Cursor's only auth method id, from the `initialize` response. */
const CURSOR_AUTH_METHOD = "cursor_login";

/** Per-step startup budgets. `authenticate` gets the longest: it hits the OS
 *  keychain, which is normally instant but hangs indefinitely when it wants to
 *  show a prompt that a background GUI process can't put on screen. */
const INITIALIZE_TIMEOUT_MS = 20_000;
const AUTHENTICATE_TIMEOUT_MS = 30_000;
const SESSION_SETUP_TIMEOUT_MS = 20_000;
/** A turn runs as long as it needs to — `session/prompt` only settles when the
 *  agent is done — so the RPC deadline has to be far past any real turn. */
const PROMPT_TIMEOUT_MS = 24 * 60 * 60 * 1_000;
const CONFIG_TIMEOUT_MS = 15_000;

/** The config-option ids Cursor exposes per model, by kone axis. `effort` and
 *  `reasoning` are the same axis under two names (Anthropic/xAI bases call it
 *  effort, OpenAI bases call it reasoning). */
const EFFORT_OPTION_IDS = ["effort", "reasoning"];
const CONTEXT_OPTION_ID = "context";
const FAST_OPTION_ID = "fast";

type CursorItemBuffer = {
  itemId: string;
  kind: RuntimeItemKind;
  name?: string;
  text: string;
  detail: string;
  tasks?: PlanTask[];
};

type CursorSession = {
  threadId: string;
  cwd: string;
  model?: string;
  mode: InteractionMode;
  conversationId?: string;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  /** The kone gateway connection minted at startSession — the agent's app
   *  tools (kone_scratchpad_read/write via the gateway's MCP server). */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one.
   *  Rides the first prompt beside the host-context block (this provider has no
   *  system-instruction surface), so it is held here for that one turn. */
  agent?: AgentPersona;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  activeTurnId?: string;
  rpc: JsonRpcClient;
  items: Map<string, CursorItemBuffer>;
  /** Config options as Cursor last reported them — the source of truth for
   *  which axes this model actually has (see protocol fact 2). */
  configOptions: CursorConfigOption[];
  /** Session modes from `session/new`, used to resolve an InteractionMode onto
   *  a real mode id rather than assuming Cursor's spelling. */
  modeIds: string[];
  /** Set by interruptTurn so the turn's terminal event is `turn.aborted`
   *  despite Cursor reporting an ordinary `end_turn` (protocol fact 1). */
  interrupting: boolean;
  /** Whether a real `usage_update` notification arrived this turn. Cursor
   *  2026.07.23 emits none (protocol fact 6), so this is almost always false
   *  and the turn-end fallback in emitUsageFallback is what actually fires. */
  usageReported: boolean;
  /** Assistant/reasoning text arrives as bare chunks with no item identity, so
   *  we synthesize one segment per contiguous run and close it when the stream
   *  switches kind or a tool call interrupts it. */
  segment?: { itemId: string; kind: RuntimeItemKind };
  segmentCount: number;
  /** Items emitted as started/updated but never completed — a tool call that a
   *  cancel cut mid-flight would otherwise spin in the transcript forever. */
  openItemIds: Set<string>;
  /** In-flight `session/request_permission` round-trips, keyed by our
   *  requestId. The RPC handler awaits `promise`; respondToRequest resolves it
   *  (or we drain on interrupt/stop) — the decision selects the reply option. */
  pendingApprovals: Map<string, PendingApproval>;
};

/** A parked ACP permission request: the ask we surfaced and the resolver the
 *  awaited `session/request_permission` handler is blocked on. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
};

type CursorConfigOption = {
  id: string;
  name?: string;
  category?: string;
  currentValue?: string;
  options: { value: string; name?: string }[];
};

// ── small JSON helpers ───────────────────────────────────────────────────────

function asRecord(value: JsonValue): JsonObject | undefined {
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  return value && value instanceof Object && !Array.isArray(value) ? (value as JsonObject) : undefined;
}

function readString(value: JsonValue | null | undefined, ...path: string[]): string | undefined {
  let cursor: JsonValue | null | undefined = value;
  for (const key of path) cursor = asRecord(cursor)?.[key];
  if (
    cursor === undefined ||
    cursor === null ||
    cursor instanceof Object ||
    Number.isFinite(cursor) ||
    cursor === true ||
    cursor === false
  ) {
    return undefined;
  }
  return String(cursor);
}

function asArray(value: JsonValue | null | undefined): JsonValue[] {
  return Array.isArray(value) ? value : [];
}

/** Normalize an ACP `session/request_permission` payload into the neutral ask
 *  the renderer shows. The request names the tool call it wants to allow, so
 *  the headline is the command/title and the kind follows the tool family. */
function buildAcpApprovalRequest(params: JsonValue | null | undefined): ApprovalRequest {
  const toolCall = asRecord(asRecord(params)?.toolCall);
  const toolKind = readString(toolCall, "kind") ?? "";
  const kind: ApprovalRequestKind = /^bash$/i.test(toolKind)
    ? "command"
    : /^(edit|write|delete|move|create)$/i.test(toolKind)
      ? "file-change"
      : /^read$/i.test(toolKind)
        ? "file-read"
        : "permission";
  const title =
    readString(toolCall, "command")?.trim() ??
    readString(toolCall, "title")?.trim() ??
    "Request permission";
  const detail = readString(toolCall, "detail")?.trim();
  const request: ApprovalRequest = {
    kind,
    title,
  };
  if (detail) request.detail = detail;
  return request;
}

/** Pick the reply option for a decision, matching the option's `kind` prefix
 *  (`allow_once` / `allow_always` / `reject_once`) because the provider's
 *  optionIds are its own spellings. Reject falls back to any deny/reject/cancel
 *  option; `reject-and-stop` deliberately matches NOTHING — the provider gets a
 *  cancelled outcome and the adapter interrupts the turn (the ACP spell of
 *  undefined for "cancel"). No match returns undefined (a cancelled outcome). */
function selectPermissionOption(options: JsonValue[], decision: ApprovalDecision): string | undefined {
  if (decision === "reject-and-stop") return undefined;
  const wanted = decision === "allow-once" ? "allow_once" : decision === "allow-always" ? "allow_always" : "reject_once";
  const direct = options.find((option) => readString(option, "kind")?.startsWith(wanted));
  if (direct) return readString(direct, "optionId");
  if (decision === "reject-once") {
    const fallback = options.find((option) =>
      /^(deny|reject|cancel)/.test(readString(option, "kind") ?? ""),
    );
    if (fallback) return readString(fallback, "optionId");
  }
  return undefined;
}

/** Parse a Cursor config option (`{ id, name, category, currentValue, options:
 *  [{ value, name }] }`), tolerating the fields it omits. */
export function parseConfigOptions(value: JsonValue | null | undefined): CursorConfigOption[] {
  const out: CursorConfigOption[] = [];
  for (const raw of asArray(value)) {
    const id = readString(raw, "id");
    if (!id) continue;
    const options: { value: string; name?: string }[] = [];
    for (const rawOption of asArray(asRecord(raw)?.options)) {
      const optionValue = readString(rawOption, "value");
      if (!optionValue) continue;
      options.push({ value: optionValue, name: readString(rawOption, "name") });
    }
    out.push({
      id,
      name: readString(raw, "name"),
      category: readString(raw, "category"),
      currentValue: readString(raw, "currentValue"),
      options,
    });
  }
  return out;
}

function findOption(options: readonly CursorConfigOption[], ids: readonly string[]): CursorConfigOption | undefined {
  return options.find((option) => ids.includes(option.id));
}

export type CursorSessionSeed = {
  modeIds: string[];
  configOptions: CursorConfigOption[];
  defaultModel?: string;
};

/** Result of `cursor/list_available_models`: one row per model, verbatim wire
 *  data until toModelDescriptor projects it onto kone's axes. */
type AcpModelsResult = { models?: JsonValue[] };

/** The initialize result. kone consumes only
 *  `agentCapabilities.mcpCapabilities.http`, and it reads that through
 *  acpAgentSupportsHttp's own probing, so the envelope stays a JSON object. */
type AcpInitializeResult = JsonObject;

/** Shared shape of `session/new` / `session/load` results (protocol fact 2):
 *  the session id, the starting mode list, and the starting config matrix.
 *  Fields are optional because each was observed absent on at least one live
 *  response; consumers degrade per field. */
type AcpSessionResult = {
  sessionId?: string;
  modes?: { availableModes?: JsonValue[]; currentModeId?: string };
  configOptions?: JsonValue[];
};

/** Read the starting mode list and config matrix off a session/new or
 *  session/load response. A session opened on the CLI's default model never
 *  goes through set_model, so the model id (and later the context-window
 *  fallback) is only knowable from this matrix. An empty or missing bag is a
 *  valid response — later set_config_option / config_option_update still fill
 *  it — so this must not throw. */
export function seedFromSessionResponse(response: JsonValue | null | undefined): CursorSessionSeed {
  const record = asRecord(response);
  const modeIds = asArray(asRecord(asRecord(record)?.modes)?.availableModes)
    .map((raw) => readString(raw, "id"))
    .filter((id): id is string => id !== undefined);
  const configOptions = parseConfigOptions(record?.configOptions);
  const defaultModel = findOption(configOptions, ["model"])?.currentValue;
  const seed: CursorSessionSeed = {
    modeIds,
    configOptions,
  };
  if (defaultModel) seed.defaultModel = defaultModel;
  return seed;
}

/** Cursor names context windows `"300k"` / `"1m"` / `"272k"`. */
export function contextWindowTokens(value: string): number | undefined {
  const match = value.trim().toLowerCase().match(/^(\d+(?:\.\d+)?)\s*([km])$/);
  if (!match?.[1] || !match[2]) return undefined;
  const size = Number(match[1]);
  return match[2] === "m" ? Math.round(size * 1_000_000) : Math.round(size * 1_000);
}

/** The context-window budget kone can honestly claim for a session, in tokens:
 *  the live `context` config value when the current model exposes that axis
 *  (`"300k"` → 300_000), else the catalog's default window for the selected
 *  model id. Undefined when neither source knows a window — Cursor's ACP never
 *  reports usage (protocol fact 6), so this is the adapter's only real window. */
export function resolveContextWindow(
  configOptions: readonly CursorConfigOption[],
  modelContextWindows: ReadonlyMap<string, number> | undefined,
  modelId: string | undefined,
): number | undefined {
  const context = findOption(configOptions, [CONTEXT_OPTION_ID]);
  const live = context?.currentValue ? contextWindowTokens(context.currentValue) : undefined;
  if (live !== undefined) return live;
  return modelId === undefined ? undefined : modelContextWindows?.get(modelId);
}

/** Build the honest token-usage snapshot Cursor's ACP can actually support:
 *  the selected model's context window and nothing else. Cursor 2026.07.23
 *  emits no usage over ACP (protocol fact 6), so this is the adapter's real
 *  source of `thread.token-usage.updated` — and it deliberately carries no
 *  `contextUsed` or `total`, because inventing a fill or tally would be lying
 *  to the context ring. Undefined when no window is knowable. */
export function buildContextWindowFallback(
  configOptions: readonly CursorConfigOption[],
  modelContextWindows: ReadonlyMap<string, number> | undefined,
  modelId: string | undefined,
): TokenUsage | undefined {
  const contextWindow = resolveContextWindow(configOptions, modelContextWindows, modelId);
  if (contextWindow === undefined) return undefined;
  return { contextWindow, compactsAutomatically: true };
}

/** Read a protobuf varint. */
function readVarint(bytes: Uint8Array, state: { p: number }): number {
  let value = 0;
  let shift = 0;
  let byte = 0;
  do {
    byte = bytes[state.p++] ?? 0;
    value |= (byte & 0x7f) << shift;
    shift += 7;
  } while (byte & 0x80);
  return value >>> 0;
}

/** Skip the root blob's leading chain of `0a 20 <32-byte hash>` records (each
 *  a link to a transcript blob), returning the offset of the record content. */
function skipStoredBlobHeaders(bytes: Uint8Array): number {
  let p = 0;
  while (p + 2 <= bytes.length && bytes[p] === 0x0a && bytes[p + 1] === 0x20) p += 34;
  return p;
}

/** Decode the context-usage record `cursor-agent` persists for an ACP session.
 *  The session store (`~/.cursor/acp-sessions/<sessionId>/store.db`) keeps one
 *  blob per message plus a root blob that chains them; the root's trailing
 *  protobuf record carries field 5 = { field 1: tokens currently in context,
 *  field 2: context-window size in tokens, field 3: per-section breakdown }.
 *  Live captures from 2026.07.23 confirm it is written the moment a turn
 *  resolves and is a per-session running total (grows turn to turn). Returns
 *  the numbers, or undefined when the format doesn't match — a future
 *  `cursor-agent` build may stop writing it, and the adapter falls back. */
export function parseStoredCursorContext(
  data: Uint8Array,
): { used: number; window: number } | undefined {
  const start = skipStoredBlobHeaders(data);
  const st = { p: start };
  while (st.p < data.length) {
    const tag = readVarint(data, st);
    const field = tag >>> 3;
    const wire = tag & 7;
    if (wire === 2) {
      const len = readVarint(data, st);
      const end = st.p + len;
      const sub = data.slice(st.p, end);
      st.p = end;
      if (field === 5) {
        const s2 = { p: 0 };
        let used: number | undefined;
        let window: number | undefined;
        while (s2.p < sub.length) {
          const t = readVarint(sub, s2);
          const f = t >>> 3;
          const w = t & 7;
          if (w === 0) {
            const v = readVarint(sub, s2);
            if (f === 1) used = v;
            else if (f === 2) window = v;
          } else if (w === 2) {
            const l = readVarint(sub, s2);
            s2.p += l;
          } else break;
        }
        // Sanity: the window must look like a real token budget and the fill
        // must fit inside it. Anything else means the format shifted.
        if (
          window !== undefined &&
          window !== null &&
          Number.isFinite(window) &&
          window >= 10_000 &&
          window <= 10_000_000 &&
          used !== undefined &&
          used !== null &&
          Number.isFinite(used) &&
          used >= 0 &&
          used <= window
        ) {
          return { used, window };
        }
        return undefined;
      }
    } else if (wire === 0) {
      readVarint(data, st);
    } else if (wire === 5) {
      st.p += 4;
    } else if (wire === 1) {
      st.p += 8;
    } else {
      return undefined;
    }
  }
  return undefined;
}

/** Project one `cursor/list_available_models` entry onto kone's ModelDescriptor.
 *  Cursor's `configOptions` are already exactly kone's three model axes — effort,
 *  context window, and a speed tier — under different names. The fourth axis,
 *  `thinking` (a plain on/off that only some Anthropic bases carry), has no
 *  ModelDescriptor equivalent, so it keeps Cursor's own default. */
export function toModelDescriptor(raw: JsonValue | null | undefined): ModelDescriptor | undefined {
  const id = readString(raw, "value");
  if (!id) return undefined;
  const configOptions = parseConfigOptions(asRecord(raw)?.configOptions);
  const descriptor: ModelDescriptor = { id, label: readString(raw, "name")?.trim() || id };

  const effort = findOption(configOptions, EFFORT_OPTION_IDS);
  if (effort && effort.options.length > 0) {
    descriptor.reasoningEfforts = effort.options.map((option) => option.value);
    if (effort.currentValue) descriptor.defaultReasoningEffort = effort.currentValue;
  }

  const context = findOption(configOptions, [CONTEXT_OPTION_ID]);
  if (context && context.options.length > 0) {
    const windows = context.options.flatMap((option) => {
      const tokens = contextWindowTokens(option.value);
      if (tokens === undefined) return [];
      const entry = {
        id: option.value,
        label: option.name?.trim() || option.value.toUpperCase(),
        tokens,
      };
      return option.value === context.currentValue ? [{ ...entry, isDefault: true }] : [entry];
    });
    if (windows.length > 0) descriptor.contextWindows = windows;
    const current = windows.find((window) => "isDefault" in window && window.isDefault);
    if (current) descriptor.contextWindowTokens = current.tokens;
  }

  // `fast` is a boolean dressed as a select — only the "on" side is a tier.
  const fast = findOption(configOptions, [FAST_OPTION_ID]);
  if (fast?.options.some((option) => option.value === "true")) {
    descriptor.serviceTiers = [
      { id: "fast", label: "Fast", description: "Significantly faster, consumes more usage" },
    ];
  }

  return descriptor;
}

// ── mode → Cursor session mode ───────────────────────────────────────────────
// Cursor ships three session modes: `agent` (full tool access), `plan`
// (read-only, produces a plan), and `ask` (Q&A, no edits or commands). kone's
// ladder has no plan/build axis, so only two rungs are reachable HERE: `ask` is
// kone's read-only rung, everything looser is `agent`. The upper rungs
// (`accept-edits` / `full-access`) are NOT distinguished by mode id — Cursor
// has no rung between read-only and full agent, and ACP's own permission
// rungs cover the difference: `accept-edits` parks request_permission gates for
// a human, while `full-access` short-circuits them via the full-access
// short-circuit in requestPermission. Mode ids come from `session/new` rather
// than being hard-coded, with aliases so a renamed or reordered mode list still
// resolves.

const READ_ONLY_MODE_ALIASES = ["ask", "plan", "architect"];
const AGENT_MODE_ALIASES = ["agent", "code", "default", "chat", "implement"];

export function resolveModeId(mode: InteractionMode, available: readonly string[]): string | undefined {
  const preferred = mode === "ask" ? READ_ONLY_MODE_ALIASES : AGENT_MODE_ALIASES;
  const fallback = mode === "ask" ? AGENT_MODE_ALIASES : READ_ONLY_MODE_ALIASES;
  return (
    preferred.find((alias) => available.includes(alias)) ??
    fallback.find((alias) => available.includes(alias)) ??
    available[0]
  );
}

// ── tool-call presentation ───────────────────────────────────────────────────

/** ACP tool kinds → the canonical tool keyword kone's thread UI understands.
 *  Keep these in sync with ConversationThread.vue's TOOL_TABLE vocabulary, the
 *  same contract CodexAdapter's toRuntimeItemKind honors. */
const TOOL_KIND_NAMES: Record<string, string> = {
  read: "read_file",
  edit: "edit_file",
  delete: "edit_file",
  move: "edit_file",
  execute: "run",
  search: "search",
  fetch: "web_search",
  think: "tool",
  switch_mode: "tool",
  other: "tool",
};

/** Body of an ACP `tool_call` / `tool_call_update` update, minus the
 *  `sessionUpdate` discriminator. `rawInput`/`rawOutput` stay raw JSON — tool
 *  arguments are whatever the agent sent — and are probed at the edge rather
 *  than trusted. */
export type AcpToolCallUpdate = {
  toolCallId?: string;
  kind?: string;
  title?: string;
  status?: string;
  rawInput?: JsonObject;
  rawOutput?: JsonObject;
  content?: JsonValue[];
  locations?: JsonValue[];
};

/** The `entries` bag of an ACP `plan` update, verbatim from the wire — the
 *  plan schema is undocumented, so entries are probed field by field. */
export type AcpPlanUpdate = { entries?: JsonValue[] };

/** A short, human inline target for a tool row: the command, path, or query —
 *  never the tool's own name, which travels separately as `name`. */
export function toolCallTarget(update: AcpToolCallUpdate): string {
  const rawInput = asRecord(update.rawInput);
  const command = readString(rawInput, "command");
  if (command) return command;

  const path = readString(rawInput, "path") ?? readString(rawInput, "file_path");
  if (path) return path;

  const query = readString(rawInput, "query") ?? readString(rawInput, "pattern") ?? readString(rawInput, "url");
  if (query) return query;

  const locations = asArray(update.locations);
  const firstPath = locations.length > 0 ? readString(locations[0], "path") : undefined;
  if (firstPath) return locations.length > 1 ? `${firstPath} +${locations.length - 1} more` : firstPath;

  return update.title ?? "";
}

/** The expandable body of a tool row. ACP puts results in `rawOutput` and/or a
 *  `content` array of text/diff/resource blocks. */
export function toolCallDetail(update: AcpToolCallUpdate): string {
  const parts: string[] = [];
  for (const block of asArray(update.content)) {
    const text = readString(block, "content", "text") ?? readString(block, "text");
    if (text) parts.push(text);
  }
  const rawOutput = asRecord(update.rawOutput);
  if (rawOutput) {
    const output = readString(rawOutput, "content") ?? readString(rawOutput, "output") ?? readString(rawOutput, "stdout");
    if (output) parts.push(output);
    else parts.push(JSON.stringify(rawOutput, null, 2));
  }
  return parts.join("\n").trim();
}

export function toolCallStatus(raw: string | undefined): RuntimeItemStatus {
  if (raw === "completed") return "completed";
  if (raw === "failed") return "failed";
  return "in-progress";
}

/** ACP plan entries are `{ content, status }` with `in_progress` spelled with
 *  an underscore; kone's PlanTaskStatus uses a hyphen. */
export function parseAcpPlan(update: AcpPlanUpdate): Omit<PlanTask, "id">[] | undefined {
  const entries = asArray(update.entries);
  if (entries.length === 0) return undefined;
  const out: Omit<PlanTask, "id">[] = [];
  for (const entry of entries) {
    const content = readString(entry, "content")?.trim();
    if (!content) continue;
    const rawStatus = readString(entry, "status");
    const status =
      rawStatus === "completed" ? "completed" : rawStatus === "in_progress" ? "in-progress" : "pending";
    out.push({ content, status });
  }
  return out.length > 0 ? out : undefined;
}

// ── session/update dispatch ─────────────────────────────────────────────────
// ACP streams session progress as `session/update` notifications whose body is
// discriminated by `sessionUpdate`. The variants below are the kinds captured
// live on 2026.07.23; anything else is dropped at the gate in
// wireNotifications — exactly what this switch's old default branch did.

type AcpTextChunkUpdate = {
  sessionUpdate: "agent_message_chunk" | "agent_thought_chunk";
  content?: { type?: string; text?: string };
};

type AcpToolCallNotification = { sessionUpdate: "tool_call" | "tool_call_update" } & AcpToolCallUpdate;

type AcpPlanNotification = { sessionUpdate: "plan" } & AcpPlanUpdate;

type AcpUsageNotification = { sessionUpdate: "usage_update"; used?: number; size?: number };

type AcpSessionInfoNotification = { sessionUpdate: "session_info_update"; title?: string };

type AcpConfigOptionsNotification = {
  sessionUpdate: "config_option_update";
  configOptions?: JsonValue[];
};

/** Kinds kone recognizes but does not act on yet — `user_message_chunk` (the
 *  renderer owns the user's own message) plus session-state updates. */
type AcpIgnoredUpdate = {
  sessionUpdate: "user_message_chunk" | "current_mode_update" | "available_commands_update";
};

type AcpSessionUpdate =
  | AcpTextChunkUpdate
  | AcpToolCallNotification
  | AcpPlanNotification
  | AcpUsageNotification
  | AcpSessionInfoNotification
  | AcpConfigOptionsNotification
  | AcpIgnoredUpdate;

const SESSION_UPDATE_KINDS: ReadonlySet<string> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call",
  "tool_call_update",
  "plan",
  "usage_update",
  "session_info_update",
  "config_option_update",
  "user_message_chunk",
  "current_mode_update",
  "available_commands_update",
]);

/** Gate for an incoming `session/update` body. Recognizing the discriminator
 *  is the whole validation: every field across every variant is optional, so
 *  any object carrying a known kind satisfies its variant. */
function isAcpSessionUpdate(value: JsonObject): value is AcpSessionUpdate {
  return Boolean(value.sessionUpdate && !(value.sessionUpdate instanceof Object) && SESSION_UPDATE_KINDS.has(String(value.sessionUpdate)));
}

/** Token counts as Cursor spells them over ACP: camelCase today, with the
 *  snake_case spellings of the one-shot `--print` stream kept alongside in
 *  case a provider routed through ACP uses those. */
type AcpUsageCounts = {
  inputTokens?: number;
  input_tokens?: number;
  outputTokens?: number;
  output_tokens?: number;
  totalTokens?: number;
  total_tokens?: number;
  cacheReadTokens?: number;
  cache_read_tokens?: number;
  cacheWriteTokens?: number;
  cache_write_tokens?: number;
  reasoningTokens?: number;
  reasoning_tokens?: number;
};

/** Result of `session/prompt`: bare `stopReason` today (protocol fact 6), with
 *  speculative usage bags — top-level and `_meta`-wrapped — kept defensively
 *  for a build that starts carrying them. */
type AcpPromptResult = {
  stopReason?: string;
  usage?: AcpUsageCounts;
  _meta?: { usage?: AcpUsageCounts };
};

export class CursorAdapter implements ProviderAdapter {
  readonly provider = "cursor" as const;
  readonly capabilities: AdapterCapabilities = {
    // `session/set_model` and `session/set_config_option` both take effect on a
    // live session, so a model switch never costs the conversation.
    sessionModelSwitch: "in-session",
    streamsText: true,
    supportsToolEvents: true,
    supportsResume: true,
    supportsModelList: true,
    // Cursor's ACP surface reports one flat stream of tool calls — a delegated
    // sub-agent, if it spawns one, isn't distinguishable as a nested run.
    supportsSubagents: false,
  };

  private readonly emit: EmitEvent;
  private readonly sessions = new Map<string, CursorSession>();
  private modelsCache: Promise<ModelDescriptor[]> | null = null;
  /** Model id → default context-window tokens, populated from
   *  `cursor/list_available_models`. Cursor reports no live usage over ACP
   *  (protocol fact 6), so this is the honest fallback source for the
   *  token-usage event's `contextWindow` (see emitUsageFallback). */
  private readonly modelContextWindows = new Map<string, number>();
  /** The CLI executable to spawn — the user's override or `cursor-agent`. */
  private binary = CURSOR_BINARY;

  constructor(emit: EmitEvent) {
    this.emit = emit;
  }

  setConfig(config: ProviderConfig): void {
    const next = resolveCursorBinary(config.binaryPath);
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
    this.modelContextWindows.clear();
  }

  // ── discovery ─────────────────────────────────────────────────────────────

  async discover(): Promise<ProviderStatus> {
    const env = await buildCursorProbeEnv();
    const versionOutput = await probe(this.binary, ["--version"], env, 5_000);
    if (versionOutput === null) {
      return {
        provider: this.provider,
        label: "Cursor",
        available: false,
        authStatus: "unknown",
        readiness: "not-installed",
        message: "Cursor CLI not found. Install it and run `cursor-agent login`.",
      };
    }

    const version = parseCursorVersion(versionOutput);
    const statusOutput = await probe(this.binary, ["status"], env, 10_000);
    const auth = parseCursorAuth(statusOutput ?? "");
    if (!auth.authenticated) {
      return {
        provider: this.provider,
        label: "Cursor",
        available: true,
        authStatus: "unauthenticated",
        readiness: "needs-login",
        version,
        message: "Run `cursor-agent login` to sign in.",
      };
    }

    return {
      provider: this.provider,
      label: "Cursor",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
      version,
      authLabel: auth.label,
    };
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.modelsCache) {
      this.modelsCache = this.fetchModels().catch((cause: unknown) => {
        this.modelsCache = null;
        throw cause;
      });
    }
    return this.modelsCache;
  }

  /** Prefer Cursor's ACP catalog (`cursor/list_available_models`): it reports
   *  each model once with its axes as real config options. The flat
   *  `cursor-agent models` CLI list is the fallback — it expands every axis
   *  combination into its own row (`…-high`, `…-fast`) and pins one context
   *  window, so a picker built from it can't offer the axes as choices. */
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildCursorEnv();
    const rpc = new JsonRpcClient(this.binary, ["acp"], { cwd: homedir(), env, label: CURSOR_RPC_LABEL });
    try {
      await rpc.call("initialize", CURSOR_INITIALIZE_PARAMS, INITIALIZE_TIMEOUT_MS);
      await this.authenticate(rpc);
      const response = await rpc.call<AcpModelsResult>("cursor/list_available_models", {}, CONFIG_TIMEOUT_MS);
      const models = asArray(response.models)
        .map((raw) => toModelDescriptor(raw))
        .filter((model): model is ModelDescriptor => model !== undefined);
      for (const model of models) {
        if (model.contextWindowTokens !== undefined) {
          this.modelContextWindows.set(model.id, model.contextWindowTokens);
        }
      }
      if (models.length > 0) return models;
    } catch {
      // Fall through to the CLI list below.
    } finally {
      await rpc.kill();
    }

    const probeEnv = await buildCursorProbeEnv();
    const output = await probe(this.binary, ["models"], probeEnv, 15_000);
    return output === null ? [] : parseCursorCliModels(output);
  }

  // ── lifecycle ────────────────────────────────────────────────────────────

  async startSession(input: SessionStartInput): Promise<Session> {
    // Retire whatever this thread already owns before spawning its replacement —
    // the map is overwritten unconditionally below, so the previous `cursor acp`
    // child would otherwise never be killed. See CodexAdapter for the same guard.
    if (this.sessions.has(input.threadId)) await this.stopSession(input.threadId);

    const env = await buildCursorEnv();
    const rpc = new JsonRpcClient(this.binary, ["acp"], { cwd: input.cwd, env, label: CURSOR_RPC_LABEL });
    const mode: InteractionMode = input.mode ?? "accept-edits";

    const session: CursorSession = {
      threadId: input.threadId,
      cwd: input.cwd,
      model: input.model,
      mode,
      rpc,
      items: new Map(),
      configOptions: [],
      modeIds: [],
      gatewayConnection: input.gatewayConnection,
      agent: input.agent,
      runOrdinal: 0,
      interrupting: false,
      usageReported: false,
      segmentCount: 0,
      openItemIds: new Set(),
      pendingApprovals: new Map(),
    };
    this.wireNotifications(session);
    this.wireRequests(session);
    rpc.onExit((code) => {
      // Only the session the map still points at may retire the entry; a
      // replacement can claim this threadId while this child shuts down. No
      // entry means stopSession already took ours, so still announce the exit.
      const current = this.sessions.get(input.threadId);
      if (current && current !== session) {
        // A replacement owns the thread now — the old session's parked asks
        // still die with it.
        this.drainApprovals(session);
        return;
      }
      if (current) this.sessions.delete(input.threadId);
      // Fail closed on the way out: resolve every parked permission request as
      // rejected so no RPC handler hangs on a promise nothing will settle.
      this.drainApprovals(session);
      this.emit({ ...this.base(session), source: "cursor.acp.lifecycle", type: "session.exited", code });
    });

    try {
      const initializeResult = await rpc.call<AcpInitializeResult>(
        "initialize",
        CURSOR_INITIALIZE_PARAMS,
        INITIALIZE_TIMEOUT_MS,
      );
      await this.authenticate(rpc);

      // The kone gateway (docs/mcp-gateway-design.md §4): thread the app's MCP
      // server into every session door. An agent that advertises
      // `agentCapabilities.mcpCapabilities.http` gets the direct loopback HTTP
      // entry; otherwise Cursor spawns the stdio proxy (stdioProxy.mjs), which
      // forwards JSON-RPC to the same endpoint. No gateway connection → no
      // mcpServers at all — never promise tools the session can't reach.
      const mcpServers = input.gatewayConnection
        ? acpMcpServers(input.gatewayConnection, {
            httpCapable: acpAgentSupportsHttp(initializeResult),
          })
        : [];

      // Resuming replays the prior conversation into the same session id.
      // Cursor advertises `loadSession`, not `resume`, so `session/load` is the
      // only door (protocol fact 5). A refused load means the session is gone
      // from Cursor's store — start fresh rather than failing the thread open,
      // matching how CodexAdapter degrades a stale `thread/resume`.
      let response: AcpSessionResult | undefined;
      if (input.resume) {
        try {
          response = await rpc.call<AcpSessionResult>(
            "session/load",
            { sessionId: input.resume, cwd: input.cwd, mcpServers },
            SESSION_SETUP_TIMEOUT_MS,
          );
          session.conversationId = input.resume;
          session.resumedFrom = input.resume;
        } catch (error) {
          // Only a refusal-class failure (session gone from Cursor's store)
          // deserves the fresh-session fallback — a transport or protocol
          // error must surface, or the thread would reopen blank for no
          // reason. Same gate CodexAdapter now applies to `thread/resume`.
          if (!isResumeRefusalError(error)) throw error;
          response = undefined;
        }
      }
      if (!response) {
        response = await rpc.call<AcpSessionResult>(
          "session/new",
          { cwd: input.cwd, mcpServers },
          SESSION_SETUP_TIMEOUT_MS,
        );
        const sessionId = response.sessionId;
        if (!sessionId) throw new Error("session/new response did not include a session id.");
        session.conversationId = sessionId;
      }

      // `modes: { currentModeId, availableModes: [{ id, name }] }` plus the
      // starting `configOptions` matrix — seeding the matrix is what lets the
      // default-model read below (and toSession's effort) actually fire
      // (protocol fact 2).
      const seeded = seedFromSessionResponse(response);
      session.modeIds = seeded.modeIds;
      session.configOptions = seeded.configOptions;

      await this.applyMode(session, mode);
      if (input.model) await this.applyModel(session, input.model);
      if (input.effort) await this.applyConfigOption(session, EFFORT_OPTION_IDS, input.effort);
      // A session started on the CLI's default model never went through
      // applyModel, so `session.model` is still unset — read it from the config
      // matrix (the `model` option's currentValue) so the usage fallback can
      // resolve its context window.
      if (!session.model) {
        const modelOption = findOption(session.configOptions, ["model"]);
        if (modelOption?.currentValue) session.model = modelOption.currentValue;
      }
    } catch (error) {
      await rpc.kill();
      throw error;
    }

    // Warm the model catalog (one-time, cached) so emitUsageFallback can resolve
    // the selected model's context window even when the picker was never opened.
    // Fire-and-forget: it must not hold up the session that's already live.
    void this.listModels().catch(() => {});

    this.sessions.set(input.threadId, session);
    this.emit({ ...this.base(session), source: "cursor.acp.lifecycle", type: "session.started" });
    return this.toSession(session);
  }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.requireSession(input.threadId);
    const mode = input.mode ?? session.mode;

    // Imported at call time, and only when there's something to attach, like
    // OpenCodeAdapter does: promptAttachments reaches the attachment store,
    // which pulls in node:sqlite — statically importing it would make this
    // module unloadable outside the Electron runtime.
    let imageBlocks: CursorImageBlock[] = [];
    let promptText = input.input.trim();
    if (input.attachments?.length) {
      const attachments = await import("../promptAttachments.js");
      const built = await attachments.buildCursorAttachmentInput(input.attachments);
      imageBlocks = built.imageBlocks;
      promptText = attachments.composePromptText(promptText, built.fileBlock ?? "");
    }
    // prependT3OrchestrationInstructions pattern — the same wiring as
    // OpenCodeAdapter): the app-context block rides the very first user turn
    // so the agent knows the gateway tools exist.
    promptText = koneHostContextForFirstRun({
      prompt: promptText,
      runOrdinal: session.runOrdinal + 1,
      gatewayControlAvailable: session.gatewayConnection !== undefined,
      agent: session.agent,
    });
    session.runOrdinal += 1;
    const prompt: Array<{ type: "text"; text: string } | CursorImageBlock> = [];
    if (promptText.length > 0) prompt.push({ type: "text", text: promptText });
    prompt.push(...imageBlocks);
    if (prompt.length === 0) {
      throw new Error("Turn input must include text or an attachment.");
    }

    // Cursor holds mode/model/effort on the session, not the turn, so re-assert
    // whatever this turn asked for before prompting. Each is best-effort: an
    // unavailable model or effort degrades to the session's current value
    // rather than failing a turn the user already sent.
    if (mode !== session.mode) await this.applyMode(session, mode);
    session.mode = mode;
    if (input.model && input.model !== session.model) await this.applyModel(session, input.model);
    if (input.effort) await this.applyConfigOption(session, EFFORT_OPTION_IDS, input.effort);
    if (input.serviceTier !== undefined) {
      await this.applyConfigOption(session, [FAST_OPTION_ID], input.serviceTier === "fast" ? "true" : "false");
    }
    if (input.contextWindow) await this.applyConfigOption(session, [CONTEXT_OPTION_ID], input.contextWindow);

    // kone mints the turn id: Cursor's ACP has no turn identity at all (a turn
    // is just one `session/prompt` round-trip), and a per-session counter would
    // collide across threads in the shared store.
    const turnId = `cursor-turn-${randomUUID()}`;
    session.activeTurnId = turnId;
    session.interrupting = false;
    session.usageReported = false;
    this.emit({ ...this.base(session), type: "turn.started", turnId });

    // `session/prompt` only settles when the whole turn is done, so it is
    // deliberately not awaited here — sendTurn is request/ack.
    void session.rpc
      .call<AcpPromptResult>(
        "session/prompt",
        { sessionId: session.conversationId, prompt },
        PROMPT_TIMEOUT_MS,
      )
      .then(
        (response) => this.completeTurn(session, turnId, response),
        (cause: unknown) => this.failTurn(session, turnId, cause),
      );

    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session?.activeTurnId || !session.conversationId) return;
    this.drainApprovals(session);
    // Flag first: the cancel lands as an ordinary `end_turn` (protocol fact 1),
    // and only this flag tells completeTurn which terminal event to emit.
    session.interrupting = true;
    session.rpc.notify("session/cancel", { sessionId: session.conversationId });
  }

  async stopSession(threadId: string): Promise<void> {
    const session = this.sessions.get(threadId);
    if (!session) return;
    this.drainApprovals(session);
    this.abortLiveTurn(session);
    this.sessions.delete(threadId);
    await session.rpc.kill();
  }

  /** Seal a turn that's still live as we tear the session down. Killing the
   *  transport means Cursor's `session/cancel` reply never arrives, so nothing
   *  else will ever speak for this turn — without this the journaled assistant
   *  block stays 'running' forever and the thread reopens permanently busy.
   *  See CodexAdapter for the same guard. */
  private abortLiveTurn(session: CursorSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    session.activeTurnId = undefined;
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
  }

  async stopAll(): Promise<void> {
    const kills: Promise<void>[] = [];
    for (const session of this.sessions.values()) {
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
    // "Reject and stop" — the parked call resolves with a cancelled outcome
    // (selectPermissionOption matched nothing) and the TURN is interrupted, not
    // just the call. Same session/cancel the interrupt path sends; drain's
    // reject-once resolves are idempotent, so firing after the specific resolve
    // is safe.
    if (decision === "reject-and-stop") void this.interruptTurn(threadId);
  }

  async respondToUserInput(_threadId: string, _requestId: string, _answers: UserInputAnswers): Promise<void> {
    // Cursor's mid-turn question extension (`cursor/ask_question`) isn't wired
    // in kone v1 — nothing parks a question, so there's nothing to resolve.
  }

  async listSessions(): Promise<Session[]> {
    return [...this.sessions.values()].map((session) => this.toSession(session));
  }

  async hasSession(threadId: string): Promise<boolean> {
    return this.sessions.has(threadId);
  }

  // ── session configuration ────────────────────────────────────────────────

  /** Cursor answers `{}` when the keychain login is already good, so this is
   *  safe to run on every start (protocol fact 4). A hard failure here is the
   *  real "not logged in" signal and must surface. */
  private async authenticate(rpc: JsonRpcClient): Promise<void> {
    await rpc.call(
      "authenticate",
      { methodId: CURSOR_AUTH_METHOD, _meta: { headless: true } },
      AUTHENTICATE_TIMEOUT_MS,
    );
  }

  private async applyMode(session: CursorSession, mode: InteractionMode): Promise<void> {
    const modeId = resolveModeId(mode, session.modeIds);
    if (!modeId) return;
    try {
      await session.rpc.call(
        "session/set_mode",
        { sessionId: session.conversationId, modeId },
        CONFIG_TIMEOUT_MS,
      );
    } catch (error) {
      this.warn(session, `Cursor rejected session mode "${modeId}"`, error);
    }
  }

  private async applyModel(session: CursorSession, model: string): Promise<void> {
    try {
      await session.rpc.call(
        "session/set_model",
        { sessionId: session.conversationId, modelId: model },
        CONFIG_TIMEOUT_MS,
      );
      session.model = model;
    } catch (error) {
      // -32602 "Invalid model value" — the model isn't offered to this account.
      // Degrade to whatever the session is already on rather than losing the turn.
      this.warn(session, `Cursor rejected model "${model}"`, error);
    }
  }

  /** Set one model axis (effort/context/fast) by config id, ignoring axes this
   *  model doesn't have. The response carries the refreshed matrix, which is
   *  the only way to read it back (protocol fact 2). */
  private async applyConfigOption(
    session: CursorSession,
    ids: readonly string[],
    value: string,
  ): Promise<void> {
    const configId = findOption(session.configOptions, ids)?.id ?? ids[0];
    if (!configId) return;
    try {
      const response = await session.rpc.call<AcpSessionResult>(
        "session/set_config_option",
        { sessionId: session.conversationId, configId, value },
        CONFIG_TIMEOUT_MS,
      );
      const refreshed = parseConfigOptions(response.configOptions);
      if (refreshed.length > 0) session.configOptions = refreshed;
    } catch (error) {
      this.warn(session, `Cursor rejected ${configId}="${value}"`, error);
    }
  }

  // ── notifications / server requests ─────────────────────────────────────

  private wireNotifications(session: CursorSession): void {
    const { rpc } = session;

    rpc.onNotification("session/update", (params) => {
      const update = asRecord(asRecord(params)?.update);
      // Unrecognized kinds — including anything Cursor adds later — drop here,
      // exactly where the dispatch's old default branch ignored them.
      if (!update || !isAcpSessionUpdate(update)) return;
      this.handleSessionUpdate(session, update);
    });

    rpc.onStderrLine((line) => {
      const text = line.trim();
      if (text.length === 0) return;
      this.emit({
        ...this.base(session),
        source: "cursor.acp.stderr",
        type: "session.state.changed",
        state: "running",
        message: text,
      });
    });
  }

  private wireRequests(session: CursorSession): void {
    // A permission request is parked and surfaced to the user via
    // `approval.requested`; the user's decision selects the reply option by its
    // `kind` because Cursor's optionIds are its own spellings.
    session.rpc.onRequest("session/request_permission", (params) =>
      this.requestPermission(session, params),
    );
  }

  /** Park one ACP permission request: normalize the ask, emit
   *  `approval.requested`, and block the RPC handler on the resolver until the
   *  renderer answers (or we drain on interrupt/stop). The decision selects the
   *  option by kind (`allow_once` / `allow_always` / `reject_once`), falling
   *  back to a cancelled outcome when none matches. */
  private async requestPermission(
    session: CursorSession,
    params: JsonValue | null | undefined,
  ): Promise<{ outcome: { outcome: string; optionId?: string } }> {
    const options = asArray(asRecord(params)?.options);
    // Fail closed: a permission request with no active turn (a recovery or
    // replay callback after a crash/interrupt) has no trustworthy mode behind
    // it — cancel rather than park a gate nobody is watching.
    if (!session.activeTurnId) {
      return { outcome: { outcome: "cancelled" } };
    }
    // Full Access never stops to ask: select an allow option (the persistent
    // allow_always rung first, then the request-scoped allow_once) and return
    // selectAcpFullAccessPermissionOptionId — a full-access child on a provider
    // exposing only the protocol's persistent allow option must stay
    // operational, and a full-access session must never deadlock on a gate.
    if (session.mode === "full-access") {
      const optionId =
        selectPermissionOption(options, "allow-always") ??
        selectPermissionOption(options, "allow-once");
      return optionId
        ? { outcome: { outcome: "selected", optionId } }
        : { outcome: { outcome: "cancelled" } };
    }
    const requestId = randomUUID();
    const turnId = session.activeTurnId;
    const approval = buildAcpApprovalRequest(params);
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
    const optionId = selectPermissionOption(options, decision);
    return optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } };
  }

  /** Settle one parked permission request (idempotent — a no-op once drained). */
  private resolveApproval(session: CursorSession, requestId: string, decision: ApprovalDecision): void {
    const pending = session.pendingApprovals.get(requestId);
    if (!pending) return;
    session.pendingApprovals.delete(requestId);
    pending.resolve(decision);
  }

  /** Reject every parked permission request — on interrupt/stop so no RPC
   *  handler hangs and the renderer's pending prompt clears. */
  private drainApprovals(session: CursorSession): void {
    for (const [requestId] of session.pendingApprovals) {
      this.resolveApproval(session, requestId, "reject-once");
    }
  }

  private handleSessionUpdate(session: CursorSession, update: AcpSessionUpdate): void {
    switch (update.sessionUpdate) {
      case "agent_message_chunk":
        this.appendText(session, "assistant_text", update.content?.text);
        return;
      case "agent_thought_chunk":
        this.appendText(session, "reasoning_text", update.content?.text);
        return;
      case "tool_call":
      case "tool_call_update":
        this.handleToolCall(session, update);
        return;
      case "plan":
        this.handlePlan(session, update);
        return;
      case "usage_update":
        this.handleUsage(session, update);
        return;
      case "session_info_update": {
        // Cursor names the conversation itself once it has read the first
        // prompt — a better title than anything kone could infer, and free.
        const title = update.title?.trim();
        if (title) this.emit({ ...this.base(session), type: "thread.title.updated", title });
        return;
      }
      case "config_option_update": {
        const refreshed = parseConfigOptions(update.configOptions);
        if (refreshed.length > 0) session.configOptions = refreshed;
        return;
      }
      default:
        // user_message_chunk / current_mode_update / available_commands_update.
        return;
    }
  }

  /** Assistant and reasoning text stream as bare chunks with no item id, so a
   *  contiguous run of one kind becomes one synthetic item. A switch of kind —
   *  or a tool call landing between chunks — closes the open segment, which is
   *  what makes the transcript read in true arrival order. */
  private appendText(session: CursorSession, kind: RuntimeItemKind, text: string | undefined): void {
    if (!text || !session.activeTurnId) return;

    if (session.segment && session.segment.kind !== kind) this.closeSegment(session);

    if (!session.segment) {
      session.segmentCount += 1;
      const itemId = `${session.activeTurnId}:${kind}:${session.segmentCount}`;
      session.segment = { itemId, kind };
      session.items.set(itemId, { itemId, kind, text: "", detail: "" });
      this.emitItem(session, "item.started", session.items.get(itemId)!, "in-progress");
    }

    const buffer = session.items.get(session.segment.itemId);
    if (!buffer) return;
    buffer.text += text;
    this.emitItem(session, "item.updated", buffer, "in-progress");
  }

  private closeSegment(session: CursorSession): void {
    const open = session.segment;
    if (!open) return;
    session.segment = undefined;
    const buffer = session.items.get(open.itemId);
    if (buffer) this.emitItem(session, "item.completed", buffer, "completed");
  }

  private handleToolCall(session: CursorSession, update: AcpToolCallUpdate): void {
    const toolCallId = update.toolCallId;
    if (!toolCallId || !session.activeTurnId) return;

    // A tool call interrupts whatever text was streaming — close it so the two
    // don't interleave into one block.
    this.closeSegment(session);

    const itemId = `${session.activeTurnId}:${toolCallId}`;
    let buffer = session.items.get(itemId);
    const isNew = buffer === undefined;
    if (!buffer) {
      buffer = { itemId, kind: "tool_call", text: "", detail: "" };
      session.items.set(itemId, buffer);
    }

    if (update.kind) buffer.name = TOOL_KIND_NAMES[update.kind] ?? "tool";
    if (!buffer.name) buffer.name = "tool";
    const target = toolCallTarget(update);
    if (target) buffer.text = target;
    const detail = toolCallDetail(update);
    if (detail) buffer.detail = detail;

    const status = toolCallStatus(update.status);
    if (isNew) this.emitItem(session, "item.started", buffer, status);
    else if (status === "in-progress") this.emitItem(session, "item.updated", buffer, status);
    else this.emitItem(session, "item.completed", buffer, status);
  }

  private handlePlan(session: CursorSession, update: AcpPlanNotification): void {
    if (!session.activeTurnId) return;
    const snapshot = parseAcpPlan(update);
    if (!snapshot) return;

    const itemId = `${session.activeTurnId}:plan`;
    const existing = session.items.get(itemId);
    const tasks = reconcilePlanTasks(existing?.tasks ?? [], snapshot);
    const buffer: CursorItemBuffer = {
      itemId,
      kind: "plan_text",
      text: formatPlanTasks(tasks),
      detail: "",
      tasks,
    };
    session.items.set(itemId, buffer);
    this.emitItem(session, existing ? "item.updated" : "item.started", buffer, "in-progress");
  }

  /** Turn-end usage snapshot. Cursor's ACP never reports usage in-band
   *  (protocol fact 6), but it DOES persist a context record on disk the moment
   *  a turn resolves — that's the real numerator and denominator for the ring.
   *  Prefer it; fall back to the model's window alone when the store isn't
   *  readable (moved home, format change), and emit nothing when even that is
   *  unknowable. Never invent a fill or tally. */
  private async emitUsageFallback(session: CursorSession): Promise<void> {
    if (session.usageReported) return;

    const stored = await this.readStoredContext(session.conversationId);
    if (stored) {
      // The on-disk record (parseStoredCursorContext) is a flat
      // {used, window} pair — Cursor doesn't persist a cache/reasoning split
      // anywhere kone can read, so those three counts are always 0 here.
      const usage: TokenUsage & TokenUsageSplits = {
        contextUsed: stored.used,
        // The disk number is the session's running context fill, which grows
        // turn to turn — the store's "Cursor keeps the max" running-total
        // handling is the right fit.
        total: stored.used,
        contextWindow: stored.window,
        compactsAutomatically: true,
        cacheReadTokens: 0,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
      };
      this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
      return;
    }

    // Give the one-time model catalog a chance to load before deciding there's
    // no window to report — a fast (e.g. blocked) turn can outrun the startSession
    // warm-up. Cheap when the cache is already warm. `buildContextWindowFallback`
    // deliberately reports the window alone (see its own doc comment) — no
    // input/output/total, so no cache/reasoning split either; the store
    // defaults those three to 0 when a usage payload omits them.
    await this.listModels().catch(() => {});
    const usage = buildContextWindowFallback(session.configOptions, this.modelContextWindows, session.model);
    if (!usage) return;
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  /** Read the context record `cursor-agent` persists for a session, if it can
   *  be reached and parsed. `node:sqlite` is imported lazily (like
   *  promptAttachments) so this module stays loadable where the builtin is
   *  absent; every failure — missing store, moved home dir, an unrecognizable
   *  blob format — degrades to undefined. Best-effort, never worth a throw. */
  private async readStoredContext(
    conversationId: string | undefined,
  ): Promise<{ used: number; window: number } | undefined> {
    if (!conversationId) return undefined;
    try {
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(
        join(homedir(), ".cursor", "acp-sessions", conversationId, "store.db"),
        { readOnly: true },
      );
      try {
        // SAFETY: the row shape is fixed by the SQL's single selected column.
        const metaRow = db.prepare("SELECT value FROM meta").get() as { value: string | Uint8Array } | undefined;
        if (!metaRow) return undefined;
        const hex = metaRow.value instanceof Uint8Array ? Buffer.from(metaRow.value).toString("latin1") : String(metaRow.value);
        // SAFETY: JSON.parse yields unknown; consumers probe fields before use.
        const meta = JSON.parse(Buffer.from(hex, "hex").toString("utf8")) as { latestRootBlobId?: string };
        const latest = meta.latestRootBlobId;
        if (!latest) return undefined;
        // SAFETY: the row shape is fixed by the SQL's single selected column.
        const row = db.prepare("SELECT data FROM blobs WHERE id = ?").get(latest) as { data: Uint8Array } | undefined;
        if (!row) return undefined;
        return parseStoredCursorContext(row.data);
      } finally {
        db.close();
      }
    } catch {
      return undefined;
    }
  }

  /** ACP defines `usage_update` carrying the session's running `used`/`size`
   *  totals, but on 2026.07.23 it has never been observed firing — this parser
   *  is defensive ground truth, kept for the day a Cursor build starts emitting
   *  it. On this build
   *  emitUsageFallback is what actually fires at turn end. */
  private handleUsage(session: CursorSession, update: AcpUsageNotification): void {
    const { used, size } = update;
    if (used === undefined && size === undefined) return;
    session.usageReported = true;
    // The ACP `usage_update` shape is only ever `used`/`size` — no
    // input/output split, so no cache/reasoning split either.
    const usage: TokenUsage & TokenUsageSplits = {
      compactsAutomatically: true,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      reasoningTokens: 0,
    };
    if (used !== undefined) {
      usage.contextUsed = used;
      usage.total = used;
    }
    if (size !== undefined) usage.contextWindow = size;
    this.emit({ ...this.base(session), type: "thread.token-usage.updated", usage });
  }

  // ── turn completion ──────────────────────────────────────────────────────

  /** Close out a turn's bookkeeping: settle anything still marked in-progress,
   *  then drop the turn's buffers so a long thread doesn't accumulate them. */
  private endTurn(session: CursorSession, turnId: string, status: RuntimeItemStatus): void {
    this.closeSegment(session);
    for (const itemId of session.openItemIds) {
      const buffer = session.items.get(itemId);
      if (buffer) this.emitItem(session, "item.completed", buffer, status, turnId);
      else session.openItemIds.delete(itemId);
    }
    session.items.clear();
    session.openItemIds.clear();
    session.segmentCount = 0;
    session.activeTurnId = undefined;
  }

  private completeTurn(session: CursorSession, turnId: string, response: AcpPromptResult): void {
    // The result only speaks for the turn it was requested under — a settled
    // turn means a newer prompt already superseded this one, and its usage
    // must not clobber the newer turn's meter.
    if (session.activeTurnId !== turnId) return;
    const stopReason = response.stopReason;
    // ACP doesn't define usage on the prompt result, but a future Cursor build
    // (or a provider routed through it) may carry a usage bag here or in the
    // `_meta` envelope; take it when present, otherwise the turn-end disk
    // fallback below is the honest source.
    const resultUsage = response.usage ?? response._meta?.usage;
    if (resultUsage) {
      const input = resultUsage.inputTokens ?? resultUsage.input_tokens;
      const output = resultUsage.outputTokens ?? resultUsage.output_tokens;
      const cacheRead = resultUsage.cacheReadTokens ?? resultUsage.cache_read_tokens;
      const cacheWrite = resultUsage.cacheWriteTokens ?? resultUsage.cache_write_tokens;
      const reasoning = resultUsage.reasoningTokens ?? resultUsage.reasoning_tokens;
      const total =
        resultUsage.totalTokens ??
        resultUsage.total_tokens ??
        (input !== undefined && output !== undefined
          ? input + output + (cacheRead ?? 0) + (cacheWrite ?? 0)
          : undefined);
      if (input !== undefined || output !== undefined || total !== undefined) {
        session.usageReported = true;
        // `cacheRead`/`cacheWrite` were already parsed above (to complete the
        // `total` fallback) and used to be dropped right here instead of
        // reaching the store — pass the whole split through, still 0 when this
        // speculative `result.usage` bag doesn't carry a given count.
        const usage: TokenUsage & TokenUsageSplits = {
          cacheReadTokens: cacheRead ?? 0,
          cacheCreationTokens: cacheWrite ?? 0,
          reasoningTokens: reasoning ?? 0,
        };
        if (input !== undefined) usage.input = input;
        if (output !== undefined) usage.output = output;
        if (total !== undefined) usage.total = total;
        this.emit({
          ...this.base(session),
          type: "thread.token-usage.updated",
          usage,
        });
      }
    }
    const aborted = session.interrupting || stopReason === "cancelled" || stopReason === "refusal" || stopReason === "max_tokens";
    this.endTurn(session, turnId, aborted ? "failed" : "completed");
    // Not awaited — the disk read is a beat behind the terminal event and must
    // never hold up turn completion.
    void this.emitUsageFallback(session);

    // Cursor reports `end_turn` even for a turn we cancelled, so our own flag
    // decides (protocol fact 1). `refusal`/`max_tokens` are genuine failures.
    if (session.interrupting || stopReason === "cancelled") {
      session.interrupting = false;
      this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason: "interrupted" });
      return;
    }
    if (stopReason === "refusal" || stopReason === "max_tokens") {
      this.emit({
        ...this.base(session),
        type: "turn.aborted",
        turnId,
        reason: "failed",
        message: `Cursor stopped the turn (${stopReason}).`,
      });
      return;
    }
    this.emit({
      ...this.base(session),
      type: "turn.completed",
      turnId,
      conversationId: session.conversationId,
    });
  }

  private failTurn(session: CursorSession, turnId: string, cause: unknown): void {
    if (session.activeTurnId !== turnId) return;
    this.endTurn(session, turnId, "failed");
    void this.emitUsageFallback(session);
    // A prompt rejected because the child died is already covered by the
    // `session.exited` event; report the turn as failed either way so the
    // renderer never keeps a turn spinning.
    const message = cause instanceof Error ? cause.message : String(cause);
    const reason = session.interrupting ? "interrupted" : "failed";
    session.interrupting = false;
    this.emit({ ...this.base(session), type: "turn.aborted", turnId, reason, message });
  }

  // ── shared helpers ───────────────────────────────────────────────────────

  /** A degraded-but-continuing condition (a rejected model, a mode Cursor
   *  doesn't have). Surfaced as session state, never thrown — none of these are
   *  worth losing a session over. */
  private warn(session: CursorSession, summary: string, cause: unknown): void {
    const detail = cause instanceof Error ? cause.message : String(cause);
    this.emit({
      ...this.base(session),
      source: "cursor.acp.lifecycle",
      type: "session.state.changed",
      state: session.activeTurnId ? "running" : "ready",
      message: `${summary}: ${detail}`,
    });
  }

  private emitItem(
    session: CursorSession,
    type: "item.started" | "item.updated" | "item.completed",
    buffer: CursorItemBuffer,
    status: RuntimeItemStatus,
    turnId: string | undefined = session.activeTurnId,
  ): void {
    if (!turnId) return;
    if (type === "item.completed") session.openItemIds.delete(buffer.itemId);
    else session.openItemIds.add(buffer.itemId);
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

  private base(session: CursorSession) {
    const envelope = {
      threadId: session.threadId,
      provider: this.provider,
      at: Date.now(),
      source: "cursor.acp.notification" as const,
    };
    // The resume id rides every envelope so a turn that never completes still
    // leaves the thread resumable.
    if (session.conversationId) {
      return { ...envelope, refs: { conversationId: session.conversationId } };
    }
    return envelope;
  }

  private toSession(session: CursorSession): Session {
    // Cursor holds effort on the session's live config matrix, not a fixed
    // spawn option — the `effort`/`reasoning` option's currentValue is the
    // honest read, absent when the current model exposes no effort axis.
    const effort = findOption(session.configOptions, EFFORT_OPTION_IDS)?.currentValue;
    const result: Session = {
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
    if (effort) result.effort = effort;
    return result;
  }

  private requireSession(threadId: string): CursorSession {
    const session = this.sessions.get(threadId);
    if (!session) throw new Error(`No Cursor session for thread ${threadId}`);
    return session;
  }
}
