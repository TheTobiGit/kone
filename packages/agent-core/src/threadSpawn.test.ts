import { describe, expect, test } from "bun:test";

import type {
  StartThreadOptions,
  StartThreadTurnOptions,
  ThreadDispatcher,
  SendTurnInput,
  SessionStartInput,
} from "./dispatch.js";
import {
  initSpawnEngine,
  SpawnError,
  type SpawnCaller,
  type SpawnEngine,
  type SpawnEngineDeps,
  type SpawnEngineProviders,
  type SpawnEngineStore,
  type SpawnRequest,
} from "./threadSpawn.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import { IrcMailbox, type IrcMessageRecord } from "./gateway/tools/irc.js";
import { MemoryAgentInbox } from "./store/agentInbox.js";
import { startIrcDelivery } from "./ircDelivery.js";
import { createMailboxReportSink, renderSettleReport, type SettledTurnReport, type SettleReportSink } from "./settleReports.js";
import { MAX_LIVE_CHILDREN_PER_PARENT, MAX_LIVE_SPAWNED_THREADS, MAX_DELEGATION_DEPTH } from "./types.js";
import type {
  InteractionMode,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  Session,
  SpawnThreadResult,
  StoredThreadMeta,
  ContractTerms,
  ThreadLineage,
  UserInputAnswers,
} from "./types.js";

/** The caught rejection as a plain Error.
 *  SAFETY: every caller runs expect(error).toBeInstanceOf(Error)
 *  immediately before reading name/message off it. */
function errorOf(cause: unknown): Error {
  // SAFETY: every caller runs expect(error).toBeInstanceOf(Error)
  // immediately before reading name/message off it.
  return cause as Error;
}

/** The caught rejection as its domain error.
 *  SAFETY: every caller runs expect(error).toBeInstanceOf(SpawnError)
 *  immediately before reading fields off it. */
function spawnErrorOf(cause: unknown): SpawnError {
  // SAFETY: every caller runs expect(error).toBeInstanceOf(SpawnError)
  // immediately before reading fields off it.
  return cause as SpawnError;
}

// The spawn engine against in-memory fakes: no sqlite, no electron, no real
// adapters. The store fake mirrors the real ConversationStore's spawn surface
// (including reserveGatewayOp's replay/conflict semantics), the dispatcher
// fake records every call the engine makes, and the event bus is hand-driven
// so tests control exactly when a child's turns, gates and session events land.

class FakeStore implements SpawnEngineStore {
  readonly metas = new Map<string, StoredThreadMeta>();
  readonly lineages = new Map<string, ThreadLineage>();
  readonly childrenByParent = new Map<string, string[]>();
  readonly spans = new Map<
    string,
    { startedAt: number; endedAt: number | null; runningTurns: number; lastState: "running" | "interrupted" | "failed" | "completed" | null }
  >();
  readonly texts = new Map<string, string>();
  liveIds: string[] = [];
  readonly ops = new Map<string, { fingerprint: string; result?: SpawnThreadResult }>();
  /** Op keys whose dispatched bit was set after startThread returned (F8). */
  readonly markedDispatched: string[] = [];

  threadMeta(threadId: string): StoredThreadMeta | null {
    return this.metas.get(threadId) ?? null;
  }

  writeSpawnedThread(input: {
    threadId: string;
    projectPath: string;
    provider: ProviderKind;
    model?: string;
    createdAt: number;
    title: string;
    lineage: ThreadLineage;
    contract?: ContractTerms;
  }): boolean {
    if (this.metas.has(input.threadId)) return false;
    const meta: StoredThreadMeta = {
      threadId: input.threadId,
      projectPath: input.projectPath,
      provider: input.provider,
      model: input.model,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      title: input.title,
      lineage: input.lineage,
    };
    if (input.contract) meta.contract = input.contract;
    this.metas.set(input.threadId, meta);
    this.lineages.set(input.threadId, input.lineage);
    const parent = input.lineage.parentThreadId ?? "";
    const list = this.childrenByParent.get(parent) ?? [];
    list.push(input.threadId);
    this.childrenByParent.set(parent, list);
    return true;
  }

  retargetSpawnedThread(threadId: string, provider: ProviderKind, model?: string): void {
    const meta = this.metas.get(threadId);
    if (!meta) return;
    const next: StoredThreadMeta = { ...meta, provider };
    if (model !== undefined) next.model = model;
    else delete next.model;
    this.metas.set(threadId, next);
  }

  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineages.get(threadId) ?? null;
  }

  /** threadId → the agent it was bound to at spawn (delegation). */
  readonly bound = new Map<string, string>();

  bindThreadAgent(threadId: string, agentId: string) {
    this.bound.set(threadId, agentId);
    return { threadId, agentId, route: null };
  }

  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return (this.childrenByParent.get(parentThreadId) ?? [])
      .map((id) => this.metas.get(id))
      .filter((m): m is StoredThreadMeta => m !== undefined);
  }

  /** Pins every thread's depth, for tests that need a caller deep in a chain. */
  depthOverride: number | undefined = undefined;

  spawnDepth(threadId: string): number {
    if (this.depthOverride !== undefined) return this.depthOverride;
    let depth = 0;
    let current = threadId;
    const seen = new Set([threadId]);
    while (depth < 64) {
      const parent = this.lineages.get(current)?.parentThreadId;
      if (!parent) break;
      if (seen.has(parent)) return 64;
      seen.add(parent);
      current = parent;
      depth++;
    }
    return depth;
  }

  liveSpawnedThreadIds(): string[] {
    return [...this.liveIds];
  }

  latestAssistantText(threadId: string): string | null {
    return this.texts.get(threadId) ?? null;
  }

  threadTurnSpan(threadId: string): {
    startedAt: number;
    endedAt: number | null;
    runningTurns: number;
    lastState: "running" | "interrupted" | "failed" | "completed" | null;
  } | null {
    return this.spans.get(threadId) ?? null;
  }

  reserveGatewayOp(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    kind: string;
    fingerprint: string;
  }): { kind: "reserved" } | { kind: "replay"; result: unknown } | { kind: "conflict" } | null {
    const key = `${input.threadId}/${input.turnId}/${input.requestId}`;
    const prior = this.ops.get(key);
    if (!prior) {
      this.ops.set(key, { fingerprint: input.fingerprint });
      return { kind: "reserved" };
    }
    if (prior.fingerprint === input.fingerprint && prior.result !== undefined) {
      return { kind: "replay", result: prior.result };
    }
    return { kind: "conflict" };
  }

  setGatewayOpResult(input: {
    threadId: string;
    turnId: string;
    requestId: string;
    resultJson: string;
  }): void {
    const prior = this.ops.get(`${input.threadId}/${input.turnId}/${input.requestId}`);
    if (prior) {
      // SAFETY: the engine only ever stores JSON.stringify of a SpawnThreadResult here.
      prior.result = JSON.parse(input.resultJson) as SpawnThreadResult;
    }
  }

  markGatewayOpDispatched(input: {
    threadId: string;
    turnId: string;
    requestId: string;
  }): void {
    this.markedDispatched.push(`${input.threadId}/${input.turnId}/${input.requestId}`);
  }

  /** The agent a delegated thread runs as, read back for a follow-up that
   *  restarts its session. */
  getThreadAgent(threadId: string): { agentId: string } | null {
    const agentId = this.bound.get(threadId);
    return agentId ? { agentId } : null;
  }

  readonly agents = new Map<string, { name: string; instructions: string | null }>();

  getAgent(agentId: string): { name: string; instructions: string | null } | null {
    return this.agents.get(agentId) ?? null;
  }
}

class FakeProviders implements SpawnEngineProviders {
  statuses: ProviderStatus[] = [];
  models: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};
  sessions: Session[] = [];
  /** Thread ids whose provider session the engine released (F6). */
  stopped: string[] = [];
  /** Thread ids with a live session, for untracked children the engine has no
   *  memory of (a follow-up consults this before waking one). */
  readonly liveSessions = new Set<string>();

  cachedSurface() {
    return { statuses: this.statuses, models: this.models };
  }

  hasLiveSession(threadId: string): boolean {
    return this.liveSessions.has(threadId);
  }

  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }

  async stopSession(threadId: string): Promise<void> {
    this.stopped.push(threadId);
    this.liveSessions.delete(threadId);
  }

  /** Gates the engine declined, in order — decline-only, never an approval. */
  readonly gateDecisions: Array<{ threadId: string; requestId: string; decision: string }> = [];
  /** Gates the engine answered, in order. */
  readonly gateAnswers: Array<{ threadId: string; requestId: string; answers: UserInputAnswers }> = [];

  async respondToRequest(
    threadId: string,
    requestId: string,
    decision: "reject-once" | "reject-and-stop",
  ): Promise<void> {
    this.gateDecisions.push({ threadId, requestId, decision });
  }

  async respondToUserInput(
    threadId: string,
    requestId: string,
    answers: UserInputAnswers,
  ): Promise<{ owned: boolean; followUp?: string }> {
    this.gateAnswers.push({ threadId, requestId, answers });
    return { owned: true };
  }
}

class FakeDispatcher implements ThreadDispatcher {
  started: SessionStartInput[] = [];
  /** The parentTurnId passed with each startThread, when the spawn stamped it
   *  (F10). */
  startedParentTurns: (string | undefined)[] = [];
  sent: Array<{ input: SendTurnInput; options?: StartThreadTurnOptions }> = [];
  failStart = false;
  failSend = false;
  /** Errors thrown from startThread, in order, until the list is empty. */
  startErrors: Error[] = [];
  /** When set, invoked with the child id right before sendThreadTurn rejects —
   *  simulates the live stream having already delivered a session + running
   *  turn before the provider refuses the turn (the partial-dispatch shape). */
  emitBeforeFailSend?: (threadId: string) => void = undefined;
  /** When set, invoked with the child id and the turn id right before
   *  sendThreadTurn resolves — the turn's events coming through before the
   *  caller hears the provider took it. */
  emitBeforeSent?: (threadId: string, turnId: string) => void = undefined;

