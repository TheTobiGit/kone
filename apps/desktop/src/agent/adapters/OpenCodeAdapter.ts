import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { formatPlanTasks, parseTodoWriteInput, reconcilePlanTasks } from "../planTasks.js";
import { probe } from "../spawn.js";
import { buildOpenCodeEnv, classifyOpenCodeSpawnFailure, isOpenCodeVersionSupported, MINIMUM_OPENCODE_VERSION, OPENCODE_BINARY, parseOpenCodeVersion } from "../opencodeHome.js";
import { startOpenCodeServer, type OpenCodeServer } from "../opencodeServer.js";
import { koneHostContextForFirstRun } from "../gateway/appContext.js";
import { buildOpenCodeMcpServer } from "../gateway/injection.js";
import type { ApprovalDecision, ApprovalRequest, ApprovalRequestKind, EmitEvent, GatewayConnection, InteractionMode, ModelDescriptor, PlanTask, ProviderAdapter, ProviderConfig, ProviderStatus, RuntimeEvent, RuntimeItem, RuntimeItemKind, RuntimeItemStatus, Session, SendTurnInput, SessionStartInput, SubagentRunSnapshot, SubagentStatus, TokenUsage, TurnStartResult, UserInputAnswers, UserInputQuestion } from "../types.js";

