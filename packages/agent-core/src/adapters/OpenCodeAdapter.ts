import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { formatPlanTasks, parseTodoWriteInput, reconcilePlanTasks } from "@kone/protocol/plan-tasks";
import { probeResult } from "../spawn.js";
import { versionProbeUsable } from "../providerHealth.js";
import { probeDetail } from "../providerHealth.js";
import { buildOpenCodeEnv, classifyOpenCodeSpawnFailure, isOpenCodeVersionSupported, MINIMUM_OPENCODE_VERSION, OPENCODE_BINARY, parseOpenCodeVersion } from "../opencodeHome.js";
import { startOpenCodeServer, type OpenCodeServer } from "../opencodeServer.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { buildOpenCodeMcpServer } from "../gateway/injection.js";
import {
  checkCommandSafety,
  describeScreenedCall,
  extractCommandsFromArgs,
  type DangerousPatternRule,
} from "../commandSafety.js";
import type { JsonValue } from "../lib-jsonValue.js";
import type { AgentPersona, ApprovalDecision, ApprovalRequest, ApprovalRequestKind, EmitEvent, GatewayConnection, InteractionMode, ModelDescriptor, PlanTask, ProviderAdapter, ProviderConfig, ProviderStatus, RuntimeEvent, RuntimeItem, RuntimeItemKind, RuntimeItemStatus, Session, SendTurnInput, SessionStartInput, SubagentRunSnapshot, SubagentStatus, TokenUsage, TurnStartResult, UserInputAnswers, UserInputQuestion, UserInputQuestionOption } from "../types.js";
import type { TokenUsageSplits } from "../usage/report.js";

/** One decoded JSON value from opencode's HTTP/SSE surface — message infos,
 *  parts, tool state blobs, event properties. Field-level probes (`stringField`,
 *  `record`, `nonNegativeInteger`, …) narrow it at the read sites. */
type OpenCodeJsonValue =
  | string
  | number
  | boolean
  | null
  | undefined
  | RecordLike
  | OpenCodeJsonValue[];

/** A string-keyed JSON object as opencode returns it, before fields are trusted. */
export interface RecordLike {
  [key: string]: OpenCodeJsonValue;
}
type OpenCodeEvent = { type: string; properties?: RecordLike };
type OpenCodeClient = { request(method: string, route: string, body?: OpenCodeJsonValue, signal?: AbortSignal): Promise<any>; events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> };
/** One opencode `task` tool call, recognized from its tool part. opencode runs
 *  the child as a *separate session* on the same server, so we also track the
 *  child session id (from `state.metadata.sessionId`) to route its events back
 *  into the run's transcript. */
type OpenCodeSubagentRun = {
  snapshot: SubagentRunSnapshot;
  announced: boolean;
  settled: boolean;
  childToolPartIds: Set<string>;
  /** The turn that spawned this run, stamped once at birth.
   *
   *  Not read off `session.activeTurnId` at emit time. A backgrounded run
   *  outlives its turn, and the terminal event is emitted at the exact moment
   *  the turn is being torn down — so reading the session there gets either an
   *  empty field or some later turn, and the run's own report is misfiled or
   *  dropped. */
  turnId: string;
};
type OpenCodeSession = {
  threadId: string; cwd: string; model?: string; variant?: string; contextWindow?: number; mode: InteractionMode; baseUrl: string;
  client: OpenCodeClient; server: OpenCodeServer; openCodeSessionId: string; activeTurnId?: string;
  /** The kone gateway connection minted at startSession — the agent's app tools. */
  gatewayConnection?: GatewayConnection;
  /** The named agent this session works as, when the thread was handed to one —
   *  rides the first prompt beside the host-context block. */
  agent?: AgentPersona;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  eventsAbort: AbortController; messageRoleById: Map<string, string>; partById: Map<string, RecordLike>;
  /** The raw permission ask parked under its request id — write-only bookkeeping,
   *  deleted when opencode confirms the reply. */
  pendingPermissions: Map<string, OpenCodeJsonValue>;
  emittedTextByPartId: Map<string, string>; completedTextPartIds: Set<string>;
  lastEmittedTokenUsageKey?: string;
  pendingUserInputs: Map<string, { questions: UserInputQuestion[]; resolve: (answers: UserInputAnswers) => void }>;
  /** In-flight permission approvals, keyed by the permission request's id. Each
   *  holds the ask we surfaced and the resolver that posts the reply — settled
   *  by respondToRequest (the user decided) or drained on interrupt/stop. */
  pendingApprovals: Map<string, PendingApproval>;
  /** Provider-native subagents (Task tool) recognized this session, keyed by the
   *  task tool's call id. */
  subagentRuns: Map<string, OpenCodeSubagentRun>;
  /** Child session id → the task tool call id that spawned it, so child-session
   *  events can be routed into the run's transcript. */
  subagentChildSessions: Map<string, string>;
  /** Task tool call ids of runs that already settled. opencode re-emits tool
   *  parts (each parent `message.updated` re-iterates every part) and child
   *  sessions stream a tail after their tool part completes, so without this
   *  set a settled run's id would be re-created (a duplicate
   *  `subagent.completed`) and its leftover items would orphan in the parent
   *  transcript. The Claude adapter guards the same way (`settledSubagents`). */
  settledSubagentToolUseIds: Set<string>;
  disposed: boolean; interrupting: boolean; planTasks: PlanTask[]; exitNotified: boolean;
};

/** A parked opencode permission approval: the ask we surfaced and the resolver
 *  that posts the `permission/{id}/reply` once the renderer decides. When the
 *  ask came from a provider-native subagent (child session), `subagentToolUseId`
 *  tags which run it belongs to so it routes with the child's transcript. */
type PendingApproval = {
  approval: ApprovalRequest;
  resolve: (decision: ApprovalDecision) => void;
  subagentToolUseId?: string;
};

const SLUG_LINE = /^(\S+\/\S+)\s*$/;

function record(value: OpenCodeJsonValue | null | undefined): RecordLike | undefined {
  // SAFETY: value instanceof Object && !Array.isArray(value) verifies it is a record object.
  return value && value instanceof Object && !Array.isArray(value) ? (value as RecordLike) : undefined;
}
function responseData(value: any): any { return value?.data ?? value; }
function errorMessage(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  // Provider payloads (e.g. session.error) carry plain `{ message }` objects —
  // String() would render "[object Object]".
  // SAFETY: error payload may be a record carrying a message field.
  const r = record(cause as RecordLike | undefined);
  const msg = textField(r?.message);
  if (msg) return msg;
  return String(cause);
}
function statusOf(cause: unknown): number | undefined {
  // SAFETY: error payload may be a record carrying status or statusCode.
  const r = record(cause as RecordLike | undefined);
  const response = record(r?.response);
  const status = r?.status;
  if (jsonNumber(status)) return status;
  const statusCode = r?.statusCode;
  if (jsonNumber(statusCode)) return statusCode;
  const resStatus = response?.status;
  if (jsonNumber(resStatus)) return resStatus;
  return undefined;
}

/** Parses OpenCode's pretty-printed, slug-prefixed model inventory. */
export function parseOpenCodeModels(stdout: string): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  let slug: string | undefined; let json: string[] = [];
  const flush = () => {
    if (!slug) return;
    try {
       // SAFETY: JSON.parse yields unknown; the field probes below validate before use.
       const model = JSON.parse(json.join("\n")) as RecordLike;
       const name = textField(model.name)?.trim() ?? "";
       if (!name) return;
       const providerId = textField(model.providerID)?.trim() ?? "";
       const modelId = textField(model.id)?.trim() ?? "";
       const id = providerId && modelId ? `${providerId}/${modelId}` : slug;
       const variants = record(model.variants);
       const efforts = variants ? Object.keys(variants) : [];
       const limit = record(model.limit);
       const contextWindowTokens = jsonNumber(limit?.context) && limit.context > 0 ? limit.context : undefined;
       const descriptor: ModelDescriptor = { id, label: name };
       if (contextWindowTokens !== undefined) descriptor.contextWindowTokens = contextWindowTokens;
       if (efforts.length) descriptor.reasoningEfforts = efforts;
       if (efforts.includes("medium")) descriptor.defaultReasoningEffort = "medium";
       else if (efforts.includes("high")) descriptor.defaultReasoningEffort = "high";
       models.push(descriptor);
    } catch { /* skip one malformed block */ }
  };
  for (const line of stdout.split("\n")) {
    const match = line.match(SLUG_LINE);
    if (match) { flush(); slug = match[1]; json = []; continue; }
    if (slug) json.push(line);
  }
  flush();
  return models;
}