  async startThread(input: SessionStartInput, options?: StartThreadOptions): Promise<Session> {
    this.started.push(input);
    this.startedParentTurns.push(options?.parentTurnId);
    const queued = this.startErrors.shift();
    if (queued) throw queued;
    if (this.failStart) throw new Error("provider CLI crashed on boot");
    const session: Session = {
      threadId: input.threadId,
      provider: input.provider,
      cwd: input.cwd,
      status: "ready",
      mode: input.mode ?? "ask",
    };
    if (input.model) session.model = input.model;
    return session;
  }

  async sendThreadTurn(
    input: SendTurnInput,
    options?: StartThreadTurnOptions,
  ): Promise<{ threadId: string; turnId: string }> {
    if (this.failSend) {
      this.emitBeforeFailSend?.(input.threadId);
      throw new Error("provider refused the turn");
    }
    this.sent.push({ input, options });
    const turnId = `turn-${this.sent.length}`;
    this.emitBeforeSent?.(input.threadId, turnId);
    return { threadId: input.threadId, turnId };
  }

  /** The parent turn each follow-up sent as a job stamped on its child. */
  parentTurnsNoted: Array<{ threadId: string; parentTurnId: string }> = [];

  noteSpawnParentTurn(threadId: string, parentTurnId: string): void {
    this.parentTurnsNoted.push({ threadId, parentTurnId });
  }

  spawnParentTurnId(): string | undefined {
    return undefined;
  }

  onTurnCompleted(): void {}

  forgetThread(): void {}
}

class EventBus {
  readonly emitted: RuntimeEvent[] = [];
  private readonly listeners = new Set<(event: RuntimeEvent) => void>();

  on(listener: (event: RuntimeEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: RuntimeEvent): void {
    this.emitted.push(event);
    for (const listener of this.listeners) listener(event);
  }

  ofType(type: RuntimeEvent["type"]): RuntimeEvent[] {
    return this.emitted.filter((e) => e.type === type);
  }
}

const CALLER: SpawnCaller = {
  threadId: "parent-1",
  turnId: "turn-1",
  provider: "opencode",
  model: "deepseek-v4",
  cwd: "/tmp/proj",
};

const REQUEST: SpawnRequest = {
  requestId: "req-1",
  prompt: "Fix the sidebar",
  target: { provider: "opencode", model: "deepseek-v4", effort: "high" },
};

type EngineHarness = {
  engine: SpawnEngine;
  store: FakeStore;
  providers: FakeProviders;
  dispatcher: FakeDispatcher;
  bus: EventBus;
};

function makeEngine(
  options: { reports?: (store: FakeStore) => SettleReportSink; jobs?: IrcMailbox } = {},
): EngineHarness {
  const store = new FakeStore();
  const providers = new FakeProviders();
  const dispatcher = new FakeDispatcher();
  const bus = new EventBus();
  const deps: SpawnEngineDeps = {
    store,
    providers,
    dispatcher,
    emit: (event) => bus.emit(event),
    onEvents: (listener) => bus.on(listener),
    reports: options.reports?.(store),
  };
  if (options.jobs) deps.jobs = options.jobs;
  const engine = initSpawnEngine(deps);
  return { engine, store, providers, dispatcher, bus };
}

/** The parent thread + a live session at full-access, plus a healthy target
 *  provider with the model the request names in its catalog. */
function setupParent(
  store: FakeStore,
  providers: FakeProviders,
  mode: InteractionMode = "full-access",
): void {
  store.metas.set(CALLER.threadId, {
    threadId: CALLER.threadId,
    projectPath: CALLER.cwd,
    provider: CALLER.provider,
    createdAt: 1,
    updatedAt: 1,
    title: "Parent",
  });
  providers.sessions = [
    {
      threadId: CALLER.threadId,
      provider: CALLER.provider,
      cwd: CALLER.cwd,
      status: "running",
      mode,
      model: CALLER.model,
    },
  ];
  providers.statuses = [
    {
      provider: "opencode",
      label: "OpenCode",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
    },
  ];
  providers.models.opencode = [
    { id: "deepseek-v4", label: "DeepSeek V4", reasoningEfforts: ["low", "medium", "high"] },
  ];
}

// ── event seeds ──────────────────────────────────────────────────────────────
// The same normalized RuntimeEvents the real adapters emit, applied through the
// bus so the engine's listener folds them into the child's projection.

function sessionStarted(threadId: string, at: number): RuntimeEvent {
  return { type: "session.started", threadId, provider: "opencode", at, source: "kone.store" };
}

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "opencode", at, source: "kone.store", turnId };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return {
    type: "turn.completed",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    turnId,
  };
}

function approvalRequested(threadId: string, at: number): RuntimeEvent {
  return {
    type: "approval.requested",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    requestId: "ap-1",
    approval: { kind: "command", title: "rm -rf dist" },
  };
}

function tokenUsage(threadId: string, total: number, at: number): RuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    usage: { total },
  };
}