type RecordLike = Record<string, any>;
type OpenCodeEvent = { type: string; properties?: RecordLike };
type OpenCodeClient = { request(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<any>; events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> };
/** One opencode `task` tool call, recognized from its tool part. opencode runs
 *  the child as a *separate session* on the same server, so we also track the
 *  child session id (from `state.metadata.sessionId`) to route its events back
 *  into the run's transcript. */
type OpenCodeSubagentRun = {
  snapshot: SubagentRunSnapshot;
  announced: boolean;
  settled: boolean;
  childToolPartIds: Set<string>;
};
type OpenCodeSession = {
  threadId: string; cwd: string; model?: string; variant?: string; contextWindow?: number; mode: InteractionMode; baseUrl: string;
  client: OpenCodeClient; server: OpenCodeServer; openCodeSessionId: string; activeTurnId?: string;
  /** The kone gateway connection minted at startSession — the agent's app tools. */
  gatewayConnection?: GatewayConnection;
  /** User turns sent so far; the kone host-context block rides the first one. */
  runOrdinal: number;
  /** Set only when `SessionStartInput.resume` was actually adopted — see Session.resumedFrom. */
  resumedFrom?: string;
  eventsAbort: AbortController; messageRoleById: Map<string, string>; partById: Map<string, RecordLike>;
  emittedTextByPartId: Map<string, string>; completedTextPartIds: Set<string>;
  lastEmittedTokenUsageKey?: string;
  pendingPermissions: Map<string, string>; pendingUserInputs: Map<string, { questions: UserInputQuestion[]; resolve: (answers: UserInputAnswers) => void }>;
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

function record(value: unknown): RecordLike | undefined { return value && typeof value === "object" ? value as RecordLike : undefined; }
function responseData(value: any): any { return value?.data ?? value; }
function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  // Provider payloads (e.g. session.error) carry plain `{ message }` objects —
  // String() would render "[object Object]".
  const r = record(error);
  if (r && typeof r.message === "string" && r.message) return r.message;
  return String(error);
}
function statusOf(error: unknown): number | undefined {
  const r = record(error); const response = record(r?.response);
  return typeof r?.status === "number" ? r.status : typeof r?.statusCode === "number" ? r.statusCode : typeof response?.status === "number" ? response.status : undefined;
}

/** Parses OpenCode's pretty-printed, slug-prefixed model inventory. */
export function parseOpenCodeModels(stdout: string): ModelDescriptor[] {
  const models: ModelDescriptor[] = [];
  let slug: string | undefined; let json: string[] = [];
  const flush = () => {
    if (!slug) return;
    try {
       const model = JSON.parse(json.join("\n")) as RecordLike;
       const name = typeof model.name === "string" ? model.name.trim() : "";
       if (!name) return;
       const providerId = typeof model.providerID === "string" ? model.providerID.trim() : "";
       const modelId = typeof model.id === "string" ? model.id.trim() : "";
       const id = providerId && modelId ? `${providerId}/${modelId}` : slug;
       const variants = record(model.variants);
       const efforts = variants ? Object.keys(variants) : [];
        const limit = record(model.limit);
        const contextWindowTokens = typeof limit?.context === "number" && Number.isFinite(limit.context) && limit.context > 0 ? limit.context : undefined;
        models.push({ id, label: name, ...(contextWindowTokens !== undefined ? { contextWindowTokens } : {}), ...(efforts.length ? { reasoningEfforts: efforts } : {}), ...(efforts.includes("medium") ? { defaultReasoningEffort: "medium" } : efforts.includes("high") ? { defaultReasoningEffort: "high" } : {}) });
    } catch { /* skip one malformed block */ }
  };
  for (const line of stdout.split(/\r?\n/)) {
    const match = SLUG_LINE.exec(line);
    if (match) { flush(); slug = match[1]; json = []; }
    else if (slug) json.push(line);
  }
  flush();
  return models;
}

export function reconcileOpenCodeText(previous: string | undefined, snapshot: string): { text: string; delta: string } {
  const old = previous ?? "";
  const text = old.startsWith(snapshot) ? old : snapshot;
  let common = 0; while (common < old.length && common < text.length && old[common] === text[common]) common += 1;
  return { text, delta: text.slice(common) };
}

export function appendOpenCodeTextDelta(previous: string, delta: string): { text: string; delta: string } {
  return { text: previous + delta, delta };
}

/** Only structured 404s permit a resume cursor to be discarded. */
export function isOpenCodeNotFound(value: unknown): boolean {
  const queue: unknown[] = [value]; const seen = new Set<unknown>();
  for (let i = 0; queue.length && i < 32; i += 1) {
    const node = queue.shift(); const r = record(node); if (!r || seen.has(node)) continue; seen.add(node);
    const status = statusOf(r); if (status === 404) return true; if (status !== undefined) continue;
    if (typeof r.name === "string" && r.name.toLowerCase() === "notfounderror") return true;
    for (const key of ["cause", "body", "error", "data"]) if (r[key] !== undefined) queue.push(r[key]);
  }
  return false;
}

export function accumulateOpenCodeTokens(current: { input: number; output: number }, tokens: unknown): { input: number; output: number } {
  const t = record(tokens); if (!t) return current;
  return { input: current.input + (typeof t.input === "number" ? t.input : 0), output: current.output + (typeof t.output === "number" ? t.output : 0) + (typeof t.reasoning === "number" ? t.reasoning : 0) };
}

function nonNegativeInteger(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && Number.isInteger(value) ? value : undefined;
}

function stringField(value: unknown, key: string): string | undefined {
  const field = record(value)?.[key];
  return typeof field === "string" ? field : undefined;
}

function openCodeModelName(metadata: RecordLike | undefined): string | undefined {
  const providerID = stringField(metadata, "providerID");
  const modelID = stringField(metadata, "modelID");
  return providerID && modelID ? `${providerID}/${modelID}` : undefined;
}

/** The one-line brief the parent handed the child. */
function subagentDescription(input: RecordLike | undefined, title: unknown): string | undefined {
  return stringField(input, "description") ?? (typeof title === "string" && title ? title : undefined);
}

/** The agent definition invoked, e.g. `explore` / `general`. */
function subagentType(input: RecordLike | undefined): string | undefined {
  return stringField(input, "subagent_type");
}

function subagentStatus(status: unknown): SubagentStatus {
  if (status === "completed") return "completed";
  if (status === "error") return "failed";
  if (status === "pending") return "starting";
  return "running";
}

/** Strip the `<task>`/`<task_result>` wrapper opencode renders around the
 *  child's final output into a plain summary. */
function openCodeTaskSummary(output: unknown): string | undefined {
  if (typeof output !== "string" || !output) return undefined;
  const cleaned = output.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
  return cleaned || undefined;
}

/** OpenCode reports cumulative session totals on assistant messages and step ends. */
export function normalizeOpenCodeTokenUsage(tokens: unknown, contextWindow?: number): TokenUsage | undefined {
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
  const normalizedContextWindow = typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
    ? contextWindow
    : undefined;
  const contextUsed = normalizedContextWindow !== undefined ? Math.min(total, normalizedContextWindow) : total;
  return {
    input: inputTokens,
    output: outputTokens + reasoningOutputTokens,
    total,
    contextUsed,
    ...(normalizedContextWindow !== undefined ? { contextWindow: normalizedContextWindow } : {}),
  };
}

export function buildOpenCodeTokenUsageKey(input: {
  messageId: string;
  tokens: unknown;
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
  const normalizedContextWindow = typeof input.contextWindow === "number" && Number.isFinite(input.contextWindow) && input.contextWindow > 0
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
  if (mode === "full-access") return [{ permission: "*", pattern: "*", action: "allow" }];
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
function openCodeApprovalRequest(permission: unknown): ApprovalRequest {
  const permissionRecord = record(permission);
  const raw =
    typeof permission === "string"
      ? permission
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
function detailForTool(state: RecordLike): string | undefined { return typeof state.output === "string" ? state.output : typeof state.error === "string" ? state.error : typeof state.title === "string" ? state.title : undefined; }

function base(session: OpenCodeSession, source: RuntimeEvent["source"] = "opencode.sse.message"): Omit<RuntimeEvent, "type"> {
  return { threadId: session.threadId, provider: "opencode", at: Date.now(), source, refs: { conversationId: session.openCodeSessionId } } as Omit<RuntimeEvent, "type">;
}

function makeClient(baseUrl: string): OpenCodeClient {
  const url = (route: string) => `${baseUrl.replace(/\/$/, "")}${route}`;
  return {
    async request(method, route, body, signal) {
      const response = await fetch(url(route), { method, signal, headers: body === undefined ? undefined : { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
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
          for (const frame of frames) { const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n"); if (data) { try { yield JSON.parse(data) as OpenCodeEvent; } catch { /* ignore malformed SSE */ } } }
        }
      } finally { reader.releaseLock(); }
    },
  };
}

export function translateOpenCodeEvent(sessionId: string, event: OpenCodeEvent): boolean {
  const properties = event.properties;
  return properties?.sessionID === sessionId
    || properties?.info?.sessionID === sessionId
    || properties?.part?.sessionID === sessionId
    || properties?.tool?.sessionID === sessionId;
}

export function isOpenCodeTurnEnd(event: OpenCodeEvent): boolean {
  return event.type === "session.idle" || (event.type === "session.status" && event.properties?.status?.type === "idle");
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
  stateTitle: unknown;
  childSessionId: string | undefined;
  variant?: string;
}): SubagentRunSnapshot {
  const { toolUseId, status, toolInput, toolMetadata, stateTitle, childSessionId, variant } = input;
  return {
    toolUseId,
    parentItemId: toolUseId,
    status,
    startedAt: Date.now(),
    ...(childSessionId ? { taskId: childSessionId } : {}),
    ...(subagentType(toolInput) ? { agentType: subagentType(toolInput) } : {}),
    ...(subagentDescription(toolInput, stateTitle) ? { description: subagentDescription(toolInput, stateTitle) } : {}),
    ...(stringField(toolInput, "prompt") ? { prompt: stringField(toolInput, "prompt") } : {}),
    ...(openCodeModelName(toolMetadata) ? { model: openCodeModelName(toolMetadata) } : {}),
    ...(toolMetadata.background === true || toolInput.background === true ? { background: true } : {}),
    ...(variant ? { effort: variant } : {}),
  };
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
    const env = await buildOpenCodeEnv(); const output = await probe(this.binary, ["--version"], env, 5_000);
    if (output === null) return classifyOpenCodeSpawnFailure(new Error("ENOENT"));
    const version = parseOpenCodeVersion(output);
    if (!isOpenCodeVersionSupported(version)) return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", version, message: `OpenCode v${version ?? "unknown"} is too old. Upgrade to v${MINIMUM_OPENCODE_VERSION} or newer.` };
    try { const models = await this.listModels(); return { provider: "opencode", label: "OpenCode", available: true, authStatus: models.length ? "authenticated" : "unknown", readiness: models.length ? "ready" : "needs-login", version, message: models.length ? undefined : "OpenCode is available, but no connected providers were reported. Run `opencode providers login`." }; }
    catch { return { provider: "opencode", label: "OpenCode", available: true, authStatus: "unknown", readiness: "error", version, message: "OpenCode model inventory could not be read." }; }
  }

  async listModels(): Promise<ModelDescriptor[]> {
    if (!this.modelsCache) this.modelsCache = this.fetchModels().catch((error) => { this.modelsCache = null; throw error; });
    return this.modelsCache;
  }
  private async fetchModels(): Promise<ModelDescriptor[]> {
    const env = await buildOpenCodeEnv();
    for (let attempt = 0; attempt < 2; attempt += 1) { const output = await probe(this.binary, ["models", "--verbose"], env, 30_000); if (output !== null) { const models = parseOpenCodeModels(output); if (models.length || attempt === 1) { for (const model of models) if (model.contextWindowTokens !== undefined) this.modelContextWindows.set(model.id, model.contextWindowTokens); return models; } } if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    throw new Error("OpenCode model inventory failed.");
  }

  async startSession(input: SessionStartInput): Promise<Session> {
    const prior = this.sessions.get(input.threadId); if (prior) await this.stopSession(input.threadId);
    const mode = input.mode ?? "accept-edits"; const env = await buildOpenCodeEnv(); const server = await startOpenCodeServer({ cwd: input.cwd, env, binary: this.binary });
    const client = makeClient(server.baseUrl); let sessionId: string | undefined;
    const resume = input.resume?.trim();
    if (resume && /^ses_/.test(resume)) {
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
        const koneStatus = record(mcpResult)?.["kone"];
        if (koneStatus?.status !== "connected") {
          console.error(
            `[opencode] kone MCP server did not connect: ${koneStatus?.error ?? "unknown status"}`,
          );
        }
      } catch (error) {
        console.error("[opencode] kone MCP registration failed:", errorMessage(error));
      }
    }
    const session: OpenCodeSession = { threadId: input.threadId, cwd: input.cwd, model: input.model, variant: input.effort, contextWindow: input.model ? this.modelContextWindows.get(input.model) : undefined, mode, baseUrl: server.baseUrl, client, server, openCodeSessionId: sessionId, resumedFrom, gatewayConnection: input.gatewayConnection, runOrdinal: 0, eventsAbort: new AbortController(), messageRoleById: new Map(), partById: new Map(), emittedTextByPartId: new Map(), completedTextPartIds: new Set(), pendingPermissions: new Map(), pendingUserInputs: new Map(), pendingApprovals: new Map(), subagentRuns: new Map(), subagentChildSessions: new Map(), settledSubagentToolUseIds: new Set(), disposed: false, interrupting: false, planTasks: [], exitNotified: false };
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
      gatewayControlAvailable: session.gatewayConnection !== undefined,
    });
    session.runOrdinal += 1;
    if (!prompt && !files.length) throw new Error("Turn input must include text or an attachment.");
    if (input.model) { session.model = input.model; session.contextWindow = this.modelContextWindows.get(input.model); }
    const model = modelSlug(input.model ?? session.model); if (!model) throw new Error("OpenCode model selection must use the 'provider/model' format.");
    const steering = session.activeTurnId; const turnId = steering ?? `opencode-turn-${randomUUID()}`; if (!steering) { session.activeTurnId = turnId; session.lastEmittedTokenUsageKey = undefined; this.emit({ ...base(session), type: "turn.started", turnId }); }
    try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/prompt_async`, { model, ...(input.effort || session.variant ? { variant: input.effort ?? session.variant } : {}), parts: [...(prompt ? [{ type: "text", text: prompt }] : []), ...files] }); }
    catch (error) { if (!steering) { session.activeTurnId = undefined; this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "failed", message: errorMessage(error) }); } throw error; }
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session?.activeTurnId) return; this.drain(session); session.interrupting = true; await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); }
  // `disposed` gates unexpectedExit, so a deliberate stop emits nothing terminal on its
  // own — seal a still-live turn here or the journaled assistant block stays 'running'
  // forever and the thread reopens permanently busy. After settleLiveSubagents, which
  // reads activeTurnId while it's still set.
  async stopSession(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session) return; session.disposed = true; this.drain(session); this.settleLiveSubagents(session, "stopped"); this.abortLiveTurn(session); session.eventsAbort.abort(); try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); } catch { /* best effort */ } await session.server.dispose(); this.sessions.delete(threadId); }
  async stopAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId))); }
  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> { const session = this.require(threadId); this.resolveApproval(session, requestId, decision); /* "Reject and stop" — the permission already gets its `reject` reply (toOpenCodeReply), and aborting the session turns that into an interrupted turn instead of a continued one. */ if (decision === "reject-and-stop") void this.interruptTurn(threadId); }
  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> { const session = this.require(threadId); const pending = session.pendingUserInputs.get(requestId); if (!pending) return; session.pendingUserInputs.delete(requestId); pending.resolve(answers); }
  async listSessions(): Promise<Session[]> { return [...this.sessions.values()].map((session) => this.toSession(session)); }
  async hasSession(threadId: string): Promise<boolean> { return this.sessions.has(threadId); }

  private require(threadId: string): OpenCodeSession { const session = this.sessions.get(threadId); if (!session) throw new Error(`No OpenCode session for thread ${threadId}`); return session; }
  private toSession(s: OpenCodeSession): Session { return { threadId: s.threadId, provider: "opencode", cwd: s.cwd, status: s.activeTurnId ? "running" : "ready", conversationId: s.openCodeSessionId, resumedFrom: s.resumedFrom, activeTurnId: s.activeTurnId, model: s.model, ...(s.variant ? { effort: s.variant } : {}), mode: s.mode }; }
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
    return typeof p.sessionID === "string" ? p.sessionID
      : stringField(p.info, "sessionID") ?? stringField(p.part, "sessionID") ?? stringField(p.tool, "sessionID");
  }

  private unexpectedExit(session: OpenCodeSession, code: number | null, message?: string): void {
    if (session.disposed || session.exitNotified) return;
    session.exitNotified = true;
    // Settle parked approvals/questions so their resolvers resolve and the
    // renderer's modals clear — a crashed provider leaves no reply coming.
    this.drain(session);
    const turnId = session.activeTurnId;
    session.activeTurnId = undefined;
    this.settleLiveSubagents(session, "failed");
    if (turnId) this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "turn.aborted", turnId, reason: "failed", ...(message ? { message } : {}) });
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.state.changed", state: "error", ...(message ? { message } : {}) });
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.exited", code });
    this.sessions.delete(session.threadId);
    session.eventsAbort.abort();
  }

  private emitTokenUsage(session: OpenCodeSession, usage: TokenUsage): void {
    this.emit({ ...base(session), type: "thread.token-usage.updated", usage });
  }

  private maybeEmitAssistantTokenUsage(session: OpenCodeSession, messageId: string, tokens: unknown): void {
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
        if (info?.id && info.role) {
          session.messageRoleById.set(info.id, info.role);
          if (info.role === "assistant" && info.tokens !== undefined) {
            this.maybeEmitAssistantTokenUsage(session, info.id, info.tokens);
          }
          for (const part of session.partById.values()) if (part.messageID === info.id) this.handlePart(session, part);
        }
        break;
      }
      case "message.removed": session.messageRoleById.delete(p.messageID); break;
      case "message.part.delta": { const part = session.partById.get(p.partID); const role = part?.messageID ? session.messageRoleById.get(part.messageID) : undefined; if (!part || (role !== undefined && role !== "assistant") || !active || typeof p.delta !== "string") break; const prior = session.emittedTextByPartId.get(p.partID) ?? ""; const merged = appendOpenCodeTextDelta(prior, p.delta); session.emittedTextByPartId.set(p.partID, merged.text); this.emit({ ...base(session), type: "item.updated", turnId: active, item: { itemId: p.partID, kind: part.type === "reasoning" ? "reasoning_text" : "assistant_text", status: "in-progress", text: merged.text } }); break; }
      case "message.part.updated": this.handlePart(session, p.part); break;
      case "session.next.step.ended": {
        const usage = normalizeOpenCodeTokenUsage(p.tokens, session.contextWindow);
        if (usage) this.emitTokenUsage(session, usage);
        break;
      }
      case "session.idle": this.complete(session); break;
      case "session.status": if (p.status?.type === "idle") this.complete(session); break;
       case "session.error": if (active) { session.activeTurnId = undefined; this.emit({ ...base(session), type: "turn.aborted", turnId: active, reason: "failed", message: errorMessage(p.error) }); } this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.state.changed", state: "error", message: errorMessage(p.error) }); break;
       case "permission.asked":
       case "permission.v2.asked": void this.permissionAsked(session, p); break;
       case "permission.replied":
       case "permission.v2.replied": session.pendingPermissions.delete(p.requestID); break;
       case "question.asked":
       case "question.v2.asked": this.questionAsked(session, p); break;
       case "question.replied":
       case "question.v2.replied": this.questionResolved(session, p.requestID, p.answers ?? []); break;
       case "question.rejected":
       case "question.v2.rejected": this.questionResolved(session, p.requestID, []); break;
      default: break;
    }
  }

  private handlePart(session: OpenCodeSession, part: RecordLike | undefined, subagentToolUseId?: string): void {
     if (!part || !session.activeTurnId) return; session.partById.set(part.id, part); const turnId = session.activeTurnId;
     // A settled run's tail is dropped before anything is emitted: re-projecting
     // it would orphan items under a tool-use id no run nests anymore (the same
     // rule as ClaudeAdapter's settledSubagents tail drop).
     if (subagentToolUseId && session.settledSubagentToolUseIds.has(subagentToolUseId)) return;
     if (part.type === "text" || part.type === "reasoning") { const role = part.messageID ? session.messageRoleById.get(part.messageID) : undefined; if (role !== undefined && role !== "assistant") return; if (role === undefined) return; const hadPart = session.emittedTextByPartId.has(part.id); const merged = reconcileOpenCodeText(session.emittedTextByPartId.get(part.id), String(part.text ?? "")); session.emittedTextByPartId.set(part.id, merged.text); const kind = part.type === "reasoning" ? "reasoning_text" : "assistant_text"; if (merged.delta || !hadPart) this.emit({ ...base(session), type: hadPart ? "item.updated" : "item.started", turnId, item: { itemId: part.id, kind, status: "in-progress", text: merged.text }, ...(subagentToolUseId ? { subagentToolUseId } : {}) }); if (part.time?.end && !session.completedTextPartIds.has(part.id)) { session.completedTextPartIds.add(part.id); this.emit({ ...base(session), type: "item.completed", turnId, item: { itemId: part.id, kind, status: "completed", text: merged.text }, ...(subagentToolUseId ? { subagentToolUseId } : {}) }); } return; }
    if (part.type !== "tool") return; const state = record(part.state) ?? {}; const kind = toolKind(String(part.tool ?? "tool"));
    if (kind === "plan_text") { const parsed = parseTodoWriteInput(JSON.stringify(state.input ?? {})); if (parsed) session.planTasks = reconcilePlanTasks(session.planTasks, parsed); const item: RuntimeItem = { itemId: `${turnId}:plan`, kind, status: toolStatus(state.status), text: formatPlanTasks(session.planTasks), tasks: session.planTasks }; this.emit({ ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item, ...(subagentToolUseId ? { subagentToolUseId } : {}) }); return; }
    const item: RuntimeItem = { itemId: String(part.callID ?? part.id), kind: "tool_call", status: toolStatus(String(state.status)), text: String(state.title ?? part.tool ?? ""), name: String(part.tool ?? "tool"), ...(detailForTool(state) ? { detail: detailForTool(state) } : {}) };
    this.emit({ ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item, ...(subagentToolUseId ? { subagentToolUseId } : {}) });
    // The child's own tool calls are progress hints on the run; the parent's
    // `task` call is the run itself.
    if (subagentToolUseId) {
      const run = session.subagentRuns.get(subagentToolUseId);
      if (run) {
        run.snapshot.lastToolName = String(part.tool ?? "tool");
        if (!run.childToolPartIds.has(String(part.id))) {
          run.childToolPartIds.add(String(part.id));
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
    const run: OpenCodeSubagentRun = { snapshot, announced: false, settled: false, childToolPartIds: new Set() };
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
        if (info?.id && info.role) {
          session.messageRoleById.set(info.id, info.role);
          if (info.role === "assistant" && info.tokens !== undefined && run) {
            const usage = normalizeOpenCodeTokenUsage(info.tokens);
            if (usage?.total !== undefined) run.snapshot.tokens = usage.total;
          }
          for (const part of session.partById.values()) if (part.messageID === info.id) this.handlePart(session, part, toolUseId);
        }
        break;
      }
      case "message.part.delta": {
        const part = session.partById.get(p.partID);
        const role = part?.messageID ? session.messageRoleById.get(part.messageID) : undefined;
        if (!part || (role !== undefined && role !== "assistant") || !session.activeTurnId || typeof p.delta !== "string") break;
        const prior = session.emittedTextByPartId.get(p.partID) ?? "";
        const merged = appendOpenCodeTextDelta(prior, p.delta);
        session.emittedTextByPartId.set(p.partID, merged.text);
        this.emit({ ...base(session), type: "item.updated", turnId: session.activeTurnId, item: { itemId: p.partID, kind: part.type === "reasoning" ? "reasoning_text" : "assistant_text", status: "in-progress", text: merged.text }, subagentToolUseId: toolUseId });
        break;
      }
      case "message.part.updated": this.handlePart(session, p.part, toolUseId); break;
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
      case "session.status": if (p.status?.type === "idle" && run) this.emitSubagent(session, run, "subagent.updated"); break;
      default: break;
    }
  }

  private emitSubagent(session: OpenCodeSession, run: OpenCodeSubagentRun, type: "subagent.started" | "subagent.updated" | "subagent.completed"): void {
    const turnId = session.activeTurnId;
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
      const error = typeof state.error === "string" && state.error ? state.error : openCodeTaskSummary(state.output);
      if (error) run.snapshot.summary = error;
    }
    this.emitSubagent(session, run, "subagent.completed");
    session.subagentRuns.delete(run.snapshot.toolUseId);
    // The child-session → tool-use-id mapping is only useful while the run is
    // live; drop it on settle so stale entries can't accumulate and route a
    // later unrelated session's events into a finished run.
    if (run.snapshot.taskId) session.subagentChildSessions.delete(run.snapshot.taskId);
  }

  /** Settle anything still live — the turn ended or the session is going away. */
  private settleLiveSubagents(session: OpenCodeSession, status: SubagentStatus): void {
    for (const run of [...session.subagentRuns.values()]) this.settleSubagent(session, run, status, {});
  }

  /** Closes the active turn on idle. `session.abort` also lands as idle, so an
   *  in-flight interrupt is reported as `interrupted` rather than completed. */
  private complete(session: OpenCodeSession): void {
    const turnId = session.activeTurnId;
    if (!turnId) return;
    // Cleared first so a late stray idle can't close the same turn twice.
    session.activeTurnId = undefined;
    const interrupting = session.interrupting;
    session.interrupting = false;
    this.settleLiveSubagents(session, interrupting ? "stopped" : "completed");
    if (interrupting) this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "interrupted" });
    else this.emit({ ...base(session), type: "turn.completed", turnId, conversationId: session.openCodeSessionId });
  }
  private async permissionAsked(session: OpenCodeSession, p: RecordLike, subagentToolUseId?: string): Promise<void> { const requestId = String(p.id ?? p.requestID); /* Fail closed: a permission recovered without an active turn has no trustworthy interaction mode — reply reject instead of parking a modal nothing will ever answer (e.g. a request left by an interrupted turn or a resumed session with no prompt in flight). */ if (!session.activeTurnId) { session.pendingPermissions.set(requestId, p.permission); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: "reject" }).catch(() => { /* provider will surface session.error */ }); return; } /* `full-access` never parks: an ask that still fires (a tool outside the allow-all ruleset, e.g. an MCP tool the rules don't name) is auto-approved rather than surfacing a prompt — the rung's contract is "never prompts". */ if (session.mode === "full-access") { session.pendingPermissions.delete(requestId); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: "once" }).catch(() => { /* provider will surface session.error */ }); return; } session.pendingPermissions.set(requestId, p.permission); const approval = openCodeApprovalRequest(p.permission); const decision = await new Promise<ApprovalDecision>((resolve) => { session.pendingApprovals.set(requestId, { approval, resolve: (decision) => { resolve(decision); void session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply: toOpenCodeReply(decision) }).catch(() => { /* provider will surface session.error */ }); }, subagentToolUseId }); this.emit({ ...base(session), type: "approval.requested", requestId, turnId: session.activeTurnId, approval, ...(subagentToolUseId ? { subagentToolUseId } : {}) }); }); this.emit({ ...base(session), type: "approval.resolved", requestId, decision }); }
  /** Settle one parked permission approval (idempotent — a no-op once drained). */
  private resolveApproval(session: OpenCodeSession, requestId: string, decision: ApprovalDecision): void { const pending = session.pendingApprovals.get(requestId); if (!pending) return; session.pendingApprovals.delete(requestId); pending.resolve(decision); }
  private questionAsked(session: OpenCodeSession, p: RecordLike): void { const questions = (Array.isArray(p.questions) ? p.questions : []).map((q: RecordLike, i: number) => ({ id: `question-${i}-${String(q.header ?? "question").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, header: String(q.header ?? "Question"), question: String(q.question ?? ""), options: Array.isArray(q.options) ? q.options.map((o: RecordLike) => ({ label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}) })) : [], multiSelect: q.multiple === true })); const requestId = String(p.id); this.emit({ ...base(session), type: "user-input.requested", requestId, turnId: session.activeTurnId, questions }); session.pendingUserInputs.set(requestId, { questions, resolve: (answers) => { void session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`, { answers: questions.map((q) => { const value = answers[q.id]; return Array.isArray(value) ? value : value == null ? [] : [value]; }) }); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers }); } }); }
  private questionResolved(session: OpenCodeSession, requestId: string, answers: string[][]): void { const pending = session.pendingUserInputs.get(requestId); if (!pending) return; const mapped: UserInputAnswers = {}; pending.questions.forEach((q, i) => { mapped[q.id] = answers[i]?.join(", ") ?? ""; }); session.pendingUserInputs.delete(requestId); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers: mapped }); }
}