/** OpenCode deltas can be full replacement snapshots rather than incremental appends. */
export type OpenCodeTextDelta = { text: string; delta: string };

export function reconcileOpenCodeText(previous: string | undefined, snapshot: string): OpenCodeTextDelta {
  const old = previous ?? "";
  const text = old.startsWith(snapshot) ? old : snapshot;
  let common = 0; while (common < old.length && common < text.length && old[common] === text[common]) common += 1;
  return { text, delta: text.slice(common) };
}

export function appendOpenCodeTextDelta(previous: string, delta: string): OpenCodeTextDelta {
  return { text: previous + delta, delta };
}

/** Only structured 404s permit a resume cursor to be discarded. */
export function isOpenCodeNotFound(cause: unknown): boolean {
  const queue: unknown[] = [cause]; const seen = new Set<unknown>();
  for (let i = 0; queue.length && i < 32; i += 1) {
    const node = queue.shift();
    // SAFETY: error cause/body nodes may be records probed for HTTP status.
    const r = record(node as OpenCodeJsonValue | undefined);
    if (!r || seen.has(node)) continue;
    seen.add(node);
    const status = statusOf(r); if (status === 404) return true; if (status !== undefined) continue;
    if (textField(r.name)?.toLowerCase() === "notfounderror") return true;
    for (const key of ["cause", "body", "error", "data"]) if (r[key] !== undefined) queue.push(r[key]);
  }
  return false;
}

export type OpenCodeTokenTally = { input: number; output: number };

export function accumulateOpenCodeTokens(current: { input: number; output: number }, tokens: OpenCodeJsonValue | null | undefined): OpenCodeTokenTally {
  const t = record(tokens); if (!t) return current;
  return { input: current.input + (jsonNumber(t.input) ? t.input : 0), output: current.output + (jsonNumber(t.output) ? t.output : 0) + (jsonNumber(t.reasoning) ? t.reasoning : 0) };
}

function nonNegativeInteger(value: OpenCodeJsonValue | null | undefined): number | undefined {
  return jsonNumber(value) && value >= 0 && Number.isInteger(value) ? value : undefined;
}

function stringField(value: OpenCodeJsonValue | null | undefined, key: string): string | undefined {
  return textField(record(value)?.[key]);
}

/** A decoded JSON number — finiteness separates the number variant from every
 *  other JSON variant without inspecting representations. */
function jsonNumber(value: OpenCodeJsonValue | undefined): value is number {
  return Number.isFinite(value);
}

/** The text under an opencode JSON field when it is one — the same variant
 *  split antigravitySubagents uses: booleans by value, numbers by finiteness,
 *  composites by their constructors. */
function textField(value: OpenCodeJsonValue | undefined): string | undefined {
  if (value === undefined || value === null || value === true || value === false) return undefined;
  if (Array.isArray(value) || value instanceof Object || jsonNumber(value)) return undefined;
  return String(value);
}

/** Per-question selections opencode echoes back on reply events — an array of
 *  label arrays, tolerated as loosely as every other SSE field. */
function answerRows(value: OpenCodeJsonValue | undefined): string[][] {
  if (!Array.isArray(value)) return [];
  return value.map((row) => Array.isArray(row) ? row.flatMap((cell) => { const text = textField(cell); return text === undefined ? [] : [text]; }) : []);
}