describe("spawn engine", () => {
  test("happy path: writes the row, dispatches with the pinned options, emits thread.spawned", async () => {
    const { engine, store, providers, dispatcher, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);

    // The child row exists with the parent's lineage stamped on it.
    expect(result.threadId).toBeTruthy();
    expect(result.threadId).not.toBe(CALLER.threadId);
    expect(store.metas.has(result.threadId)).toBe(true);
    expect(store.lineages.get(result.threadId)).toEqual({
      parentThreadId: CALLER.threadId,
      relationshipToParent: "subagent",
      rootThreadId: CALLER.threadId,
    });

    // startSession, then the first turn — with the exact options the spawn
    // path promises: the parent's title kept, no background rename.
    expect(dispatcher.started).toEqual([
      {
        threadId: result.threadId,
        provider: "opencode",
        cwd: CALLER.cwd,
        model: "deepseek-v4",
        effort: "high",
        mode: "full-access",
      },
    ]);
    expect(dispatcher.sent).toHaveLength(1);
    expect(dispatcher.sent[0].input).toEqual({
      threadId: result.threadId,
      input: REQUEST.prompt,
      // An unbound parent is named by its rolled call sign.
      sender: { kind: "agent", threadId: CALLER.threadId, relationship: "parent", messageKind: "brief", name: "Basalt" },
    });
    expect(dispatcher.sent[0].options).toEqual({
      title: buildPromptThreadTitleFallback(REQUEST.prompt),
      generateTitle: false,
      parentTurnId: CALLER.turnId,
    });

    // The ledger's dispatched bit is set after startThread returned (F8), and
    // the spawning turn's id rode to the dispatcher so the child's events
    // correlate to it (F10).
    expect(store.markedDispatched).toEqual([
      `${CALLER.threadId}/${CALLER.turnId}/${REQUEST.requestId}`,
    ]);
    expect(dispatcher.startedParentTurns).toEqual([CALLER.turnId]);

    // One thread.spawned carrying the child's first projection.
    const spawned = bus.ofType("thread.spawned");
    expect(spawned).toHaveLength(1);
    expect(spawned[0]).toMatchObject({
      threadId: result.threadId,
      provider: "opencode",
      source: "kone.store",
    });
    // SAFETY: ofType collected only thread.spawned events; [0] is this spawn's announce.
    const projection = (spawned[0] as Extract<RuntimeEvent, { type: "thread.spawned" }>).spawned;
    expect(projection.threadId).toBe(result.threadId);
    expect(projection.parentThreadId).toBe(CALLER.threadId);

    // The result shape — no adjustments on a clean request, and the child's
    // first turn id rides back so the parent can pin its wait (F7).
    expect(result).toEqual({
      requestId: REQUEST.requestId,
      threadId: result.threadId,
      parentThreadId: CALLER.threadId,
      title: buildPromptThreadTitleFallback(REQUEST.prompt),
      provider: "opencode",
      model: "deepseek-v4",
      effort: "high",
      mode: "full-access",
      firstTurnId: "turn-1",
      status: "dispatched",
    });
    expect(result.adjustments).toBeUndefined();
  });

  test("a 429 on the primary walks the fallback chain and reports failedOverFrom", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    providers.statuses.push({
      provider: "claudeAgent",
      label: "Claude",
      available: true,
      authStatus: "authenticated",
      readiness: "ready",
    });
    providers.models.claudeAgent = [{ id: "opus", label: "Opus" }];
    dispatcher.startErrors = [new Error("429 rate limit: quota exhausted")];

    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      fallbacks: [{ provider: "claudeAgent", model: "opus" }],
    });

    expect(dispatcher.started).toHaveLength(2);
    expect(dispatcher.started[0]?.provider).toBe("opencode");
    expect(dispatcher.started[0]?.model).toBe("deepseek-v4");
    expect(dispatcher.started[1]?.provider).toBe("claudeAgent");
    expect(dispatcher.started[1]?.model).toBe("opus");
    expect(result.provider).toBe("claudeAgent");
    expect(result.model).toBe("opus");
    expect(result.failedOverFrom).toEqual({
      provider: "opencode",
      model: "deepseek-v4",
      reason: "429 rate limit: quota exhausted",
    });
    expect(store.metas.get(result.threadId)?.provider).toBe("claudeAgent");
    expect(store.metas.get(result.threadId)?.model).toBe("opus");
  });

  test("a crash on start does not walk the fallback chain", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    dispatcher.failStart = true;

    let error: unknown;
    try {
      await engine.spawn(CALLER, {
        ...REQUEST,
        fallbacks: [{ provider: "claudeAgent", model: "opus" }],
      });
    } catch (cause) {
      error = cause;
    }
    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("provider_unavailable");
    expect(dispatcher.started).toHaveLength(1);
  });

  test("a delegation stamps delegation lineage, binds the agent, and carries its persona into the session", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    const persona = { name: "Backend", instructions: "You own the API layer." };
    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      delegateToAgentId: "agent-backend",
      persona,
    });

    // A delegation is a spawned child, but its lineage records that the work
    // went to a named agent rather than an anonymous worker.
    expect(store.lineages.get(result.threadId)?.relationshipToParent).toBe("delegation");

    // The child is bound to its agent BEFORE the first turn — so every event
    // the thread emits names who ran it from the first action.
    expect(store.bound.get(result.threadId)).toBe("agent-backend");

    // And it runs AS that agent: the persona rode to the session.
    expect(dispatcher.started).toHaveLength(1);
    expect(dispatcher.started[0].agent).toEqual(persona);
  });

  test("a plain spawn is an anonymous guest — no binding, no persona", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);

    expect(store.lineages.get(result.threadId)?.relationshipToParent).toBe("subagent");
    expect(store.bound.has(result.threadId)).toBe(false);
    expect(dispatcher.started[0].agent).toBeUndefined();
  });

  test("a worker cannot start anything — the engine refuses even when the tool layer is bypassed", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    const meta = store.metas.get(CALLER.threadId)!;
    store.metas.set(CALLER.threadId, {
      ...meta,
      lineage: { parentThreadId: "root", relationshipToParent: "subagent", rootThreadId: "root" },
    });

    await expect(engine.spawn(CALLER, REQUEST)).rejects.toMatchObject({ code: "capability_denied" });
    await expect(
      engine.spawn(CALLER, { ...REQUEST, requestId: "r-2", delegateToAgentId: "agent-backend" }),
    ).rejects.toMatchObject({ code: "capability_denied" });
    expect(dispatcher.started).toHaveLength(0);
  });

  test("a contract opens an agent: a delegation edge carrying its terms, briefed as the contracting agent", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    const contract = {
      name: "Frontend Auth",
      role: "Frontend auth specialist",
      instructions: "Keep components small.",
      scope: "Login and signup screens.",
      deliverable: "Working screens.",
      doneCriteria: "Tests pass.",
    };
    const persona = { name: "Frontend Auth", instructions: "Your role: Frontend auth specialist." };

    const result = await engine.spawn(CALLER, { ...REQUEST, contract, persona });

    expect(store.lineages.get(result.threadId)?.relationshipToParent).toBe("delegation");
    expect(store.metas.get(result.threadId)?.contract).toEqual(contract);
    // No roster row stands behind a contractor: nothing is bound.
    expect(store.bound.has(result.threadId)).toBe(false);
    expect(dispatcher.started[0]?.agent).toEqual(persona);
    expect(dispatcher.sent[0]?.input.sender).toMatchObject({ relationship: "contracting", messageKind: "brief" });
  });

  test("a contractor counts against the delegation depth, a worker does not", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);
    store.depthOverride = MAX_DELEGATION_DEPTH;
    const contract = {
      name: "Deep",
      role: "r",
      instructions: "i",
      scope: "s",
      deliverable: "d",
      doneCriteria: "c",
    };
    await expect(engine.spawn(CALLER, { ...REQUEST, contract })).rejects.toMatchObject({
      code: "capability_denied",
    });
    await expect(engine.spawn(CALLER, { ...REQUEST, requestId: "r-worker" })).resolves.toMatchObject({
      status: "dispatched",
    });
  });

  test("a worker's brief is sent as its parent's words, not the user's", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    await engine.spawn(CALLER, REQUEST);

    expect(dispatcher.sent[0]?.input.sender).toMatchObject({
      kind: "agent",
      threadId: CALLER.threadId,
      relationship: "parent",
      messageKind: "brief",
    });
  });

  test("a delegate's brief is sent as its delegator's words", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    await engine.spawn(CALLER, { ...REQUEST, delegateToAgentId: "agent-backend" });

    expect(dispatcher.sent[0]?.input.sender).toMatchObject({
      kind: "agent",
      threadId: CALLER.threadId,
      relationship: "delegator",
      messageKind: "brief",
    });
  });

  test("a delegate's binding is announced before the child itself", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, { ...REQUEST, delegateToAgentId: "agent-backend" });

    // The renderer names the child from this, so it must land before the first
    // event that puts the child on screen.
    const order = bus.emitted.map((event) => event.type);
    expect(order.indexOf("thread.agent-bound")).toBeLessThan(order.indexOf("thread.spawned"));
    expect(bus.ofType("thread.agent-bound")[0]).toMatchObject({
      threadId: result.threadId,
      binding: { threadId: result.threadId, agentId: "agent-backend", route: null },
    });
  });

  test("a worker has no binding to announce", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    await engine.spawn(CALLER, REQUEST);

    expect(bus.ofType("thread.agent-bound")).toHaveLength(0);
  });

  test("an explicit title wins over the prompt fallback", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      title: "Polish the nav",
      requestId: "req-title",
    });

    expect(result.title).toBe("Polish the nav");
    expect(dispatcher.sent[0].options).toEqual({
      title: "Polish the nav",
      generateTitle: false,
      parentTurnId: CALLER.turnId,
    });
  });

  test("replay returns status 'replayed' and does not dispatch again", async () => {
    const { engine, store, providers, dispatcher, bus } = makeEngine();
    setupParent(store, providers);

    const first = await engine.spawn(CALLER, REQUEST);
    const replay = await engine.spawn(CALLER, REQUEST);

    expect(replay.status).toBe("replayed");
    expect(replay.threadId).toBe(first.threadId);
    expect(replay).toMatchObject({
      requestId: REQUEST.requestId,
      parentThreadId: CALLER.threadId,
      model: "deepseek-v4",
      mode: "full-access",
    });
    // Nothing new was written, started or announced.
    expect(dispatcher.started).toHaveLength(1);
    expect(dispatcher.sent).toHaveLength(1);
    expect(bus.ofType("thread.spawned")).toHaveLength(1);
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(1);
  });

  test("same requestId with different content is an idempotency_conflict", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    await engine.spawn(CALLER, REQUEST);
    const error = await engine.spawn(CALLER, { ...REQUEST, prompt: "Do something else" }).catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("idempotency_conflict");
  });

  test("a guard refusal surfaces as a SpawnError with the guard's own code", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    const error = await engine
      .spawn(CALLER, { ...REQUEST, prompt: "   ", requestId: "req-blank" })
      .catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("invalid_input");
    expect(spawnErrorOf(error).message).toContain("prompt");
    // Refused before any child was written.
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(0);
  });

  test("a dispatcher rejection leaves the row, emits a failed projection, and throws provider_unavailable", async () => {
    const { engine, store, providers, dispatcher, bus } = makeEngine();
    setupParent(store, providers);
    dispatcher.failStart = true;

    const error = await engine.spawn(CALLER, REQUEST).catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("provider_unavailable");
    // The thread row stays — a failed child is visible, not silently erased.
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(1);
    const failed = bus.ofType("thread.spawn-updated").at(-1);
    // SAFETY: ofType collected only thread.spawn-updated events.
    const projection = (failed as Extract<RuntimeEvent, { type: "thread.spawn-updated" }>).spawned;
    expect(projection.status).toBe("failed");
    expect(projection.terminal).toBe(true);
  });

  test("a sendThreadTurn rejection after the session started settles running turns so the child reads failed", async () => {
    const { engine, store, providers, dispatcher, bus } = makeEngine();
    setupParent(store, providers);
    // The live stream delivers the session + a running turn before the provider
    // refuses the turn — the partial-dispatch shape where hasLiveSession is
    // already true and a running turn outranks any failed turn pushed after.
    dispatcher.emitBeforeFailSend = (threadId) => {
      bus.emit(sessionStarted(threadId, 10));
      bus.emit(turnStarted(threadId, "t-1", 20));
    };
    dispatcher.failSend = true;

    const error = await engine.spawn(CALLER, REQUEST).catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("provider_unavailable");
    // The row stays — a failed child is visible, not silently erased.
    const children = store.spawnedChildren(CALLER.threadId);
    expect(children).toHaveLength(1);
    const childId = children[0]!.threadId;
    // The child projects failed + terminal, and the settled turn's own error
    // rides up as the detail rather than being shadowed by a synthetic turn.
    const updates = bus.ofType("thread.spawn-updated");
    // SAFETY: updates holds only thread.spawn-updated events.
    const last = updates.at(-1) as Extract<RuntimeEvent, { type: "thread.spawn-updated" }>;
    expect(last.spawned.status).toBe("failed");
    expect(last.spawned.terminal).toBe(true);
    expect(last.spawned.detail).toContain("refused");
    // The newly-started provider session must be torn down, not leaked in the background.
    expect(providers.stopped).toContain(childId);
  });

  test("a sendThreadTurn rejection without prior events stops the session and leaves a synthetic failed turn", async () => {
    const { engine, store, providers, dispatcher, bus } = makeEngine();
    setupParent(store, providers);
    dispatcher.failSend = true;

    const error = await engine.spawn(CALLER, REQUEST).catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("provider_unavailable");
    const children = store.spawnedChildren(CALLER.threadId);
    expect(children).toHaveLength(1);
    const childId = children[0]!.threadId;
    const updates = bus.ofType("thread.spawn-updated");
    // SAFETY: updates holds only thread.spawn-updated events.
    const last = updates.at(-1) as Extract<RuntimeEvent, { type: "thread.spawn-updated" }>;
    expect(last.spawned.status).toBe("failed");
    expect(last.spawned.terminal).toBe(true);
    expect(providers.stopped).toContain(childId);
  });

  test("the in-memory live union stops a burst at the parent breadth cap", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    // Twelve accepted children. The store fake reports NO running block rows
    // (liveIds stays empty), so only the engine's in-memory live union can be
    // what stops the 13th.
    const children: string[] = [];
    for (let i = 0; i < MAX_LIVE_CHILDREN_PER_PARENT; i++) {
      const result = await engine.spawn(CALLER, { ...REQUEST, requestId: `req-${i}` });
      children.push(result.threadId);
    }

    const error = await engine
      .spawn(CALLER, { ...REQUEST, requestId: "req-13" })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("capability_denied");
    expect(spawnErrorOf(error).message).toContain(
      `${MAX_LIVE_CHILDREN_PER_PARENT} children running`,
    );
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(MAX_LIVE_CHILDREN_PER_PARENT);

    // A child that settles frees its slot — the set counts non-terminal only.
    const first = children[0];
    bus.emit(sessionStarted(first, 10));
    bus.emit(turnStarted(first, "t-1", 20));
    bus.emit(turnCompleted(first, "t-1", 30));
    const after = await engine.spawn(CALLER, { ...REQUEST, requestId: "req-14" });
    expect(after.status).toBe("dispatched");
  });

  test("thread.spawn-updated fires on a real change and not on a no-op event", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    bus.emit(sessionStarted(result.threadId, 10));
    bus.emit(turnStarted(result.threadId, "t-1", 20));
    bus.emit(turnCompleted(result.threadId, "t-1", 30));
    const before = bus.ofType("thread.spawn-updated").length;

    // tokens undefined → 100 is a change; 100 → 100 is not.
    bus.emit(tokenUsage(result.threadId, 100, 40));
    expect(bus.ofType("thread.spawn-updated")).toHaveLength(before + 1);
    bus.emit(tokenUsage(result.threadId, 100, 40));
    expect(bus.ofType("thread.spawn-updated")).toHaveLength(before + 1);
  });

  test("waitFor short-circuits when a child parks on an approval", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    const waiting = engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 300,
      scopeThreadId: CALLER.threadId,
    });
    bus.emit(approvalRequested(result.threadId, 50));

    const out = await waiting;
    expect(out.timedOut).toBe(false);
    expect(out.allTerminal).toBe(false);
    expect(out.threads).toHaveLength(1);
    expect(out.threads[0].threadId).toBe(result.threadId);
    expect(out.threads[0].status).toBe("waiting-for-approval");
  });

  test("a parent parked in agent_wait reads as waiting on its child until the wait returns", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    expect(engine.waitingOn(CALLER.threadId)).toBeNull();
    const waiting = engine.waitFor({ threadIds: [result.threadId], timeoutMs: 300, scopeThreadId: CALLER.threadId });
    expect(engine.waitingOn(CALLER.threadId)?.threadIds).toEqual([result.threadId]);

    bus.emit(approvalRequested(result.threadId, 50));
    await waiting;
    expect(engine.waitingOn(CALLER.threadId)).toBeNull();
  });

  test("waitFor resolves when every named child is terminal", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    const waiting = engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 300,
      scopeThreadId: CALLER.threadId,
    });
    bus.emit(sessionStarted(result.threadId, 10));
    bus.emit(turnStarted(result.threadId, "t-1", 20));
    bus.emit(turnCompleted(result.threadId, "t-1", 30));

    const out = await waiting;
    expect(out.timedOut).toBe(false);
    expect(out.allTerminal).toBe(true);
  });

  test("waitFor rejects an id outside the caller's subtree", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    // A child of a DIFFERENT root, written straight into the store.
    store.writeSpawnedThread({
      threadId: "foreign-1",
      projectPath: "/other",
      provider: "opencode",
      createdAt: 5,
      title: "Foreign child",
      lineage: {
        parentThreadId: "other-parent",
        relationshipToParent: "subagent",
        rootThreadId: "other-root",
      },
    });

    const error = await engine
      .waitFor({ threadIds: ["foreign-1"], timeoutMs: 10, scopeThreadId: CALLER.threadId })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("not_found");
    expect(spawnErrorOf(error).message).toContain("foreign-1");
  });

  test("isInSubtree walks parent pointers — a mid-tree parent sees its own child", () => {
    const { engine, store } = makeEngine();
    // A → B → C: a legal depth-2 tree. Every row carries rootThreadId "A", but
    // B must still be able to wait on and read the child IT spawned.
    const spawnRow = (id: string, parent: string) =>
      store.writeSpawnedThread({
        threadId: id,
        projectPath: CALLER.cwd,
        provider: "opencode",
        createdAt: 1,
        title: id,
        lineage: { parentThreadId: parent, relationshipToParent: "subagent", rootThreadId: "A" },
      });
    spawnRow("B", "A");
    spawnRow("C", "B");
    spawnRow("D", "A"); // A's other child — B's sibling
    // A side chat of A carries lineage too, but is not a spawned descendant.
    store.lineages.set("side-1", {
      parentThreadId: null,
      relationshipToParent: "side_chat",
      rootThreadId: "A",
    });
    // A two-row pointer loop must return false, never hang the main process.
    store.lineages.set("cycle-x", {
      parentThreadId: "cycle-y",
      relationshipToParent: "subagent",
      rootThreadId: "A",
    });
    store.lineages.set("cycle-y", {
      parentThreadId: "cycle-x",
      relationshipToParent: "subagent",
      rootThreadId: "A",
    });

    expect(engine.isInSubtree("A", "A")).toBe(true);
    expect(engine.isInSubtree("A", "C")).toBe(true);
    expect(engine.isInSubtree("B", "C")).toBe(true); // the depth-2 case
    expect(engine.isInSubtree("A", "D")).toBe(true);
    expect(engine.isInSubtree("B", "D")).toBe(false); // a sibling stays out
    expect(engine.isInSubtree("A", "side-1")).toBe(false);
    expect(engine.isInSubtree("A", "cycle-x")).toBe(false);
    expect(engine.isInSubtree("A", "cycle-y")).toBe(false);
  });

  test("a child that settles releases its provider session exactly once (F6)", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    expect(providers.stopped).toHaveLength(0);

    // Live turn still running — nothing to release yet.
    bus.emit(sessionStarted(result.threadId, 10));
    bus.emit(turnStarted(result.threadId, "t-1", 20));
    expect(providers.stopped).toHaveLength(0);

    // The turn settles → terminal → the child's provider session is released.
    bus.emit(turnCompleted(result.threadId, "t-1", 30));
    expect(providers.stopped).toEqual([result.threadId]);

    // A later no-op recompute must not stop it again.
    bus.emit(tokenUsage(result.threadId, 100, 40));
    bus.emit(turnCompleted(result.threadId, "t-1", 40));
    expect(providers.stopped).toEqual([result.threadId]);

    // The store row and projection stay — only the process goes.
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(1);
    expect(engine.snapshot(result.threadId)?.status).toBe("completed");
  });

  test("a child parked on an approval keeps its session (no release while gated)", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    bus.emit(sessionStarted(result.threadId, 10));
    bus.emit(turnStarted(result.threadId, "t-1", 20));
    bus.emit(approvalRequested(result.threadId, 50));

    // Parked, not terminal — the session must stay so it can resume.
    expect(engine.snapshot(result.threadId)?.status).toBe("waiting-for-approval");
    expect(providers.stopped).toHaveLength(0);
  });

  test("waitFor pins to a turnId so a newer turn can't swap the outcome (F7)", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    // The result hands the parent the child's first turn id for free.
    expect(result.firstTurnId).toBe("turn-1");

    // Pinned wait: turn-1 settles, then a second turn starts — the pinned wait
    // resolves on turn-1's outcome either way, echoing the resolved turnIds.
    const pinned = engine.waitFor({
      threadIds: [result.threadId],
      turnIds: [result.firstTurnId],
      timeoutMs: 300,
      scopeThreadId: CALLER.threadId,
    });
    bus.emit(sessionStarted(result.threadId, 10));
    bus.emit(turnStarted(result.threadId, "turn-1", 20));
    bus.emit(turnCompleted(result.threadId, "turn-1", 30));
    bus.emit(turnStarted(result.threadId, "turn-2", 40));
    const pinnedOut = await pinned;
    expect(pinnedOut.timedOut).toBe(false);
    expect(pinnedOut.allTerminal).toBe(true);
    expect(pinnedOut.threads[0].status).toBe("completed");
    expect(pinnedOut.turnIds).toEqual(["turn-1"]);
    // Unpinned wait: the child's LATEST turn is running, so the wait does not
    // resolve on the settled earlier turn — it times out still running.
    const unpinned = engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 20,
      scopeThreadId: CALLER.threadId,
    });
    const unpinnedOut = await unpinned;
    expect(unpinnedOut.timedOut).toBe(true);
    expect(unpinnedOut.allTerminal).toBe(false);
    expect(unpinnedOut.threads[0].status).toBe("working");
    expect(unpinnedOut.turnIds).toEqual(["turn-2"]);
  });

  test("waitFor rejects turnIds whose length doesn't pair with threadIds", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    const error = await engine
      .waitFor({
        threadIds: [result.threadId],
        turnIds: [],
        timeoutMs: 10,
        scopeThreadId: CALLER.threadId,
      })
      .catch((e) => e);
    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("invalid_input");
  });

  test("waitFor honours the requested order", async () => {
    const { engine, store, providers, bus } = makeEngine();
    setupParent(store, providers);

    const a = await engine.spawn(CALLER, { ...REQUEST, requestId: "req-a" });
    const b = await engine.spawn(CALLER, { ...REQUEST, requestId: "req-b" });
    for (const childId of [a.threadId, b.threadId]) {
      bus.emit(sessionStarted(childId, 10));
      bus.emit(turnStarted(childId, "t-1", 20));
      bus.emit(turnCompleted(childId, "t-1", 30));
    }

    const out = await engine.waitFor({
      threadIds: [b.threadId, a.threadId],
      timeoutMs: 100,
      scopeThreadId: CALLER.threadId,
    });
    expect(out.threads.map((t) => t.threadId)).toEqual([b.threadId, a.threadId]);
    expect(out.timedOut).toBe(false);
  });

  test("waitFor times out with current snapshots and never cancels anything", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    // A freshly spawned child that never gets an event: it stays non-terminal,
    // so the wait must end on the timer.
    const result = await engine.spawn(CALLER, REQUEST);
    const out = await engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 20,
      scopeThreadId: CALLER.threadId,
    });
    expect(out.timedOut).toBe(true);
    expect(out.allTerminal).toBe(false);
    expect(out.threads[0].threadId).toBe(result.threadId);
  });

  test("waitFor with an already-aborted signal rejects immediately with AbortError", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, REQUEST);
    const controller = new AbortController();
    controller.abort();
    // Count every settlement: the 20ms timeout must never get a chance to fire
    // a second one — a leaked waiter would settle this promise again.
    let settlements = 0;
    const waiting = engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 20,
      scopeThreadId: CALLER.threadId,
      signal: controller.signal,
    });
    waiting.then(
      () => {
        settlements++;
      },
      () => {
        settlements++;
      },
    );
    const started = Date.now();
    const error = await waiting.catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(errorOf(error).name).toBe("AbortError");
    expect(errorOf(error).message).toBe("The wait was cancelled.");
    // Rejected on entry, well before the 20ms timeout could have fired.
    expect(Date.now() - started).toBeLessThan(20);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(settlements).toBe(1);
  });

  test("waitFor aborts a parked wait on signal and leaves no ghost waiter", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    // A freshly spawned child with no events: non-terminal, so the wait parks
    // until the signal aborts it well before the 500ms timeout.
    const result = await engine.spawn(CALLER, REQUEST);
    const controller = new AbortController();
    const waiting = engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 500,
      scopeThreadId: CALLER.threadId,
      signal: controller.signal,
    });
    controller.abort();
    const error = await waiting.catch((e) => e);
    expect(error).toBeInstanceOf(Error);
    expect(errorOf(error).name).toBe("AbortError");

    // The aborted waiter was removed from the list, not left to collide with
    // a later wait on the same child: the fresh wait times out on its own
    // 20ms timer and reports the child still non-terminal.
    const out = await engine.waitFor({
      threadIds: [result.threadId],
      timeoutMs: 20,
      scopeThreadId: CALLER.threadId,
    });
    expect(out.timedOut).toBe(true);
    expect(out.allTerminal).toBe(false);
  });

  test("snapshot() recovers a child from the store with honest inputs", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    // A child the engine never spawned (previous run) — a running block row
    // with no live session must read as interrupted, not working.
    store.writeSpawnedThread({
      threadId: "recovered-1",
      projectPath: CALLER.cwd,
      provider: "opencode",
      createdAt: 5,
      title: "Recovered child",
      lineage: {
        parentThreadId: CALLER.threadId,
        relationshipToParent: "subagent",
        rootThreadId: CALLER.threadId,
      },
    });
    store.spans.set("recovered-1", {
      startedAt: 10,
      endedAt: null,
      runningTurns: 1,
      lastState: "running",
    });

    const snap = engine.snapshot("recovered-1");
    expect(snap).not.toBeNull();
    expect(snap!.status).toBe("interrupted");
    expect(snap!.terminal).toBe(true);
    expect(engine.children(CALLER.threadId).map((c) => c.threadId)).toEqual(["recovered-1"]);

    // A non-spawned thread has no spawned-child projection.
    expect(engine.snapshot(CALLER.threadId)).toBeNull();
  });

  test("snapshot() reads a settled child's own lastState, not assumed success", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);
    // A child from a previous run whose turn was left mid-flight and sealed
    // 'interrupted' by the boot sweep — the honest read is interrupted, never
    // a silent completed success with a truncated stream.
    const child = (id: string, lastState: "interrupted" | "failed" | "completed") => {
      store.writeSpawnedThread({
        threadId: id,
        projectPath: CALLER.cwd,
        provider: "opencode",
        createdAt: 5,
        title: id,
        lineage: {
          parentThreadId: CALLER.threadId,
          relationshipToParent: "subagent",
          rootThreadId: CALLER.threadId,
        },
      });
      store.spans.set(id, {
        startedAt: 10,
        endedAt: 50,
        runningTurns: 0,
        lastState,
      });
    };
    child("recovered-interrupted", "interrupted");
    child("recovered-failed", "failed");
    child("recovered-completed", "completed");

    expect(engine.snapshot("recovered-interrupted")!.status).toBe("interrupted");
    expect(engine.snapshot("recovered-interrupted")!.terminal).toBe(true);
    expect(engine.snapshot("recovered-failed")!.status).toBe("failed");
    expect(engine.snapshot("recovered-completed")!.status).toBe("completed");
    expect(engine.snapshot("recovered-completed")!.terminal).toBe(true);
  });

  test("targets() reports the cached surface and the caller's resolved mode", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);

    const report = await engine.targets(CALLER);
    expect(report.providers).toHaveLength(1);
    expect(report.providers[0]).toEqual({
      provider: "opencode",
      label: "OpenCode",
      available: true,
      models: [{ id: "deepseek-v4", label: "DeepSeek V4", efforts: ["low", "medium", "high"] }],
    });
    expect(report.caller).toEqual({
      provider: "opencode",
      model: "deepseek-v4",
      mode: "full-access",
    });
    expect(report.limits).toEqual({
      depth: 0,
      maxDepth: MAX_DELEGATION_DEPTH,
      remainingChildren: MAX_LIVE_CHILDREN_PER_PARENT,
      remainingAppWide: MAX_LIVE_SPAWNED_THREADS,
    });
  });

  test("an explicit escalation against a no-session parent (ask) is refused, not clamped", async () => {
    const { engine, store, providers } = makeEngine();
    setupParent(store, providers);
    providers.sessions = [];

    const error = await engine
      .spawn(CALLER, { ...REQUEST, requestId: "req-ask", mode: "full-access" })
      .catch((e) => e);

    expect(error).toBeInstanceOf(SpawnError);
    expect(spawnErrorOf(error).code).toBe("permission_denied");
    // Refused before any child was written.
    expect(store.spawnedChildren(CALLER.threadId)).toHaveLength(0);
  });

  test("a parent with no live session — an unset mode inherits the most restrictive rung", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    providers.sessions = [];

    const result = await engine.spawn(CALLER, { ...REQUEST, requestId: "req-ask" });

    expect(result.mode).toBe("ask");
    expect(dispatcher.started[0].mode).toBe("ask");
  });

  test("an unset target effort inherits the parent session's recorded effort", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    providers.sessions = [{ ...providers.sessions[0]!, effort: "high" }];

    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      requestId: "req-inherit-effort",
      target: { provider: "opencode", model: "deepseek-v4" },
    });

    expect(result.effort).toBe("high");
    expect(dispatcher.started[0].effort).toBe("high");
  });

  test("an explicit target effort beats the inherited parent's", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);
    providers.sessions = [{ ...providers.sessions[0]!, effort: "high" }];

    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      requestId: "req-explicit-effort",
      target: { provider: "opencode", model: "deepseek-v4", effort: "low" },
    });

    expect(result.effort).toBe("low");
    expect(dispatcher.started[0].effort).toBe("low");
  });

  test("a parent session with no recorded effort spawns a child with none", async () => {
    const { engine, store, providers, dispatcher } = makeEngine();
    setupParent(store, providers);

    const result = await engine.spawn(CALLER, {
      ...REQUEST,
      requestId: "req-no-effort",
      target: { provider: "opencode", model: "deepseek-v4" },
    });

    expect(result.effort).toBeUndefined();
    expect(dispatcher.started[0].effort).toBeUndefined();
  });
});

