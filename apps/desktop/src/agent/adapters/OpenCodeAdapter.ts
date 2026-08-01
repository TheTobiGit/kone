import { randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";

import { formatPlanTasks, parseTodoWriteInput, reconcilePlanTasks } from "../planTasks.js";
import { probe } from "../spawn.js";
import { buildOpenCodeEnv, classifyOpenCodeSpawnFailure, isOpenCodeVersionSupported, MINIMUM_OPENCODE_VERSION, OPENCODE_BINARY, parseOpenCodeVersion } from "../opencodeHome.js";
import { startOpenCodeServer, type OpenCodeServer } from "../opencodeServer.js";
import type { ApprovalDecision, EmitEvent, InteractionMode, ModelDescriptor, PlanTask, ProviderAdapter, ProviderStatus, RuntimeEvent, RuntimeItem, RuntimeItemKind, RuntimeItemStatus, Session, SendTurnInput, SessionStartInput, TurnStartResult, UserInputAnswers, UserInputQuestion } from "../types.js";

type RecordLike = Record<string, any>;
type OpenCodeEvent = { type: string; properties?: RecordLike };
type OpenCodeClient = { request(method: string, route: string, body?: unknown, signal?: AbortSignal): Promise<any>; events(signal: AbortSignal): AsyncIterable<OpenCodeEvent> };
type OpenCodeSession = {
  threadId: string; cwd: string; model?: string; variant?: string; mode: InteractionMode; baseUrl: string;
  client: OpenCodeClient; server: OpenCodeServer; openCodeSessionId: string; activeTurnId?: string;
  eventsAbort: AbortController; messageRoleById: Map<string, string>; partById: Map<string, RecordLike>;
  emittedTextByPartId: Map<string, string>; completedTextPartIds: Set<string>; turnTokens: { input: number; output: number };
  pendingPermissions: Map<string, string>; pendingUserInputs: Map<string, { questions: UserInputQuestion[]; resolve: (answers: UserInputAnswers) => void }>;
  disposed: boolean; interrupting: boolean; planTasks: PlanTask[]; exitNotified: boolean;
};

const SLUG_LINE = /^(\S+\/\S+)\s*$/;

function record(value: unknown): RecordLike | undefined { return value && typeof value === "object" ? value as RecordLike : undefined; }
function responseData(value: any): any { return value?.data ?? value; }
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
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
       models.push({ id, label: name, ...(efforts.length ? { reasoningEfforts: efforts } : {}), ...(efforts.includes("medium") ? { defaultReasoningEffort: "medium" } : efforts.includes("high") ? { defaultReasoningEffort: "high" } : {}) });
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

function permissionRules(mode: InteractionMode): RecordLike[] {
  if (mode === "full-access") return [{ permission: "*", pattern: "*", action: "allow" }];
  return [{ permission: "*", pattern: "*", action: "ask" }, ...["bash", "edit", "webfetch", "websearch", "external_directory"].map((permission) => ({ permission, pattern: "*", action: "ask" })), { permission: "question", pattern: "*", action: "allow" }];
}

function modelSlug(slug: string | undefined): { providerID: string; modelID: string } | undefined {
  if (!slug) return undefined; const at = slug.indexOf("/"); if (at <= 0 || at === slug.length - 1) return undefined;
  return { providerID: slug.slice(0, at), modelID: slug.slice(at + 1) };
}

function toolKind(tool: string): RuntimeItemKind { return /^todo(write|read)$/i.test(tool) ? "plan_text" : "tool_call"; }
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

export class OpenCodeAdapter implements ProviderAdapter {
  readonly provider = "opencode" as const;
  readonly capabilities = { sessionModelSwitch: "restart-session" as const, streamsText: true, supportsToolEvents: true, supportsResume: true, supportsModelList: true };
  private readonly emit: EmitEvent; private readonly sessions = new Map<string, OpenCodeSession>(); private modelsCache: Promise<ModelDescriptor[]> | null = null;
  constructor(emit: EmitEvent) { this.emit = emit; }

  async discover(): Promise<ProviderStatus> {
    const env = await buildOpenCodeEnv(); const output = await probe(OPENCODE_BINARY, ["--version"], env, 5_000);
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
    for (let attempt = 0; attempt < 2; attempt += 1) { const output = await probe(OPENCODE_BINARY, ["models", "--verbose"], env, 30_000); if (output !== null) { const models = parseOpenCodeModels(output); if (models.length || attempt === 1) return models; } if (attempt === 0) await new Promise((resolve) => setTimeout(resolve, 1_000)); }
    throw new Error("OpenCode model inventory failed.");
  }

  async startSession(input: SessionStartInput): Promise<Session> {
    const prior = this.sessions.get(input.threadId); if (prior) await this.stopSession(input.threadId);
    const mode = input.mode ?? "accept-edits"; const env = await buildOpenCodeEnv(); const server = await startOpenCodeServer({ cwd: input.cwd, env });
    const client = makeClient(server.baseUrl); let sessionId: string | undefined;
    const resume = input.resume?.trim();
    if (resume && /^ses_/.test(resume)) {
      try {
        const found = responseData(await client.request("GET", `/session/${encodeURIComponent(resume)}`));
        sessionId = found?.id ?? resume;
        const same = found?.directory ? await this.sameDirectory(found.directory, input.cwd) : true;
        const adoptedId = sessionId;
        if (!adoptedId) throw new Error("OpenCode resume response did not include an id.");
        if (!same) sessionId = responseData(await client.request("POST", `/session/${encodeURIComponent(adoptedId)}/fork`, { directory: input.cwd }))?.id;
        else await client.request("PATCH", `/session/${encodeURIComponent(adoptedId)}`, { permission: permissionRules(mode) });
      } catch (error) { if (!isOpenCodeNotFound(error)) { await server.dispose(); throw error; } }
    }
    if (!sessionId) sessionId = responseData(await client.request("POST", "/session", { permission: permissionRules(mode) }))?.id;
    if (!sessionId) { await server.dispose(); throw new Error("OpenCode session response did not include an id."); }
    const session: OpenCodeSession = { threadId: input.threadId, cwd: input.cwd, model: input.model, variant: input.effort, mode, baseUrl: server.baseUrl, client, server, openCodeSessionId: sessionId, eventsAbort: new AbortController(), messageRoleById: new Map(), partById: new Map(), emittedTextByPartId: new Map(), completedTextPartIds: new Set(), turnTokens: { input: 0, output: 0 }, pendingPermissions: new Map(), pendingUserInputs: new Map(), disposed: false, interrupting: false, planTasks: [], exitNotified: false };
    server.child.once("exit", (code) => this.unexpectedExit(session, code));
    this.sessions.set(input.threadId, session); void this.consumeEvents(session);
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.started" });
    return this.toSession(session);
  }

  private async sameDirectory(a: string, b: string): Promise<boolean> { try { return (await fs.realpath(path.resolve(a))) === (await fs.realpath(path.resolve(b))); } catch { return path.resolve(a) === path.resolve(b); } }

  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const session = this.require(input.threadId); const text = input.input.trim();
    const { buildOpenCodeAttachmentParts, composePromptText } = await import("../promptAttachments.js");
    const files = await buildOpenCodeAttachmentParts(input.attachments); const prompt = composePromptText(text, "");
    if (!prompt && !files.length) throw new Error("Turn input must include text or an attachment.");
    const model = modelSlug(input.model ?? session.model); if (!model) throw new Error("OpenCode model selection must use the 'provider/model' format.");
    const steering = session.activeTurnId; const turnId = steering ?? `opencode-turn-${randomUUID()}`; if (!steering) { session.activeTurnId = turnId; session.turnTokens = { input: 0, output: 0 }; this.emit({ ...base(session), type: "turn.started", turnId }); }
    try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/prompt_async`, { model, ...(input.effort || session.variant ? { variant: input.effort ?? session.variant } : {}), parts: [...(prompt ? [{ type: "text", text: prompt }] : []), ...files] }); }
    catch (error) { if (!steering) { session.activeTurnId = undefined; this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "failed", message: errorMessage(error) }); } throw error; }
    return { threadId: input.threadId, turnId };
  }

  async interruptTurn(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session?.activeTurnId) return; this.drain(session); session.interrupting = true; await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); }
  async stopSession(threadId: string): Promise<void> { const session = this.sessions.get(threadId); if (!session) return; session.disposed = true; this.drain(session); session.eventsAbort.abort(); try { await session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/abort`); } catch { /* best effort */ } await session.server.dispose(); this.sessions.delete(threadId); }
  async stopAll(): Promise<void> { await Promise.all([...this.sessions.keys()].map((threadId) => this.stopSession(threadId))); }
  async respondToRequest(threadId: string, requestId: string, decision: ApprovalDecision): Promise<void> { const session = this.require(threadId); const reply = decision === "allow-once" ? "once" : decision === "allow-always" ? "always" : "reject"; await session.client.request("POST", `/permission/${encodeURIComponent(requestId)}/reply`, { reply }); }
  async respondToUserInput(threadId: string, requestId: string, answers: UserInputAnswers): Promise<void> { const session = this.require(threadId); const pending = session.pendingUserInputs.get(requestId); if (!pending) return; session.pendingUserInputs.delete(requestId); pending.resolve(answers); }
  async listSessions(): Promise<Session[]> { return [...this.sessions.values()].map((session) => this.toSession(session)); }
  async hasSession(threadId: string): Promise<boolean> { return this.sessions.has(threadId); }

  private require(threadId: string): OpenCodeSession { const session = this.sessions.get(threadId); if (!session) throw new Error(`No OpenCode session for thread ${threadId}`); return session; }
  private toSession(s: OpenCodeSession): Session { return { threadId: s.threadId, provider: "opencode", cwd: s.cwd, status: s.activeTurnId ? "running" : "ready", conversationId: s.openCodeSessionId, activeTurnId: s.activeTurnId, model: s.model, mode: s.mode }; }
  private drain(s: OpenCodeSession): void { for (const [id, pending] of s.pendingUserInputs) { s.pendingUserInputs.delete(id); pending.resolve({}); } }

  private async consumeEvents(session: OpenCodeSession): Promise<void> {
    try { for await (const event of session.client.events(session.eventsAbort.signal)) { if (!translateOpenCodeEvent(session.openCodeSessionId, event) || session.disposed) continue; this.handleEvent(session, event); } }
    catch (error) { if (!session.disposed && !session.eventsAbort.signal.aborted) this.unexpectedExit(session, null, errorMessage(error)); }
  }

  private unexpectedExit(session: OpenCodeSession, code: number | null, message?: string): void {
    if (session.disposed || session.exitNotified) return;
    session.exitNotified = true;
    const turnId = session.activeTurnId;
    session.activeTurnId = undefined;
    if (turnId) this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "turn.aborted", turnId, reason: "failed", ...(message ? { message } : {}) });
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.state.changed", state: "error", ...(message ? { message } : {}) });
    this.emit({ ...base(session, "opencode.sse.lifecycle"), type: "session.exited", code });
    this.sessions.delete(session.threadId);
    session.eventsAbort.abort();
  }

  private handleEvent(session: OpenCodeSession, event: OpenCodeEvent): void {
    const p = event.properties ?? {}; const active = session.activeTurnId;
    switch (event.type) {
      case "message.updated": { const info = record(p.info); if (info?.id && info.role) { session.messageRoleById.set(info.id, info.role); for (const part of session.partById.values()) if (part.messageID === info.id) this.handlePart(session, part); } break; }
      case "message.removed": session.messageRoleById.delete(p.messageID); break;
      case "message.part.delta": { const part = session.partById.get(p.partID); const role = part?.messageID ? session.messageRoleById.get(part.messageID) : undefined; if (!part || (role !== undefined && role !== "assistant") || !active || typeof p.delta !== "string") break; const prior = session.emittedTextByPartId.get(p.partID) ?? ""; const merged = appendOpenCodeTextDelta(prior, p.delta); session.emittedTextByPartId.set(p.partID, merged.text); this.emit({ ...base(session), type: "item.updated", turnId: active, item: { itemId: p.partID, kind: part.type === "reasoning" ? "reasoning_text" : "assistant_text", status: "in-progress", text: merged.text } }); break; }
      case "message.part.updated": this.handlePart(session, p.part); break;
      case "session.next.step.ended": session.turnTokens = accumulateOpenCodeTokens(session.turnTokens, p.tokens); break;
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

  private handlePart(session: OpenCodeSession, part: RecordLike | undefined): void {
     if (!part || !session.activeTurnId) return; session.partById.set(part.id, part); const turnId = session.activeTurnId;
     if (part.type === "text" || part.type === "reasoning") { const role = part.messageID ? session.messageRoleById.get(part.messageID) : undefined; if (role !== undefined && role !== "assistant") return; if (role === undefined) return; const hadPart = session.emittedTextByPartId.has(part.id); const merged = reconcileOpenCodeText(session.emittedTextByPartId.get(part.id), String(part.text ?? "")); session.emittedTextByPartId.set(part.id, merged.text); const kind = part.type === "reasoning" ? "reasoning_text" : "assistant_text"; if (merged.delta || !hadPart) this.emit({ ...base(session), type: hadPart ? "item.updated" : "item.started", turnId, item: { itemId: part.id, kind, status: "in-progress", text: merged.text } }); if (part.time?.end && !session.completedTextPartIds.has(part.id)) { session.completedTextPartIds.add(part.id); this.emit({ ...base(session), type: "item.completed", turnId, item: { itemId: part.id, kind, status: "completed", text: merged.text } }); } return; }
    if (part.type !== "tool") return; const state = record(part.state) ?? {}; const kind = toolKind(String(part.tool ?? "tool"));
    if (kind === "plan_text") { const parsed = parseTodoWriteInput(JSON.stringify(state.input ?? {})); if (parsed) session.planTasks = reconcilePlanTasks(session.planTasks, parsed); const item: RuntimeItem = { itemId: `${turnId}:plan`, kind, status: toolStatus(state.status), text: formatPlanTasks(session.planTasks), tasks: session.planTasks }; this.emit({ ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item }); return; }
    const item: RuntimeItem = { itemId: String(part.callID ?? part.id), kind: "tool_call", status: toolStatus(String(state.status)), text: String(state.title ?? part.tool ?? ""), name: String(part.tool ?? "tool"), ...(detailForTool(state) ? { detail: detailForTool(state) } : {}) };
    this.emit({ ...base(session), type: state.status === "pending" ? "item.started" : state.status === "completed" || state.status === "error" ? "item.completed" : "item.updated", turnId, item });
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
    const usage = session.turnTokens;
    session.turnTokens = { input: 0, output: 0 };
    this.emit({ ...base(session), type: "thread.token-usage.updated", usage: { input: usage.input, output: usage.output, total: usage.input + usage.output } });
    if (interrupting) this.emit({ ...base(session), type: "turn.aborted", turnId, reason: "interrupted" });
    else this.emit({ ...base(session), type: "turn.completed", turnId, conversationId: session.openCodeSessionId });
  }
  private async permissionAsked(session: OpenCodeSession, p: RecordLike): Promise<void> { session.pendingPermissions.set(p.id, p.permission); try { await session.client.request("POST", `/permission/${encodeURIComponent(p.id)}/reply`, { reply: "always" }); } catch { /* provider will surface session.error */ } }
  private questionAsked(session: OpenCodeSession, p: RecordLike): void { const questions = (Array.isArray(p.questions) ? p.questions : []).map((q: RecordLike, i: number) => ({ id: `question-${i}-${String(q.header ?? "question").toLowerCase().replace(/[^a-z0-9]+/g, "-")}`, header: String(q.header ?? "Question"), question: String(q.question ?? ""), options: Array.isArray(q.options) ? q.options.map((o: RecordLike) => ({ label: String(o.label ?? ""), ...(o.description ? { description: String(o.description) } : {}) })) : [], multiSelect: q.multiple === true })); const requestId = String(p.id); this.emit({ ...base(session), type: "user-input.requested", requestId, turnId: session.activeTurnId, questions }); session.pendingUserInputs.set(requestId, { questions, resolve: (answers) => { void session.client.request("POST", `/session/${encodeURIComponent(session.openCodeSessionId)}/question/${encodeURIComponent(requestId)}/reply`, { answers: questions.map((q) => { const value = answers[q.id]; return Array.isArray(value) ? value : value == null ? [] : [value]; }) }); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers }); } }); }
  private questionResolved(session: OpenCodeSession, requestId: string, answers: string[][]): void { const pending = session.pendingUserInputs.get(requestId); if (!pending) return; const mapped: UserInputAnswers = {}; pending.questions.forEach((q, i) => { mapped[q.id] = answers[i]?.join(", ") ?? ""; }); session.pendingUserInputs.delete(requestId); this.emit({ ...base(session), type: "user-input.resolved", requestId, answers: mapped }); }
}