function openCodeModelName(metadata: RecordLike | undefined): string | undefined {
  const providerID = stringField(metadata, "providerID");
  const modelID = stringField(metadata, "modelID");
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

/** The one-line brief the parent handed the child. */
function subagentDescription(input: RecordLike | undefined, title: OpenCodeJsonValue | null | undefined): string | undefined {
  return stringField(input, "description") ?? (textField(title) || undefined);
}

/** The agent definition invoked, e.g. `explore` / `general`. */
function subagentType(input: RecordLike | undefined): string | undefined {
  return stringField(input, "subagent_type");
}

function subagentStatus(status: OpenCodeJsonValue | null | undefined): SubagentStatus {
  if (status === "completed") return "completed";
  if (status === "error") return "failed";
  if (status === "pending") return "starting";
  return "running";
}

/** Strip the `<task>`/`<task_result>` wrapper opencode renders around the
 *  child's final output into a plain summary. */
function openCodeTaskSummary(output: OpenCodeJsonValue | null | undefined): string | undefined {
  const text = textField(output);
  if (!text) return undefined;
  const cleaned = text.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

/** OpenCode reports cumulative session totals on assistant messages and step ends. */
export function normalizeOpenCodeTokenUsage(
  tokens: OpenCodeJsonValue | null | undefined,
  contextWindow?: number,
): (TokenUsage & TokenUsageSplits) | undefined {
  const tokenRecord = record(tokens);
  if (!tokenRecord) return undefined;
  const inputTokens = nonNegativeInteger(tokenRecord.input);
  const outputTokens = nonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = nonNegativeInteger(tokenRecord.reasoning);
  const cache = record(tokenRecord.cache);
  const cacheReadTokens = nonNegativeInteger(cache?.read);
  const cacheWriteTokens = nonNegativeInteger(cache?.write);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  const cachedInputTokens = cacheReadTokens + cacheWriteTokens;
  const total = inputTokens + cachedInputTokens + outputTokens + reasoningOutputTokens;
  if (total <= 0) return undefined;
  const normalizedContextWindow = contextWindow !== undefined && contextWindow !== null && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
  const contextUsed = normalizedContextWindow !== undefined ? Math.min(total, normalizedContextWindow) : total;
  const usage: TokenUsage & TokenUsageSplits = {
    input: inputTokens,
    output: outputTokens + reasoningOutputTokens,
    total,
    contextUsed,
    // Unlike Claude (which only ever reports the combined input total),
    // OpenCode's `tokens` payload already carries the prompt-cache split and
    // the reasoning-token count as their own fields on every usage update —
    // pass them straight through instead of only folding them into
    // input/output above.
    cacheReadTokens,
    cacheCreationTokens: cacheWriteTokens,
    reasoningTokens: reasoningOutputTokens,
  };
  if (normalizedContextWindow !== undefined) usage.contextWindow = normalizedContextWindow;
  return usage;
}

export function buildOpenCodeTokenUsageKey(input: {
  messageId: string;
  tokens: OpenCodeJsonValue | null | undefined;
  contextWindow?: number;
}): string | undefined {
  const tokenRecord = record(input.tokens);
  if (!tokenRecord) return undefined;
  const inputTokens = nonNegativeInteger(tokenRecord.input);
  const outputTokens = nonNegativeInteger(tokenRecord.output);
  const reasoningOutputTokens = nonNegativeInteger(tokenRecord.reasoning);
  const cache = record(tokenRecord.cache);
  const cacheReadTokens = nonNegativeInteger(cache?.read);
  const cacheWriteTokens = nonNegativeInteger(cache?.write);
  if (
    inputTokens === undefined
    || outputTokens === undefined
    || reasoningOutputTokens === undefined
    || cacheReadTokens === undefined
    || cacheWriteTokens === undefined
  ) {
    return undefined;
  }
  const normalizedContextWindow = input.contextWindow !== undefined && input.contextWindow !== null && Number.isFinite(input.contextWindow) && input.contextWindow > 0
    ? input.contextWindow
    : "";
  return [
    input.messageId,
    inputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    outputTokens,
    reasoningOutputTokens,
    normalizedContextWindow,
  ].join(":");
}

export function permissionRules(mode: InteractionMode): RecordLike[] {
  // Full access allows everything — except that `bash` is routed back here as an
  // ask, and answered instantly. The rung's contract is "never prompts", not
  // "never looks": a server-side blanket allow means the command never crosses
  // this process, and the handful of commands that end the machine rather than
  // the worktree are then unrefusable on the one rung with nobody to ask. The
  // ask is auto-approved in `permissionAsked` after the screen, so nothing
  // surfaces and nothing waits on a human. OpenCode resolves against the LAST
  // matching rule, so this has to come after the catch-all.
  if (mode === "full-access") {
    return [
      { permission: "*", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
    ];
  }
  if (mode === "accept-edits") {
    // Closed by default: a deny base, then explicit allows for read operations
    // and edit/write, with the mutating/network/out-of-tree families asked.
    // A deny base also blocks custom/MCP tools and future mutating tools that
    // a short denylist would accidentally leave enabled.
    return [
      { permission: "*", pattern: "*", action: "deny" },
      { permission: "read", pattern: "*", action: "allow" },
      { permission: "glob", pattern: "*", action: "allow" },
      { permission: "grep", pattern: "*", action: "allow" },
      { permission: "list", pattern: "*", action: "allow" },
      { permission: "lsp", pattern: "*", action: "allow" },
      { permission: "codesearch", pattern: "*", action: "allow" },
      { permission: "todoread", pattern: "*", action: "allow" },
      { permission: "todowrite", pattern: "*", action: "allow" },
      { permission: "question", pattern: "*", action: "allow" },
      { permission: "edit", pattern: "*", action: "allow" },
      { permission: "write", pattern: "*", action: "allow" },
      { permission: "bash", pattern: "*", action: "ask" },
      { permission: "webfetch", pattern: "*", action: "ask" },
      { permission: "websearch", pattern: "*", action: "ask" },
      { permission: "external_directory", pattern: "*", action: "ask" },
    ];
  }
  return [{ permission: "*", pattern: "*", action: "ask" }, ...["bash", "edit", "webfetch", "websearch", "external_directory"].map((permission) => ({ permission, pattern: "*", action: "ask" })), { permission: "question", pattern: "*", action: "allow" }];
}

function modelSlug(slug: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!slug) return undefined; const at = slug.indexOf("/"); if (at <= 0 || at === slug.length - 1) return undefined;
  return { providerID: slug.slice(0, at), modelID: slug.slice(at + 1) };
}

function toolKind(tool: string): RuntimeItemKind { return /^todo(write|read)$/i.test(tool) ? "plan_text" : "tool_call"; }
/** Normalize an opencode permission ask into the neutral approval request. The
 *  ask names the permission being requested (`bash`, `edit:path`, a URL for
 *  webfetch); the kind follows its family. */
function openCodeApprovalRequest(permission: OpenCodeJsonValue | null | undefined): ApprovalRequest {
  const permissionRecord = record(permission);
  const raw =
    permission && !(permission instanceof Object)
      ? String(permission)
      : permissionRecord
        ? String(permissionRecord.type ?? permissionRecord.permission ?? "")
        : String(permission ?? "");
  const text = raw.trim() || "Request permission";
  const kind: ApprovalRequestKind = /^(bash|shell|terminal)/i.test(text)
    ? "command"
    : /^(edit|write|delete|move|patch|create)/i.test(text)
      ? "file-change"
      : /^read/i.test(text)
        ? "file-read"
        : "permission";
  return { kind, title: text };
}
function asJson(value: OpenCodeJsonValue | null | undefined): JsonValue | undefined {
  // SAFETY: the two JSON unions differ only in that opencode's admits
  // `undefined` members. The screen parses this with zod and treats an
  // undefined field exactly as it treats an absent one, so the widening cannot
  // change what it reads.
  return value as JsonValue | undefined;
}

/** Whether a full-access permission ask carries a command that must be refused
 *  rather than waved through.
 *
 *  The ask's shape is opencode's, not ours, and it moves — the command has been
 *  seen on the permission string itself, in `metadata`, and in the pattern the
 *  rule matched. So this reads every command-bearing key it can find rather than
 *  one blessed path: a screen that only works on the spelling it was written
 *  against is a screen that quietly stops working. Nothing found means nothing
 *  matched, which is the same answer as a safe command — this is a screen, not a
 *  sandbox, and it fails open by construction. */
function criticalCommandInPermission(
  ask: RecordLike,
  threadId: string,
): { rule: DangerousPatternRule; command: string } | undefined {
  const permission = ask.permission;
  const candidates = [
    ...extractCommandsFromArgs(asJson(permission)),
    ...extractCommandsFromArgs(asJson(record(permission)?.metadata)),
    ...extractCommandsFromArgs(asJson(ask.metadata)),
  ];
  for (const command of candidates) {
    const result = checkCommandSafety(command);
    if (!result.matchedRule) continue;
    const detail = describeScreenedCall({ rule: result.matchedRule, command });
    if (result.matchedRule.severity !== "critical") {
      console.warn(`[kone] full-access ${threadId}: destructive — ${detail}`);
      continue;
    }
    console.error(`[kone] full-access ${threadId}: REFUSED — ${detail}`);
    return { rule: result.matchedRule, command };
  }
  return undefined;
}

function toOpenCodeReply(decision: ApprovalDecision): "once" | "always" | "reject" {
  switch (decision) {
    case "allow-once":
      return "once";
    case "allow-always":
      return "always";
    default:
      // reject-once and reject-and-stop both reply "reject" to the permission
      // itself; the difference is that reject-and-stop then aborts the turn.
      return "reject";
  }
}
function toolStatus(status: string): RuntimeItemStatus { return status === "error" ? "failed" : status === "completed" ? "completed" : "in-progress"; }
function detailForTool(state: RecordLike): string | undefined {
  return textField(state.output) ?? textField(state.error) ?? textField(state.title);
}

function base(session: OpenCodeSession, source: RuntimeEvent["source"] = "opencode.sse.message"): Omit<RuntimeEvent, "type"> {
  // SAFETY: the literal supplies every field Omit leaves required.
  return { threadId: session.threadId, provider: "opencode", at: Date.now(), source, refs: { conversationId: session.openCodeSessionId } } as Omit<RuntimeEvent, "type">;
}

function makeClient(baseUrl: string): OpenCodeClient {
  const url = (route: string) => `${baseUrl.replace(/\/$/, "")}${route}`;
  return {
    async request(method, route, body, signal) {
      // GET requests reject a body at the fetch level; attach payload keys only when one exists.
      const init: RequestInit = { method, signal };
      if (body !== undefined) Object.assign(init, { headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const response = await fetch(url(route), init);
      const text = await response.text(); let parsed: any; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
      if (!response.ok) { const error = new Error(`OpenCode ${method} ${route} failed with ${response.status}`); Object.assign(error, { status: response.status, body: parsed }); throw error; }
      return parsed;
    },
    async *events(signal) {
      const response = await fetch(url("/event"), { headers: { accept: "text/event-stream" }, signal });
      if (!response.ok || !response.body) throw new Error(`OpenCode event stream failed with ${response.status}`);
      const reader = response.body.getReader(); const decoder = new TextDecoder(); let buffer = "";
      try {
        while (true) {
          const next = await reader.read(); if (next.done) break; buffer += decoder.decode(next.value, { stream: true });
          const frames = buffer.split(/\n\n/); buffer = frames.pop() ?? "";
          // SAFETY: JSON.parse yields unknown and malformed SSE frames are skipped by the catch below.
          for (const frame of frames) {
            const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n");
            if (!data) continue;
            // SAFETY: JSON.parse yields unknown; malformed SSE frames are skipped by the catch below.
            const event = JSON.parse(data) as OpenCodeEvent;
            yield event;
          }
        }
      } finally { reader.releaseLock(); }
    },
  };
}

export function translateOpenCodeEvent(sessionId: string, event: OpenCodeEvent): boolean {
  const p = event.properties ?? {};
  return p.sessionID === sessionId
    || stringField(p.info, "sessionID") === sessionId
    || stringField(p.part, "sessionID") === sessionId
    || stringField(p.tool, "sessionID") === sessionId;
}

export function isOpenCodeTurnEnd(event: OpenCodeEvent): boolean {
  return event.type === "session.idle" || (event.type === "session.status" && record(event.properties?.status)?.type === "idle");
}

export function selectOpenCodeTurnId(activeTurnId: string | undefined): string {
  return activeTurnId ?? `opencode-turn-${randomUUID()}`;
}

/** Build the run snapshot for an opencode `task` tool part, folded from the
 *  tool's input + metadata and the parent session's reasoning variant. The
 *  child inherits the parent session's `variant` — opencode's native subagents
 *  run under the spawning session's strength — so it is reported as the run's
 *  `effort` when the parent has one. */
export function buildOpenCodeSubagentSnapshot(input: {
  toolUseId: string;
  status: SubagentStatus;
  toolInput: RecordLike;
  toolMetadata: RecordLike;
  stateTitle: OpenCodeJsonValue;
  childSessionId: string | undefined;
  variant?: string;
}): SubagentRunSnapshot {
  const { toolUseId, status, toolInput, toolMetadata, stateTitle, childSessionId, variant } = input;
  const snapshot: SubagentRunSnapshot = {
    toolUseId,
    parentItemId: toolUseId,
    status,
    startedAt: Date.now(),
  };
  if (childSessionId) snapshot.taskId = childSessionId;
  const agentType = subagentType(toolInput);
  if (agentType) snapshot.agentType = agentType;
  const description = subagentDescription(toolInput, stateTitle);
  if (description) snapshot.description = description;
  const prompt = stringField(toolInput, "prompt");
  if (prompt) snapshot.prompt = prompt;
  const model = openCodeModelName(toolMetadata);
  if (model) snapshot.model = model;
  if (toolMetadata.background === true || toolInput.background === true) snapshot.background = true;
  if (variant) snapshot.effort = variant;
  return snapshot;
}

/** A failed model-inventory probe, carrying whether the probe reached a verdict
 *  at all. A timeout or a spawn failure did not, and a row built on one must not
 *  replace what the last conclusive round found. */
class OpenCodeModelProbeError extends Error {
  readonly inconclusive: boolean;
  constructor(inconclusive: boolean, message: string) {
    super(message);
    this.inconclusive = inconclusive;
  }
}

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = "opencode" as const;
  readonly capabilities = { sessionModelSwitch: "restart-session" as const, streamsText: true, supportsToolEvents: true, supportsResume: true, supportsModelList: true, supportsSubagents: true };
  private readonly emit: EmitEvent; private readonly sessions = new Map<string, OpenCodeSession>(); private modelsCache: Promise<ModelDescriptor[]> | null = null; private readonly modelContextWindows = new Map<string, number>();
  /** The CLI executable to spawn — the user's override or the `opencode` default. */
  private binary = OPENCODE_BINARY;
  constructor(emit: EmitEvent) { this.emit = emit; }

  /** Adopt the user's persisted install settings. A blank binaryPath falls back
   *  to the default; drop the model cache so the next probe uses the new binary. */
  setConfig(config: ProviderConfig): void {
    const next = config.binaryPath?.trim() || OPENCODE_BINARY;
    if (next === this.binary) return;
    this.binary = next;
    this.modelsCache = null;
  }

  async discover(): Promise<ProviderStatus> {
    const env = await buildOpenCodeEnv(); const result = await probeResult(this.binary, ["--version"], env, 5_000);
    // A version probe that never came back says nothing about the install — the
    // classifier below reads spawn failures, not silence.
    if (result.outcome === "timeout") return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", message: "OpenCode did not respond in time — try again in a moment.", transient: true };
    // Hand the classifier the real failure: its quarantine / code-signature
    // branches can only fire on the CLI's own words.
    const version = parseOpenCodeVersion(`${result.stdout}\n${result.stderr}`);
    if (!versionProbeUsable(result, version)) return classifyOpenCodeSpawnFailure(result.error ?? new Error(probeDetail(result) ?? "OpenCode could not be started."));
    if (!isOpenCodeVersionSupported(version)) return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", version, message: `OpenCode v${version ?? "unknown"} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.` };
    try { const models = await this.listModels(); return { provider: "opencode", label: "OpenCode", available: true, authStatus: models.length ? "authenticated" : "unknown", readiness: models.length ? "ready" : "needs-login", version, message: models.length ? undefined : "OpenCode is available, but no connected providers were reported. Run `opencode providers login`." }; }
    // An inventory that never came back is not a verdict about sign-in either:
    // keep whatever the last conclusive round said rather than writing an error
    // row over it. See stabilizeProviderStatuses.
    catch (error) {
      const inconclusive = error instanceof OpenCodeModelProbeError && error.inconclusive;
      const status: ProviderStatus = {
        provider: "opencode",
        label: "OpenCode",
        available: true,
        authStatus: "unknown",
        readiness: "error",
        version,
        message: inconclusive
          ? "OpenCode did not report its model list in time — try again in a moment."
          : "OpenCode model inventory could not be read.",
      };
      if (inconclusive) {
        status.transient = true;
      }
      return status;
    }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.modelsCache) this.modelsCache = this.fetchModels().catch((error) => { this.modelsCache = null; throw error; });
    return this.modelsCache;
  }
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildOpenCodeEnv();
    let inconclusive = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const result = await probeResult(this.binary, ["models", "--verbose"], env, 30_000);
      // A listing that never ran to completion tells us nothing; one that ran
      // and printed nothing is an answer (no connected providers).
      inconclusive = result.outcome === "timeout" || result.outcome === "failure";
      if (result.outcome === "ok" || result.outcome === "nonzero") {
        const models = parseOpenCodeModels(result.stdout);
        if (models.length || attempt === 1) { for (const model of models) if (model.contextWindowTokens !== undefined) this.modelContextWindows.set(model.id, model.contextWindowTokens); return models; }
      }
      if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    throw new OpenCodeModelProbeError(inconclusive, "OpenCode model inventory failed.");
  }

  async startSession(input: SessionStartInput): Promise<Session> {
    const prior = this.sessions.get(input.threadId); if (prior) await this.stopSession(input.threadId);
    const mode = input.mode ?? "accept-edits"; const env = await buildOpenCodeEnv(); const server = await startOpenCodeServer({ cwd: input.cwd, env, binary: this.binary });
    const client = makeClient(server.baseUrl); let sessionId: string | undefined;
    const resume = input.resume?.trim();
    // Attempt resume for ANY non-empty stored id, not just `ses_`-prefixed
    // ones: a foreign id is rejected by the server with a 404, which is the
    // only path that should fall through to a fresh session. (The old prefix
    // gate silently skipped non-`ses_` ids even when the server could have
    // adopted them — leaving the thread to reopen blank for no reason.)
    if (resume) {
      try {
        const found = responseData(await client.request("GET", `/session/${encodeURIComponent(resume)}`));
        sessionId = found?.id ?? resume;
        const same = found?.directory ? await this.sameDirectory(found.directory, input.cwd) : true;
        const adoptedId = sessionId;
        if (!adoptedId) throw new Error("OpenCode resume response did not include an id.");
        if (!same) {
          sessionId = responseData(await client.request("POST", `/session/${encodeURIComponent(adoptedId)}/fork`, { directory: input.cwd, permission: permissionRules(mode) }))?.id;
          // Belt-and-braces: the fork may ignore the permission field (or carry
          // the resumed session's ruleset), so re-assert the mode's ruleset on
          // the forked session before the event pump starts below — a fork of a
          // full-access session must not keep allow-all under ask/accept-edits.
          if (sessionId) await client.request("PATCH", `/session/${encodeURIComponent(sessionId)}`, { permission: permissionRules(mode) });
        }
        else await client.request("PATCH", `/session/${encodeURIComponent(adoptedId)}`, { permission: permissionRules(mode) });
      } catch (error) { if (!isOpenCodeNotFound(error)) { await server.dispose(); throw error; } }
    }
    // Set only if the resume id was found and adopted above (or forked from, which
    // copies the transcript). A pruned id leaves it undefined and falls through to a
    // fresh session, which the caller has to be able to tell apart — see Session.resumedFrom.
    const resumedFrom = sessionId ? resume : undefined;
    if (!sessionId) sessionId = responseData(await client.request("POST", "/session", { permission: permissionRules(mode) }))?.id;
    if (!sessionId) { await server.dispose(); throw new Error("OpenCode session response did not include an id."); }
    // kone gateway (docs/mcp-gateway-design.md §4): register the app's MCP
    // server on this opencode server instance right after the session exists.
    // The registry is per-server-process, so the tools die with the session's
    // server — no cross-thread leakage. Failures are loud but non-fatal.
    if (input.gatewayConnection) {
      try {
        const mcpResult = responseData(
          await client.request("POST", "/mcp", {
            name: "kone",
            config: buildOpenCodeMcpServer(input.gatewayConnection),
            directory: input.cwd,
          }),
        );
        const koneStatus = record(record(mcpResult)?.kone);
        if (koneStatus?.status !== "connected") {
          console.error(
            `[opencode] kone MCP server did not connect: ${String(koneStatus?.error ?? "unknown status")}`,
          );
        }
      } catch (error) {
        console.error("[opencode] kone MCP registration failed:", errorMessage(error));
      }
    }
    const session: OpenCodeSession = { threadId: input.threadId, cwd: input.cwd, model: input.model, variant: input.effort, contextWindow: input.model ? this.modelContextWindows.get(input.model) : undefined, mode, baseUrl: server.baseUrl, client, server, openCodeSessionId: sessionId, resumedFrom, gatewayConnection: input.gatewayConnection, agent: input.agent, runOrdinal: 0, eventsAbort: new AbortController(), messageRoleById: new Map(), partById: new Map(), emittedTextByPartId: new Map(), completedTextPartIds: new Set(), pendingPermissions: new Map(), pendingUserInputs: new Map(), pendingApprovals: new Map(), subagentRuns: new Map(), subagentChildSessions: new Map(), settledSubagentToolUseIds: new Set(), disposed: false, interrupting: false, planTasks: [], exitNotified: false };
    server.child.once("exit", (code) => this.unexpectedExit(session, code));
    this.sessions.set(input.threadId, session); void this.consumeEvents(session);
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.started" });
    return this.toSession(session);
  }

  private async sameDirectory(a: string, b: string): Promise<boolean> { try { return (await fs.realpath(path.resolve(a))) === (await fs.realpath(path.resolve(b))); } catch { return path.resolve(a) === path.resolve(b); } }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.require(input.threadId); const text = input.input.trim();
    const { buildOpenCodeAttachmentParts, composePromptText } = await import("../promptAttachments.js");
    const files = await buildOpenCodeAttachmentParts(input.attachments);
    // The ladder is applied to the session when it opens (and on resume); a
    // mode change mid-session would otherwise silently never take effect —
    // opencode persists `permission` on the session, and PATCH /session is the
    // same live update the resume path already relies on. Best-effort: a
    // refused PATCH leaves the session on its current rules, reported truthfully
    // via session.mode.
    const mode = input.mode ?? session.mode;
    if (mode !== session.mode) {
      try {
        await session.client.request("PATCH", `/session/${encodeURIComponent(session.openCodeSessionId)}`, { permission: permissionRules(mode) });
        session.mode = mode;
      } catch (error) {
        console.error("[opencode] failed to apply permission mode:", errorMessage(error));
      }
    }
    // prependT3OrchestrationInstructions pattern): the app-context block rides
    // the very first user turn so the agent knows the gateway tools exist.
    const composed = composePromptText(text, "");
    const prompt = koneHostContextForFirstRun({
      prompt: composed,
      runOrdinal: session.runOrdinal + 1,
      gateway: session.gatewayConnection,
      agent: session.agent,
    });
    session.runOrdinal += 1;
    if (!prompt && !files.length) throw new Error("Turn input must include text or an attachment.");
    if (input.model) { session.model = input.model; session.contextWindow = this.modelContextWindows.get(input.model); }
    const model = modelSlug(input.model ?? session.model); if (!model) throw new Error("OpenCode model selection must use the 'provider/model' format.");
    // `serviceTier` / `contextWindow` are deliberately not applied: opencode's
    // model surface advertises no fast/context axes, so the picker never
    // offers them — a per-turn value could only arrive from a stale selection.
    const steering = session.activeTurnId; const turnId = steering ?? `opencode-turn-${randomUUID()}`; if (!steering) { session.activeTurnId = turnId; session.lastEmittedTokenUsageKey = undefined; this.emit({ ...base(session), type: "turn.started", turnId }); }
    const parts = [...(prompt ? [{ type: "text", text: prompt }] : []), ...files];
    const variant = input.effort ?? session.variant;
    const requestBody = variant ? { model, parts, variant } : { model, parts };
    try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/prompt_async`, requestBody); }
    catch (error) { if (!steering) { session.activeTurnId = undefined; this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "failed", message: errorMessage(error) }); } throw error; }
    return { threadId: input.threadId, turnId };
  }

  /** Deliver a follow-up into a RUNNING opencode turn: prompt_async already
   *  appends into the live session and sendTurn already reuses the active
   *  turn id (no turn.started) when one is live — so a steer is exactly that
   *  path plus the turn.steered announcement. With no live turn this falls
   *  back to a normal sendTurn. */
  async steerTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.sessions.get(input.threadId);
    if (!session?.activeTurnId) return this.sendTurn(input);
    const result = await this.sendTurn(input);
    const steerText = input.input.trim();
    if (steerText) {
      this.emit({ ...base(session), type: "turn.steered", turnId: result.turnId, message: steerText });
    }
    return result;
  }

  async interruptTurn(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session?.activeTurnId) return; this.drain(session); session.interrupting = true; await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); }
  // Deliberate stop = the one stop-lifecycle contract every adapter shares: a
  // terminal `session.exited` with code null (the sibling ACP/JSON-RPC
  // adapters emit it on their kill paths; Claude now emits it explicitly too).
  // `disposed` gates unexpectedExit, so this is the single terminal emit.
  // stopAll delegates here, so it inherits the contract (and the live-turn
  // sealing in abortLiveTurn) for every session. The turn is sealed as
  // `interrupted` first (abortLiveTurn) or the journaled assistant block would
  // stay 'running' forever and the thread would reopen permanently busy.
  async stopSession(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session) return; session.disposed = true; this.drain(session); this.settleLiveSubagents(session, "stopped"); this.abortLiveTurn(session); session.eventsAbort.abort(); try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); } catch { /* best effort */ } await session.server.dispose(); this.sessions.delete(threadId); this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.exited", code: null }); }
  async stopAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId))); }
  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> { const session = this.require(threadId); this.resolveApproval(session, requestId, decision); /* "Reject and stop" — the permission already gets its `reject` reply (toOpenCodeReply), and aborting the session turns that into an interrupted turn instead of a continued one. */ if (decision === "reject-and-stop") void this.interruptTurn(threadId); }
  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> { const session = this.require(threadId); const pending = session.pendingUserInputs.get(requestId); if (!pending) return; session.pendingUserInputs.delete(requestId); pending.resolve(answers); }
  async listSessions(): Promise<Session[]> { return [...this.sessions.values()].map((session) => this.toSession(session)); }
  async hasSession(threadId: string): Promise<boolean> { return this.sessions.has(threadId); }

  private require(threadId: string): OpenCodeSession { const session = this.sessions.get(threadId); if (!session) throw new Error(`No OpenCode session for thread ${threadId}`); return session; }
  private toSession(s: OpenCodeSession): Session { const result: Session = { threadId: s.threadId, provider: "opencode", cwd: s.cwd, status: s.activeTurnId ? "running" : "ready", conversationId: s.openCodeSessionId, resumedFrom: s.resumedFrom, activeTurnId: s.activeTurnId, model: s.model, mode: s.mode }; if (s.variant) result.effort = s.variant; return result; }
  private drain(s: OpenCodeSession): void { for (const [id, pending] of s.pendingUserInputs) { s.pendingUserInputs.delete(id); pending.resolve({}); } for (const [id, pending] of s.pendingApprovals) { s.pendingApprovals.delete(id); pending.resolve("reject-once"); } }
  private abortLiveTurn(s: OpenCodeSession): void { const turnId = s.activeTurnId; if (!turnId) return; s.activeTurnId = undefined; s.interrupting = false; this.emit({ ...base(s, "opencode.sse.lifecycle"), type: "turn.aborted", turnId, reason: "interrupted" }); }

  private async consumeEvents(session: OpenCodeSession): Promise<void> {
    try {
      for await (const event of session.client.events(session.eventsAbort.signal)) {
        if (session.disposed) continue;
        // opencode runs a Task tool's child as a separate session on the same
        // server, so its events arrive with the child's session id. Route them
        // into the run's transcript instead of dropping them like unrelated
        // sessions.
        if (!translateOpenCodeEvent(session.openCodeSessionId, event)) {
          const childId = this.eventSessionId(event);
          const toolUseId = childId ? session.subagentChildSessions.get(childId) : undefined;
          if (!toolUseId) continue;
          this.handleChildEvent(session, toolUseId, event);
          continue;
        }
        this.handleEvent(session, event);
      }
    }
    catch (error) { if (!session.disposed && !session.eventsAbort.signal.aborted) this.unexpectedExit(session, null, errorMessage(error)); }
  }

  /** The session id an SSE event belongs to, wherever opencode stashed it. */
  private eventSessionId(event: OpenCodeEvent): string | undefined {
    const p = event.properties ?? {};
    return textField(p.sessionID)
      ?? stringField(p.info, "sessionID")
      ?? stringField(p.part, "sessionID")
      ?? stringField(p.tool, "sessionID");
  }

  private unexpectedExit(session: OpenCodeSession, code: number | null, message?: string): void {
    if (session.disposed || session.exitNotified) return;
    session.exitNotified = true;
    // Settle parked approvals/questions so their resolvers resolve and the
    // renderer's modals clear — a crashed provider leaves no reply coming.
    this.drain(session);
    const turnId = session.activeTurnId;
    // Settled before the turn loses its id, or the terminal event is emitted
    // against nothing (see complete). The server is gone, so background runs go
    // with it — nothing is left to report for them.
    this.settleLiveSubagents(session, "failed");
    session.activeTurnId = undefined;
    if (turnId) {
      const aborted: Extract<RuntimeEvent, { type: "turn.aborted" }> = { ...base(session, "opencode.sse.lifecycle"), type: "turn.aborted", turnId, reason: "failed" };
      if (message) aborted.message = message;
      this.emit(aborted);
    }
    const stateChanged: Extract<RuntimeEvent, { type: "session.state.changed" }> = { ...base(session, "opencode.sse.lifecycle"), type: "session.state.changed", state: "error" };
    if (message) stateChanged.message = message;
    this.emit(stateChanged);
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.exited", code });
    this.sessions.delete(session.threadId);
    session.eventsAbort.abort();
  }

  private emitTokenUsage(session: OpenCodeSession, usage: TokenUsage): void {
    this.emit({ ...base(session), type: "thread.token-usage.updated", usage });
  }

  private maybeEmitAssistantTokenUsage(session: OpenCodeSession, messageId: string, tokens: OpenCodeJsonValue | null | undefined): void {
    const usage = normalizeOpenCodeTokenUsage(tokens, session.contextWindow);
    const usageKey = usage ? buildOpenCodeTokenUsageKey({ messageId, tokens, contextWindow: session.contextWindow }) : undefined;
    if (!usage || !usageKey || usageKey === session.lastEmittedTokenUsageKey) return;
    session.lastEmittedTokenUsageKey = usageKey;
    this.emitTokenUsage(session, usage);
  }

  private handleEvent(session: OpenCodeSession, event: OpenCodeEvent): void {
    const p = event.properties ?? {}; const active = session.activeTurnId;
    switch (event.type) {
      case "message.updated": {
        const info = record(p.info);
        const messageId = textField(info?.id);
        const role = textField(info?.role);
        if (info && messageId && role) {
          session.messageRoleById.set(messageId, role);
          if (role === "assistant" && info.tokens !== undefined) {
            this.maybeEmitAssistantTokenUsage(session, messageId, info.tokens);
          }
          for (const part of session.partById.values()) if (part.messageID === messageId) this.handlePart(session, part);
        }
        break;
      }
      case "message.removed": { const removedId = textField(p.messageID); if (removedId) session.messageRoleById.delete(removedId); break; }
      case "message.part.delta": { const partId = textField(p.partID); const part = partId !== undefined ? session.partById.get(partId) : undefined; const role = part?.messageID !== undefined ? session.messageRoleById.get(textField(part.messageID) ?? "") : undefined; const delta = textField(p.delta); if (!part || partId === undefined || (role !== undefined && role !== "assistant") || !active || delta === undefined) break; const prior = session.emittedTextByPartId.get(partId) ?? ""; const merged = appendOpenCodeTextDelta(prior, delta); session.emittedTextByPartId.set(partId, merged.text); this.emit({ ...base(session), type: "item.updated", turnId: active, item: { itemId: partId, kind: part.type === "reasoning" ? "reasoning_text" : "assistant_text", status: "in-progress", text: merged.text } }); break; }
      case "message.part.updated": this.handlePart(session, record(p.part)); break;
      case "session.next.step.ended": {
        const usage = normalizeOpenCodeTokenUsage(p.tokens, session.contextWindow);
        if (usage) this.emitTokenUsage(session, usage);
        break;
      }
      case "session.idle": this.complete(session); break;
      case "session.status": if (record(p.status)?.type === "idle") this.complete(session); break;
       case "session.error": if (active) { session.activeTurnId = undefined; this.emit({ ...base(session), type: "turn.aborted", turnId: active, reason: "failed", message: errorMessage(p.error) }); } this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.state.changed", state: "error", message: errorMessage(p.error) }); break;
       case "permission.asked":
       case "permission.v2.asked": void this.permissionAsked(session, p); break;
       case "permission.replied":
       case "permission.v2.replied": session.pendingPermissions.delete(String(p.requestID)); break;
       case "question.asked":
       case "question.v2.asked": this.questionAsked(session, p); break;
       case "question.replied":
       case "question.v2.replied": this.questionResolved(session, String(p.requestID), answerRows(p.answers)); break;
       case "question.rejected":
       case "question.v2.rejected": this.questionResolved(session, String(p.requestID), []); break;
      default: break;
    }
  }

  private handlePart(session: OpenCodeSession, part: RecordLike | undefined, subagentToolUseId?: string): void {
     if (!part || !session.activeTurnId) return; const partId = textField(part.id); if (!partId) return; session.partById.set(partId, part); const turnId = session.activeTurnId;
     // A settled run's tail is dropped before anything is emitted: re-projecting
     // it would orphan items under a tool-use id no run nests anymore (the same
     // rule as ClaudeAdapter's settledSubagents tail drop).
     if (subagentToolUseId && session.settledSubagentToolUseIds.has(subagentToolUseId)) return;
     if (part.type === "text" || part.type === "reasoning") { const role = part.messageID !== undefined ? session.messageRoleById.get(textField(part.messageID) ?? "") : undefined; if (role !== undefined && role !== "assistant") return; if (role === undefined) return; const hadPart = session.emittedTextByPartId.has(partId); const merged = reconcileOpenCodeText(session.emittedTextByPartId.get(partId), String(part.text ?? "")); session.emittedTextByPartId.set(partId, merged.text); const kind = part.type === "reasoning" ? "reasoning_text" : "assistant_text"; if (merged.delta || !hadPart) { const updated: Extract<RuntimeEvent, { type: "item.started" | "item.updated" }> = { ...base(session), type: hadPart ? "item.updated" : "item.started", turnId, item: { itemId: partId, kind, status: "in-progress", text: merged.text } }; if (subagentToolUseId) updated.subagentToolUseId = subagentToolUseId; this.emit(updated); } if (record(part.time)?.end && !session.completedTextPartIds.has(partId)) { session.completedTextPartIds.add(partId); const completed: Extract<RuntimeEvent, { type: "item.completed" }> = { ...base(session), type: "item.completed", turnId, item: { itemId: partId, kind, status: "completed", text: merged.text } }; if (subagentToolUseId) completed.subagentToolUseId = subagentToolUseId; this.emit(completed); } return; }
     if (part.type !== "tool") return; const state = record(part.state) ?? {}; const kind = toolKind(String(part.tool ?? "tool"));
    if (kind === "plan_text") { const parsed = parseTodoWriteInput(JSON.stringify(state.input ?? {})); if (parsed) session.planTasks = reconcilePlanTasks(session.planTasks, parsed); const item: RuntimeItem = { itemId: `${turnId}:plan`, kind, status: toolStatus(String(state.status)), text: formatPlanTasks(session.planTasks), tasks: session.planTasks }; const planEvent: Extract<RuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }> = { ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item }; if (subagentToolUseId) planEvent.subagentToolUseId = subagentToolUseId; this.emit(planEvent); return; }
    const item: RuntimeItem = { itemId: String(part.callID ?? partId), kind: "tool_call", status: toolStatus(String(state.status)), text: String(state.title ?? part.tool ?? ""), name: String(part.tool ?? "tool") };
    const detail = detailForTool(state);
    if (detail) item.detail = detail;
    const toolEvent: Extract<RuntimeEvent, { type: "item.started" | "item.updated" | "item.completed" }> = { ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item };
    if (subagentToolUseId) toolEvent.subagentToolUseId = subagentToolUseId;
    this.emit(toolEvent);
    // The child's own tool calls are progress hints on the run; the parent's
    // `task` call is the run itself.
    if (subagentToolUseId) {
      const run = session.subagentRuns.get(subagentToolUseId);
      if (run) {
        run.snapshot.lastToolName = String(part.tool ?? "tool");
        if (!run.childToolPartIds.has(partId)) {
          run.childToolPartIds.add(partId);
          run.snapshot.toolUses = (run.snapshot.toolUses ?? 0) + 1;
        }
        this.emitSubagent(session, run, "subagent.updated");
      }
    } else if (String(part.tool ?? "") === "task") {
      this.handleTaskTool(session, part, state);
    }
  }

  /** Recognizes an opencode `task` tool call as a provider-native subagent run.
   *  The tool part's `state.metadata` carries the child session id opencode
   *  created for the delegated agent, plus its model; the input carries the
   *  brief. Status mirrors the tool part's state ladder, and the run settles
   *  when the tool part completes/errors (which happens only after the child
   *  session's events have streamed). */
  private handleTaskTool(session: OpenCodeSession, part: RecordLike, state: RecordLike): void {
    const toolUseId = String(part.callID ?? part.id);
    const input = record(state.input) ?? {};
    const metadata = record(state.metadata) ?? {};
    const childSessionId = stringField(metadata, "sessionId");
    const status = subagentStatus(state.status);
    if (childSessionId) session.subagentChildSessions.set(childSessionId, toolUseId);

    // opencode re-delivers the completed tool part (each parent message.updated
    // re-iterates every part), and a re-created run would re-settle and emit a
    // second subagent.completed. A settled id is terminal — keep only the child
    // mapping, announce nothing.
    if (session.settledSubagentToolUseIds.has(toolUseId)) return;

    const existing = session.subagentRuns.get(toolUseId);
    if (existing) {
      existing.snapshot.status = status;
      if (status === "completed" || status === "failed") this.settleSubagent(session, existing, status, state);
      else this.emitSubagent(session, existing, "subagent.updated");
      return;
    }
    const snapshot = buildOpenCodeSubagentSnapshot({
      toolUseId,
      status,
      toolInput: input,
      toolMetadata: metadata,
      stateTitle: state.title,
      childSessionId,
      variant: session.variant,
    });
    const run: OpenCodeSubagentRun = { snapshot, announced: false, settled: false, childToolPartIds: new Set(), turnId: session.activeTurnId ?? "" };
    session.subagentRuns.set(toolUseId, run);
    if (status === "completed" || status === "failed") this.settleSubagent(session, run, status, state);
    else this.emitSubagent(session, run, "subagent.started");
  }

  /** Folds a child session's events into its run: roles, transcript items
   *  (scoped with the run's tool-use id), token spend. Never touches the parent
   *  turn's lifecycle — the child going idle is not the parent finishing. */
  private handleChildEvent(session: OpenCodeSession, toolUseId: string, event: OpenCodeEvent): void {
    const p = event.properties ?? {};
    // A settled run's in-flight tail is dropped the same way the Claude adapter
    // drops one — the run is closed, and re-projecting its leftovers would
    // orphan items under an id no run nests anymore.
    if (session.settledSubagentToolUseIds.has(toolUseId)) return;
    const run = session.subagentRuns.get(toolUseId);
    switch (event.type) {
      case "message.updated": {
        const info = record(p.info);
        const messageId = textField(info?.id);
        const role = textField(info?.role);
        if (info && messageId && role) {
          session.messageRoleById.set(messageId, role);
          if (role === "assistant" && info.tokens !== undefined && run) {
            const usage = normalizeOpenCodeTokenUsage(info.tokens);
            if (usage?.total !== undefined) run.snapshot.tokens = usage.total;
          }
          for (const part of session.partById.values()) if (part.messageID === messageId) this.handlePart(session, part, toolUseId);
        }
        break;
      }
      case "message.part.delta": {
        const partId = textField(p.partID);
        const part = partId !== undefined ? session.partById.get(partId) : undefined;
        const role = part?.messageID !== undefined ? session.messageRoleById.get(textField(part.messageID) ?? "") : undefined;
        const delta = textField(p.delta);
        if (!part || partId === undefined || (role !== undefined && role !== "assistant") || !session.activeTurnId || delta === undefined) break;
        const prior = session.emittedTextByPartId.get(partId) ?? "";
        const merged = appendOpenCodeTextDelta(prior, delta);
        session.emittedTextByPartId.set(partId, merged.text);
        this.emit({ ...base(session), type: "item.updated", turnId: session.activeTurnId, item: { itemId: partId, kind: part.type === "reasoning" ? "reasoning_text" : "assistant_text", status: "in-progress", text: merged.text }, subagentToolUseId: toolUseId });
        break;
      }
      case "message.part.updated": this.handlePart(session, record(p.part), toolUseId); break;
      case "permission.asked":
      case "permission.v2.asked": void this.permissionAsked(session, p, toolUseId); break;
      case "session.next.step.ended": {
        if (!run) break;
        const usage = normalizeOpenCodeTokenUsage(p.tokens);
        if (usage?.total !== undefined) run.snapshot.tokens = usage.total;
        this.emitSubagent(session, run, "subagent.updated");
        break;
      }
      case "session.error": {
        if (!run) break;
        this.settleSubagent(session, run, "failed", { error: errorMessage(p.error) });
        break;
      }
      case "session.status": if (record(p.status)?.type === "idle" && run) this.emitSubagent(session, run, "subagent.updated"); break;
      default: break;
    }
  }

  private emitSubagent(session: OpenCodeSession, run: OpenCodeSubagentRun, type: "subagent.started" | "subagent.updated" | "subagent.completed"): void {
    // The run's own turn, not the session's current one. A run settled at the
    // turn boundary — which is every run still live when a turn ends — would
    // otherwise emit nothing at all, and its row would spin forever.
    const turnId = run.turnId || session.activeTurnId;
    if (!turnId || run.settled && type !== "subagent.completed") return;
    if (!run.snapshot.model && session.model) run.snapshot.model = session.model;
    run.announced = true;
    this.emit({ ...base(session), type, turnId, subagent: { ...run.snapshot } });
  }

  /** Idempotent run close: stamp the final status and emit once. */
  private settleSubagent(session: OpenCodeSession, run: OpenCodeSubagentRun, status: SubagentStatus, state: RecordLike): void {
    if (run.settled) return;
    run.settled = true;
    run.snapshot.status = status;
    run.snapshot.endedAt = Date.now();
    // Remember the id so neither a re-delivered tool part nor the child's event
    // tail can resurrect the run (see handleTaskTool / handleChildEvent).
    session.settledSubagentToolUseIds.add(run.snapshot.toolUseId);
    if (status === "completed") {
      const summary = openCodeTaskSummary(state.output);
      if (summary) run.snapshot.summary = summary;
    } else {
      const error = textField(state.error) || openCodeTaskSummary(state.output);
      if (error) run.snapshot.summary = error;
    }
    this.emitSubagent(session, run, "subagent.completed");
    session.subagentRuns.delete(run.snapshot.toolUseId);
    // The child-session → tool-use-id mapping is only useful while the run is
    // live; drop it on settle so stale entries can't accumulate and route a
    // later unrelated session's events into a finished run.
    if (run.snapshot.taskId) session.subagentChildSessions.delete(run.snapshot.taskId);
  }

  /** Settle anything still live — the turn ended or the session is going away.
   *
   *  Everything, background runs included — deliberately, and the opposite of
   *  what the Claude adapter does.
   *
   *  Claude spares a backgrounded run here because its notifications keep
   *  arriving on the same session afterwards, so settling early would stamp a
   *  status the run had not earned. opencode does not work that way. A
   *  backgrounded child reports by having the server open a NEW turn on the
   *  parent session with a synthetic prompt carrying the result — nothing
   *  further arrives against the turn that launched it. So a run spared at this
   *  boundary has no path left to settle on and would dangle running forever,
   *  which is the worse of the two wrongs.
   *
   *  That server-initiated turn is its own gap: `sendTurn` is the only place
   *  this adapter opens a turn, so a prompt the server starts by itself arrives
   *  with no `activeTurnId` and `handlePart` drops the whole thing. Adopting
   *  those turns — not sparing runs here — is what backgrounded subagents would
   *  need. It is unreachable today: the tool refuses `background` unless the CLI
   *  is run with the experimental flag that enables it, and kone does not set
   *  it. */
  private settleLiveSubagents(session: OpenCodeSession, status: SubagentStatus): void {
    for (const run of session.subagentRuns.values()) this.settleSubagent(session, run, status, {});
  }

  /** Closes the active turn on idle. `session.abort` also lands as idle, so an
   *  in-flight interrupt is reported as `interrupted` rather than completed. */
  private complete(session: OpenCodeSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    const interrupting = session.interrupting;
    // Runs are closed out BEFORE the turn loses its id. They used to be settled
    // after, and emitSubagent reads the session's turn — so every run still
    // live at the boundary was stamped in memory and announced to nobody, and
    // its row spun forever in a turn that had already finished.
    this.settleLiveSubagents(session, interrupting ? "stopped" : "completed");
    // Cleared after the settle, but still before the terminal turn event, so a
    // late stray idle can't close the same turn twice.
    session.activeTurnId = undefined;
    session.interrupting = false;
    if (interrupting) this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "interrupted" });
    else this.emit({ ...base(session), type: "turn.completed", turnId, conversationId: session.openCodeSessionId });
  }
  private async permissionAsked(session: OpenCodeSession, p: RecordLike, subagentToolUseId?: string): Promise<void> { const requestId = String(p.id ?? p.requestID); /* Fail closed: a permission recovered without an active turn has no trustworthy interaction mode — reply reject instead of parking a modal nothing will ever answer (e.g. a request left by an interrupted turn or a resumed session with no prompt in flight). */ if (!session.activeTurnId) { session.pendingPermissions.set(requestId, p.permission ?? null); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: "reject" }).catch(() => { /* provider will surface session.error */ }); return; } /* `full-access` never parks: an ask is auto-approved rather than surfacing a prompt — the rung's contract is "never prompts". The one exception is a command that is irreversible past the working tree, which this gate is now the last place to stop (see permissionRules). */ if (session.mode === "full-access") { session.pendingPermissions.delete(requestId); const refusal = criticalCommandInPermission(p, session.threadId); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: refusal ? "reject" : "once" }).catch(() => { /* provider will surface session.error */ }); return; } session.pendingPermissions.set(requestId, p.permission ?? null); const approval = openCodeApprovalRequest(p.permission); const decision = await new Promise<ApprovalDecision>((resolve) => { session.pendingApprovals.set(requestId, { approval, resolve: (decision) => { resolve(decision); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: toOpenCodeReply(decision) }).catch(() => { /* provider will surface session.error */ }); }, subagentToolUseId }); const approvalRequested: Extract<RuntimeEvent, { type: "approval.requested" }> = { ...base(session), type: "approval.requested", requestId, turnId: session.activeTurnId, approval }; if (subagentToolUseId) approvalRequested.subagentToolUseId = subagentToolUseId; this.emit(approvalRequested); }); this.emit({ ...base(session), type: "approval.resolved", requestId, decision }); }
  /** Settle one parked permission approval (idempotent — a no-op once drained). */
  private resolveApproval(session: OpenCodeSession, requestId: string, decision: ApprovalDecision): void { const pending = session.pendingApprovals.get(requestId); if (!pending) return; session.pendingApprovals.delete(requestId); pending.resolve(decision); }
  private questionAsked(session: OpenCodeSession, p: RecordLike): void { const questions = (Array.isArray(p.questions) ? p.questions : []).map((entry, i) => { const q = record(entry) ?? {}; return { id: `question-${i}-${String(q.header ?? "question").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, header: String(q.header ?? "Question"), question: String(q.question ?? ""), options: Array.isArray(q.options) ? q.options.map((optionEntry) => { const o = record(optionEntry) ?? {}; const option: UserInputQuestionOption = { label: String(o.label ?? "") }; if (o.description) option.description = String(o.description); return option; }) : [], multiSelect: q.multiple === true }; }); const requestId = String(p.id); this.emit({ ...base(session), type: "user-input.requested", requestId, turnId: session.activeTurnId, questions }); session.pendingUserInputs.set(requestId, { questions, resolve: (answers) => { void session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`, { answers: questions.map((q) => { const value = answers[q.id]; return Array.isArray(value) ? value : value == null ? [] : [value]; }) }); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers }); } }); }
  private questionResolved(session: OpenCodeSession, requestId: string, answers: string[][]): void { const pending = session.pendingUserInputs.get(requestId); if (!pending) return; const mapped: UserInputAnswers = {}; pending.questions.forEach((q, i) => { mapped[q.id] = answers[i]?.join(", ") ?? ""; }); session.pendingUserInputs.delete(requestId); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers: mapped }); }
}