describe("continueThread", () => {
  /** Spawn one child through the engine and run its first turn to completion,
   *  so the harness holds a child whose projection has settled and whose
   *  provider session the engine has released. The session.exited event models
   *  the real release flow: the engine stops the session without awaiting it,
   *  and the flag clears when the adapter reports the exit. */
  async function settledChild(h: EngineHarness): Promise<string> {
    const spawned = await h.engine.spawn(CALLER, REQUEST);
    const child = spawned.threadId;
    const firstTurn = spawned.firstTurnId ?? "turn-1";
    h.bus.emit(sessionStarted(child, 1));
    h.bus.emit(turnStarted(child, firstTurn, 2));
    h.bus.emit(turnCompleted(child, firstTurn, 3));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.bus.emit({ type: "session.exited", threadId: child, provider: "opencode", at: 4, source: "kone.store" });
    return child;
  }

  /** Spawn one child whose session is live and idle — started, no turn yet. */
  async function liveChild(h: EngineHarness): Promise<string> {
    const spawned = await h.engine.spawn(CALLER, REQUEST);
    h.bus.emit(sessionStarted(spawned.threadId, 1));
    return spawned.threadId;
  }

  test("a follow-up dispatches into the same thread, pinned to the spawning turn", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    const child = await liveChild(h);

    const result = await h.engine.continueThread(CALLER, {
      threadId: child,
      message: "Also update the README to match.",
    });

    expect(result).toEqual({
      threadId: child,
      parentThreadId: CALLER.threadId,
      turnId: "turn-2",
      resumed: false,
    });
    // No second startThread — the child's session is still live.
    expect(h.dispatcher.started).toHaveLength(1);
    expect(h.dispatcher.sent).toHaveLength(2);
    // It is the caller asking, never the user.
    expect(h.dispatcher.sent[1]?.input).toEqual({
      threadId: child,
      input: "Also update the README to match.",
      sender: { kind: "agent", threadId: CALLER.threadId, relationship: "parent", messageKind: "followup", name: "Basalt" },
    });
    // The follow-up is the caller's turn speaking into the child: no rename,
    // and the child's events correlate back to the caller's turn (F10).
    expect(h.dispatcher.sent[1]?.options).toEqual({
      generateTitle: false,
      parentTurnId: CALLER.turnId,
    });
  });

  test("a follow-up from past the parent is labelled as from up the chain", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    const child = await liveChild(h);
    const grandchild = "grandchild-1";
    h.store.metas.set(grandchild, {
      threadId: grandchild,
      projectPath: CALLER.cwd,
      provider: "opencode",
      createdAt: 1,
      updatedAt: 1,
      title: "Grandchild",
    });
    h.store.lineages.set(grandchild, {
      parentThreadId: child,
      relationshipToParent: "delegation",
      rootThreadId: CALLER.threadId,
    });
    h.providers.liveSessions.add(grandchild);

    await h.engine.continueThread(CALLER, { threadId: grandchild, message: "Check the edge case too." });

    expect(h.dispatcher.sent.at(-1)?.input.sender).toEqual({
      kind: "agent",
      threadId: CALLER.threadId,
      relationship: "upstream",
      messageKind: "followup",
      name: "Basalt",
    });
  });

  test("a follow-up to a settled child brings its session back up first", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    const child = await settledChild(h);
    // Settling released the child's provider process (F6).
    expect(h.providers.stopped).toContain(child);
    const startsBefore = h.dispatcher.started.length;

    const result = await h.engine.continueThread(CALLER, {
      threadId: child,
      message: "One more thing: the sidebar flickers on resize.",
    });

    expect(result.resumed).toBe(true);
    expect(h.dispatcher.started).toHaveLength(startsBefore + 1);
    // SAFETY: started only ever collects SessionStartInput objects.
    const restart = h.dispatcher.started[h.dispatcher.started.length - 1]!;
    expect(restart.threadId).toBe(child);
    expect(restart.provider).toBe("opencode");
    expect(restart.cwd).toBe(CALLER.cwd);
    expect(restart.model).toBe("deepseek-v4");
    // The restart is the caller's doing, same as the original spawn.
    expect(h.dispatcher.startedParentTurns[startsBefore]).toBe(CALLER.turnId);
    // And the turn itself landed on the same thread.
    expect(h.dispatcher.sent[h.dispatcher.sent.length - 1]?.input.threadId).toBe(child);
  });

  test("a restarted delegation wakes as its agent again", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    h.store.agents.set("agent-backend", {
      name: "Backend",
      instructions: "You own the API layer.",
    });
    const delegated: SpawnRequest = {
      ...REQUEST,
      requestId: "req-del-1",
      delegateToAgentId: "agent-backend",
      persona: { name: "Backend", instructions: "You own the API layer." },
    };
    const spawned = await h.engine.spawn(CALLER, delegated);
    const child = spawned.threadId;
    const firstTurn = spawned.firstTurnId ?? "turn-1";
    h.bus.emit(sessionStarted(child, 1));
    h.bus.emit(turnStarted(child, firstTurn, 2));
    h.bus.emit(turnCompleted(child, firstTurn, 3));
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    h.bus.emit({
      type: "session.exited",
      threadId: child,
      provider: "opencode",
      at: 4,
      source: "kone.store",
    });

    await h.engine.continueThread(CALLER, { threadId: child, message: "Ship it behind a flag." });

    expect(h.dispatcher.started).toHaveLength(2);
    // SAFETY: started only ever collects SessionStartInput objects.
    const restart = h.dispatcher.started[1]!;
    expect(restart.agent).toEqual({ name: "Backend", instructions: "You own the API layer." });
  });

  test("refuses the caller's own thread and a thread outside its subtree", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);

    const own = await h.engine
      .continueThread(CALLER, { threadId: CALLER.threadId, message: "hello" })
      .catch((e) => e);
    expect(own).toBeInstanceOf(SpawnError);
    // SAFETY: asserted to be a SpawnError immediately above.
    expect((own as SpawnError).code).toBe("invalid_input");

    const stranger = await h.engine
      .continueThread(CALLER, { threadId: "stranger-1", message: "hello" })
      .catch((e) => e);
    expect(stranger).toBeInstanceOf(SpawnError);
    // SAFETY: asserted to be a SpawnError immediately above.
    expect((stranger as SpawnError).code).toBe("not_found");
  });

  test("a stable requestId replays the same follow-up; a changed one conflicts", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    const child = await liveChild(h);

    const first = await h.engine.continueThread(CALLER, {
      threadId: child,
      message: "Also update the README.",
      requestId: "fu-1",
    });
    const retry = await h.engine.continueThread(CALLER, {
      threadId: child,
      message: "Also update the README.",
      requestId: "fu-1",
    });

    expect(retry).toEqual(first);
    expect(h.dispatcher.sent).toHaveLength(2);

    const conflict = await h.engine
      .continueThread(CALLER, { threadId: child, message: "Different ask.", requestId: "fu-1" })
      .catch((e) => e);
    expect(conflict).toBeInstanceOf(SpawnError);
    // SAFETY: asserted to be a SpawnError immediately above.
    expect((conflict as SpawnError).code).toBe("idempotency_conflict");
    // The conflicting call dispatched nothing.
    expect(h.dispatcher.sent).toHaveLength(2);
  });

  test("a follow-up puts the settled child back into the live counts", async () => {
    const h = makeEngine();
    setupParent(h.store, h.providers);
    const child = await settledChild(h);
    const settledLimits = (await h.engine.targets(CALLER)).limits;

    await h.engine.continueThread(CALLER, {
      threadId: child,
      message: "Also update the README.",
    });

    const resumedLimits = (await h.engine.targets(CALLER)).limits;
    expect(resumedLimits.remainingAppWide).toBe(settledLimits.remainingAppWide - 1);
    expect(resumedLimits.remainingChildren).toBe(settledLimits.remainingChildren - 1);
  });
});

describe("continueThread under the ringer", () => {
  async function busyChild(h: EngineHarness): Promise<string> {
    const spawned = await h.engine.spawn(CALLER, REQUEST);
    h.bus.emit(sessionStarted(spawned.threadId, 1));
    h.bus.emit(turnStarted(spawned.threadId, "turn-a", 2));
    return spawned.threadId;
  }

  test("a follow-up is a job in the child's inbox, and its id comes back", async () => {
    const mailbox = new IrcMailbox();
    const h = makeEngine({ jobs: mailbox });
    setupParent(h.store, h.providers);
    const child = await busyChild(h);
    const sentBefore = h.dispatcher.sent.length;

    const result = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests." });

    expect(result.job).toBe(true);
    expect(result.turnId.startsWith("msg_")).toBe(true);
    // Nothing is sent at the child: the ringer hands the job over.
    expect(h.dispatcher.sent).toHaveLength(sentBefore);
    expect(mailbox.jobCount(child)).toBe(1);
    expect(mailbox.jobTurn(result.turnId)).toEqual({ recipient: child, handedOver: false, turnId: null });
    expect(h.dispatcher.parentTurnsNoted).toEqual([{ threadId: child, parentTurnId: CALLER.turnId }]);
  });

  test("a retry under the same request id finds the same job", async () => {
    const mailbox = new IrcMailbox();
    const h = makeEngine({ jobs: mailbox });
    setupParent(h.store, h.providers);
    const child = await busyChild(h);

    const first = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests.", requestId: "fu-1" });
    const retry = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests.", requestId: "fu-1" });

    expect(retry).toEqual(first);
    expect(mailbox.jobCount(child)).toBe(1);
  });

  test("agent_wait on the job's id waits past the running turn, then settles with the turn that carried it", async () => {
    const mailbox = new IrcMailbox();
    const h = makeEngine({ jobs: mailbox });
    setupParent(h.store, h.providers);
    const child = await busyChild(h);
    const { turnId: jobId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests." });

    let settled = false;
    const waiting = h.engine
      .waitFor({ threadIds: [child], turnIds: [jobId], timeoutMs: 2_000, scopeThreadId: CALLER.threadId })
      .then((out) => {
        settled = true;
        return out;
      });

    // The turn that was running ends: the job has not run yet.
    h.bus.emit(turnCompleted(child, "turn-a", 3));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(settled).toBe(false);

    // The ringer hands the job over as its own turn, which settles before
    // the provider's accept is even recorded.
    const claim = mailbox.claimJob(child)!;
    h.bus.emit(turnStarted(child, "turn-b", 4));
    h.bus.emit(turnCompleted(child, "turn-b", 5));
    expect(settled).toBe(false);
    mailbox.settleDelivery(claim.deliveryId, "turn-b");

    const out = await waiting;
    expect(out.timedOut).toBe(false);
    expect(out.allTerminal).toBe(true);
    expect(out.turnIds).toEqual(["turn-b"]);
  });

  test("agent_wait on a job kone was handing over when it restarted settles uncertain, never handed over", async () => {
    const inbox = new MemoryAgentInbox();
    const mailbox = new IrcMailbox(inbox);
    const h = makeEngine({ jobs: mailbox });
    setupParent(h.store, h.providers);
    const child = await busyChild(h);
    const { turnId: jobId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests." });
    const claim = mailbox.claimJob(child)!;
    mailbox.sendingDelivery(claim.deliveryId);
    inbox.recoverAsAfterRestart();

    const out = await h.engine.waitFor({ threadIds: [child], turnIds: [jobId], timeoutMs: 2_000, scopeThreadId: CALLER.threadId });

    expect(out.timedOut).toBe(false);
    expect(out.allTerminal).toBe(true);
    expect(out.threads[0]).toMatchObject({ status: "uncertain", terminal: true, handedOver: false });
    expect(out.threads[0]!.detail).toContain("agent_followup again with a new requestId");
  });

  test("an uncertain job the child has read in its inbox still settles a wait uncertain", async () => {
    const inbox = new MemoryAgentInbox();
    const mailbox = new IrcMailbox(inbox);
    const h = makeEngine({ jobs: mailbox });
    setupParent(h.store, h.providers);
    const child = await busyChild(h);
    const { turnId: jobId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Now add tests." });
    mailbox.sendingDelivery(mailbox.claimJob(child)!.deliveryId);
    inbox.recoverAsAfterRestart();
    expect(mailbox.getInbox(child).messages.map((m) => m.id)).toContain(jobId);

    const out = await h.engine.waitFor({ threadIds: [child], turnIds: [jobId], timeoutMs: 2_000, scopeThreadId: CALLER.threadId });

    expect(out.timedOut).toBe(false);
    expect(out.threads[0]).toMatchObject({ status: "uncertain", terminal: true, handedOver: false });
  });
});

// ── settle reports ───────────────────────────────────────────────────────────
// A child's settled turn reaches its parent even when the parent is not
// waiting: through the real mailbox and the real delivery, into a dispatcher
// that records what the parent was sent.

function turnAborted(threadId: string, turnId: string, at: number, reason: "interrupted" | "failed", message?: string): RuntimeEvent {
  const event: RuntimeEvent = { type: "turn.aborted", threadId, provider: "opencode", at, source: "kone.store", turnId, reason };
  if (message !== undefined) event.message = message;
  return event;
}

type ReportHarness = EngineHarness & {
  mailbox: IrcMailbox;
  /** Turns the mailbox delivered to a parent, in order. */
  delivered: Array<{ threadId: string; input: string; steered: boolean }>;
  /** Messages put on a parent's transcript, with who they are signed by. */
  journaled: Array<{ threadId: string; text: string; sender: IrcMessageRecord["sender"] }>;
  busy: Set<string>;
  /** Run every armed delivery, after letting the engine's deferred report land. */
  flush: () => Promise<void>;
  stopDelivery: () => void;
};

function makeReportEngine(): ReportHarness {
  const mailbox = new IrcMailbox();
  const h = makeEngine({ reports: (store) => createMailboxReportSink({ mailbox, store }) });
  const delivered: ReportHarness["delivered"] = [];
  const journaled: ReportHarness["journaled"] = [];
  const busy = new Set<string>();
  const armed: Array<() => void> = [];
  const stopDelivery = startIrcDelivery({
    mailbox,
    dispatcher: {
      sendThreadTurn: async (input) => {
        delivered.push({ threadId: input.threadId, input: input.input, steered: false });
        return { threadId: input.threadId, turnId: `wake-${delivered.length}` };
      },
      steerThreadTurn: async (input) => {
        delivered.push({ threadId: input.threadId, input: input.input, steered: true });
        return { threadId: input.threadId, turnId: `steer-${delivered.length}` };
      },
    },
    isLive: () => true,
    isBusy: (threadId) => busy.has(threadId),
    journal: (threadId, message) => journaled.push({ threadId, text: message.message, sender: message.sender }),
    schedule: (fn) => {
      armed.push(fn);
      return () => {
        const i = armed.indexOf(fn);
        if (i !== -1) armed.splice(i, 1);
      };
    },
  });
  const flush = async (): Promise<void> => {
    await new Promise((resolve) => setTimeout(resolve, 0));
    while (armed.length > 0) armed.shift()!();
    await new Promise((resolve) => setTimeout(resolve, 0));
  };
  return { ...h, mailbox, delivered, journaled, busy, flush, stopDelivery };
}

const DELEGATION: SpawnRequest = {
  requestId: "req-delegate",
  prompt: "Build the endpoint",
  target: { provider: "opencode", model: "deepseek-v4", effort: "high" },
  delegateToAgentId: "agent-jonas",
  persona: { name: "Jonas" },
};

async function delegate(h: ReportHarness, request: SpawnRequest = DELEGATION): Promise<string> {
  setupParent(h.store, h.providers);
  h.store.agents.set("agent-jonas", { name: "Jonas", instructions: null });
  const { threadId } = await h.engine.spawn(CALLER, request);
  h.bus.emit(sessionStarted(threadId, 10));
  h.bus.emit(turnStarted(threadId, "t-1", 20));
  return threadId;
}

describe("settle reports", () => {
  test("a report that rings names the work still out: delegates by name, workers counted", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    const ada = await delegate(h, { ...DELEGATION, requestId: "req-ada", persona: { name: "Ada" }, title: "login UI" });
    const { threadId: worker } = await h.engine.spawn(CALLER, { ...REQUEST, requestId: "req-worker" });
    h.bus.emit(sessionStarted(worker, 11));
    h.bus.emit(turnStarted(worker, "w-1", 21));
    // A hand-off that already settled is not out.
    const { threadId: done } = await h.engine.spawn(CALLER, { ...REQUEST, requestId: "req-done" });
    h.bus.emit(sessionStarted(done, 12));
    h.bus.emit(turnStarted(done, "d-1", 22));
    h.bus.emit(turnCompleted(done, "d-1", 23));
    await h.flush();
    h.delivered.length = 0;

    h.bus.emit(turnCompleted(child, "t-1", 30));
    await h.flush();

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain("Still out: Ada (login UI), 1 worker.");
    expect(h.delivered[0]!.input).not.toContain(ada);
    h.stopDelivery();
  });

  test("a held report leaves the still-out line off: it would be stale when read", () => {
    const report: SettledTurnReport = {
      childThreadId: "c",
      parentThreadId: "p",
      turnId: "t-1",
      handOff: "delegation",
      status: "interrupted",
      stillOut: { agents: [{ name: "Ada", title: "login UI" }], workers: 2 },
    };
    expect(renderSettleReport(report, "Jonas")).toContain("Still out: Ada (login UI), 2 workers.");
    expect(renderSettleReport(report, "Jonas", false)).not.toContain("Still out");
  });

  test("a report with nothing else out adds no still-out line", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.bus.emit(turnCompleted(child, "t-1", 30));
    await h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).not.toContain("Still out");
    h.stopDelivery();
  });

  test("a delegate that settles while its delegator is idle reports once, as a turn carrying its reply", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.store.texts.set(child, "Endpoint shipped: POST /v1/things, tests green.");

    h.bus.emit(turnCompleted(child, "t-1", 30));
    await h.flush();

    expect(h.delivered).toHaveLength(1);
    const [turn] = h.delivered;
    expect(turn!.threadId).toBe(CALLER.threadId);
    // Woken, not steered: the delegator had no turn running.
    expect(turn!.steered).toBe(false);
    expect(turn!.input).toContain("> Endpoint shipped: POST /v1/things, tests green.");
    expect(turn!.input).toContain(`<kone_notice from="kone" kind="report" about="Jonas"`);
    expect(turn!.input).toContain(`thread ${child}, turn t-1`);

    // A repeated settle of the same turn is not a second report.
    h.bus.emit(turnCompleted(child, "t-1", 40));
    await h.flush();
    expect(h.delivered).toHaveLength(1);

    // And agent_wait still returns the result normally afterwards.
    const out = await h.engine.waitFor({ threadIds: [child], scopeThreadId: CALLER.threadId, timeoutMs: 20 });
    expect(out.allTerminal).toBe(true);
    expect(out.threads[0]!.summary).toBe("Endpoint shipped: POST /v1/things, tests green.");
    h.stopDelivery();
  });

  test("the report is kone's courier speaking, with the child's name and thread in it", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.store.texts.set(child, "Endpoint shipped.");
    h.bus.emit(turnCompleted(child, "t-1", 30));
    await h.flush();

    // Journaled in the courier's name, never the child's.
    expect(h.journaled).toHaveLength(1);
    expect(h.journaled[0]!.sender).toEqual({
      kind: "courier",
      messageKind: "report",
      about: { threadId: child, name: "Jonas", agentId: "agent-jonas", relationship: "delegate" },
    });
    expect(h.journaled[0]!.text).toContain(`Jonas finished the work you handed it (thread ${child}, turn t-1)`);
    expect(h.journaled[0]!.text).toContain(`agent_followup on that thread`);

    // Prompted as kone's notice, not as a message from another agent.
    const input = h.delivered[0]!.input;
    expect(input).toContain(`<kone_notice from="kone" kind="report" about="Jonas" relationship="delegate" thread="${child}">`);
    expect(input).toContain("Jonas did not send it");
    expect(input).not.toContain("<agent_messages>");
    expect(input).not.toContain("From `Jonas`");
    h.stopDelivery();
  });

  test("a delegator busy with other work has the report steered into its running turn", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.busy.add(CALLER.threadId);
    h.bus.emit(turnCompleted(child, "t-1", 30));
    await h.flush();
    expect(h.delivered.map((d) => d.steered)).toEqual([true]);
    h.stopDelivery();
  });

  test("a delegator parked in agent_wait collects the result itself — nothing is pushed", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.store.texts.set(child, "Done.");
    const waiting = h.engine.waitFor({ threadIds: [child], scopeThreadId: CALLER.threadId, timeoutMs: 500 });

    h.bus.emit(turnCompleted(child, "t-1", 30));
    const out = await waiting;
    await h.flush();

    expect(out.threads[0]!.summary).toBe("Done.");
    expect(h.delivered).toHaveLength(0);
    expect(h.mailbox.getUnreadCount(CALLER.threadId)).toBe(0);
    h.stopDelivery();
  });

  test("a wait still parked on another child holds the settled one's report, then collects it", async () => {
    const h = makeReportEngine();
    const first = await delegate(h);
    const { threadId: second } = await h.engine.spawn(CALLER, { ...REQUEST, requestId: "req-worker" });
    h.bus.emit(sessionStarted(second, 11));
    h.bus.emit(turnStarted(second, "w-1", 21));
    const waiting = h.engine.waitFor({ threadIds: [first, second], scopeThreadId: CALLER.threadId, timeoutMs: 500 });

    h.bus.emit(turnCompleted(first, "t-1", 30));
    await h.flush();
    expect(h.delivered).toHaveLength(0);

    h.bus.emit(turnCompleted(second, "w-1", 40));
    await waiting;
    await h.flush();
    expect(h.delivered).toHaveLength(0);
    h.stopDelivery();
  });

  test("a wait abandoned before it returns lets the held report go out", async () => {
    const h = makeReportEngine();
    const first = await delegate(h);
    const { threadId: second } = await h.engine.spawn(CALLER, { ...REQUEST, requestId: "req-worker" });
    h.bus.emit(sessionStarted(second, 11));
    h.bus.emit(turnStarted(second, "w-1", 21));
    const controller = new AbortController();
    const waiting = h.engine
      .waitFor({ threadIds: [first, second], scopeThreadId: CALLER.threadId, timeoutMs: 500, signal: controller.signal })
      .catch(() => null);

    h.bus.emit(turnCompleted(first, "t-1", 30));
    await h.flush();
    expect(h.delivered).toHaveLength(0);

    controller.abort();
    await waiting;
    await h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain(`thread ${first}, turn t-1`);
    h.stopDelivery();
  });

  test("an agent_wait that lands after the settle but before delivery takes the report back", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.bus.emit(turnCompleted(child, "t-1", 30));
    // Let the deferred report reach the mailbox, but run no delivery yet.
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.mailbox.getUnreadCount(CALLER.threadId)).toBe(1);

    const out = await h.engine.waitFor({ threadIds: [child], scopeThreadId: CALLER.threadId, timeoutMs: 20 });
    expect(out.allTerminal).toBe(true);
    await h.flush();
    expect(h.delivered).toHaveLength(0);
    h.stopDelivery();
  });

  test("a parked question or approval is not a settle", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.bus.emit(approvalRequested(child, 30));
    await h.flush();
    expect(h.delivered).toHaveLength(0);
    h.stopDelivery();
  });

  test("a failed turn reports its error", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    h.bus.emit(turnAborted(child, "t-1", 30, "failed", "rate limited"));
    await h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain("Jonas's turn failed");
    expect(h.delivered[0]!.input).toContain("rate limited");
    h.stopDelivery();
  });

  test("a worker reports to the agent that started it, the same way", async () => {
    const h = makeReportEngine();
    setupParent(h.store, h.providers);
    const { threadId } = await h.engine.spawn(CALLER, REQUEST);
    h.bus.emit(sessionStarted(threadId, 10));
    h.bus.emit(turnStarted(threadId, "w-1", 20));
    h.store.texts.set(threadId, "Found it in sidebar.ts:42.");
    h.bus.emit(turnCompleted(threadId, "w-1", 30));
    await h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain('relationship="child"');
    expect(h.delivered[0]!.input).toContain("is your worker");
    expect(h.delivered[0]!.input).toContain("Found it in sidebar.ts:42.");
    h.stopDelivery();
  });

  test("a child its parent stopped does not report the interruption, until the parent asks it again", async () => {
    const h = makeReportEngine();
    const child = await delegate(h);
    await h.engine.cancelChild(CALLER, child);
    h.bus.emit(turnAborted(child, "t-1", 30, "interrupted"));
    await h.flush();
    expect(h.delivered).toHaveLength(0);

    const { turnId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Pick it back up." });
    h.bus.emit(turnStarted(child, turnId, 40));
    h.bus.emit(turnCompleted(child, turnId, 50));
    await h.flush();
    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain(`turn ${turnId}`);
    h.stopDelivery();
  });

  test("an interruption nobody asked for reaches a busy parent, and is held for an idle one's next turn", async () => {
    const mailbox = new IrcMailbox();
    const rang: string[] = [];
    mailbox.onMessageDelivered((recipient) => rang.push(recipient));
    const busy = new Set<string>();
    const h = makeEngine({
      reports: (store) =>
        createMailboxReportSink({
          mailbox,
          store,
          isBusy: (threadId) => busy.has(threadId),
        }),
    });
    setupParent(h.store, h.providers);
    const { threadId } = await h.engine.spawn(CALLER, REQUEST);
    h.bus.emit(sessionStarted(threadId, 10));
    h.bus.emit(turnStarted(threadId, "w-1", 20));
    h.bus.emit(turnAborted(threadId, "w-1", 30, "interrupted"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    // Idle: no wake — a stop is not news worth a turn of its own.
    expect(rang).toEqual([]);
    expect(mailbox.ringingCount(CALLER.threadId)).toBe(0);
    const held = mailbox.claimHeld(CALLER.threadId, 8)!;
    expect(held.messages).toHaveLength(1);
    expect(held.messages[0]!.kind).toBe("report");
    expect(held.messages[0]!.message).toContain("interrupted");
    const sender = held.messages[0]!.sender;
    expect(sender?.kind === "courier" ? sender.about?.threadId : null).toBe(threadId);

    busy.add(CALLER.threadId);
    h.bus.emit(sessionStarted(threadId, 35));
    h.bus.emit(turnStarted(threadId, "w-2", 40));
    h.bus.emit(turnAborted(threadId, "w-2", 50, "interrupted"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(rang).toEqual([CALLER.threadId]);
    expect(mailbox.ringingCount(CALLER.threadId)).toBe(1);
  });
});

// ── children from before a restart ───────────────────────────────────────────
// The engine follows the children it spawned in memory. After a restart a
// child is only in the store; a follow-up takes it back on, so its turns are
// read live and reported to the parent again.

/** A delegate written by an earlier run, its last turn sealed interrupted
 *  by the boot sweep. */
function childFromBeforeRestart(h: EngineHarness, threadId = "old-1"): string {
  setupParent(h.store, h.providers);
  h.store.writeSpawnedThread({
    threadId,
    projectPath: CALLER.cwd,
    provider: "opencode",
    createdAt: 5,
    title: "Review",
    lineage: { parentThreadId: CALLER.threadId, relationshipToParent: "delegation", rootThreadId: CALLER.threadId },
  });
  h.store.spans.set(threadId, { startedAt: 10, endedAt: 20, runningTurns: 0, lastState: "interrupted" });
  return threadId;
}

describe("a child from before a restart", () => {
  test("a follow-up takes it back on: its next settled turn is reported to the parent", async () => {
    const h = makeReportEngine();
    const child = childFromBeforeRestart(h);

    const { turnId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });
    h.bus.emit(turnStarted(child, turnId, 40));
    h.bus.emit(turnCompleted(child, turnId, 50));
    await h.flush();

    expect(h.delivered).toHaveLength(1);
    expect(h.delivered[0]!.input).toContain(`turn ${turnId}`);
    h.stopDelivery();
  });

  test("a wait right after the follow-up reads the turn it started, not the interrupted one before", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    const { turnId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    // The provider took the turn; its turn.started has not come through yet.
    const latest = await h.engine.waitFor({ threadIds: [child], timeoutMs: 30, scopeThreadId: CALLER.threadId });
    expect(latest.timedOut).toBe(true);
    expect(latest.threads[0]!.terminal).toBe(false);
    const pinned = h.engine.waitFor({ threadIds: [child], turnIds: [turnId], timeoutMs: 2_000, scopeThreadId: CALLER.threadId });

    h.bus.emit(turnStarted(child, turnId, 40));
    expect(h.engine.snapshot(child)!.status).toBe("working");
    h.bus.emit(turnCompleted(child, turnId, 50));

    const out = await pinned;
    expect(out.timedOut).toBe(false);
    expect(out.threads[0]).toMatchObject({ status: "completed", terminal: true });
    expect(out.turnIds).toEqual([turnId]);
  });

  test("a wait pinned to a turn from before the restart reads it from the store", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    const out = await h.engine.waitFor({
      threadIds: [child],
      turnIds: ["turn-from-before"],
      timeoutMs: 2_000,
      scopeThreadId: CALLER.threadId,
    });
    expect(out.timedOut).toBe(false);
    expect(out.threads[0]).toMatchObject({ status: "interrupted", terminal: true });
  });

  test("a follow-up that could not be sent leaves it as the store has it", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    h.dispatcher.failSend = true;

    await expect(h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." })).rejects.toThrow();
    expect(h.engine.snapshot(child)).toMatchObject({ status: "interrupted", terminal: true });
  });
});

// ── the turn a follow-up started, before its events ─────────────────────────
// Once the provider takes a follow-up, the child reads as running that turn
// until an event for it comes through — never as the turn before. The mark
// answers only to its own turn, and gives way to a session that ended.

function sessionState(threadId: string, state: "error" | "stopped", at: number): RuntimeEvent {
  return { type: "session.state.changed", threadId, provider: "opencode", at, source: "kone.store", state };
}

describe("the turn a follow-up started", () => {
  test("a job taken before its turn.started: a wait on it is not the interrupted turn from before the restart", async () => {
    const mailbox = new IrcMailbox();
    const h = makeEngine({ jobs: mailbox });
    const child = childFromBeforeRestart(h);
    const { turnId: jobId } = await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    // The ringer hands the job over; the provider takes it as turn "new",
    // whose turn.started has not come through.
    mailbox.settleDelivery(mailbox.claimJob(child)!.deliveryId, "new");

    const out = await h.engine.waitFor({ threadIds: [child], turnIds: [jobId], timeoutMs: 30, scopeThreadId: CALLER.threadId });
    expect(out.timedOut).toBe(true);
    expect(out.threads[0]).toMatchObject({ status: "working", terminal: false });
    expect(out.turnIds).toEqual(["new"]);
  });

  test("a turn that started and finished before the send returned stays finished", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    h.dispatcher.emitBeforeSent = (threadId, turnId) => {
      h.bus.emit(turnStarted(threadId, turnId, 40));
      h.bus.emit(turnCompleted(threadId, turnId, 50));
    };

    await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    expect(h.engine.snapshot(child)).toMatchObject({ status: "completed", terminal: true });
  });

  test("a session that failed before the send returned leaves no turn under way", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    h.dispatcher.emitBeforeSent = (threadId) => h.bus.emit(sessionState(threadId, "error", Date.now()));

    await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    expect(h.engine.snapshot(child)!.status).not.toBe("working");
  });

  test("a session that fails after the provider took the turn ends it", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });
    expect(h.engine.snapshot(child)!.status).toBe("working");

    h.bus.emit(sessionState(child, "error", Date.now()));

    expect(h.engine.snapshot(child)!.status).not.toBe("working");
  });

  test("an event for another turn does not end it", async () => {
    const h = makeEngine();
    const child = childFromBeforeRestart(h);
    await h.engine.continueThread(CALLER, { threadId: child, message: "Re-review, please." });

    // The turn from before the restart, its end landing late.
    h.bus.emit(turnAborted(child, "turn-from-before", 30, "interrupted"));

    expect(h.engine.snapshot(child)).toMatchObject({ status: "working", terminal: false });
  });
});
