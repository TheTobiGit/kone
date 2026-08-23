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
  type SpawnEngineProviders,
  type SpawnEngineStore,
  type SpawnRequest,
} from "./threadSpawn.js";
import { buildPromptThreadTitleFallback } from "./threadTitle.js";
import { MAX_LIVE_CHILDREN_PER_PARENT, MAX_LIVE_SPAWNED_THREADS, MAX_SPAWN_DEPTH } from "./types.js";
import type {
  InteractionMode,
  ModelDescriptor,
  ProviderKind,
  ProviderStatus,
  RuntimeEvent,
  Session,
  SpawnThreadResult,
  StoredThreadMeta,
  ThreadLineage,
} from "./types.js";

/** The caught rejection as a plain Error.
 *  SAFETY: every caller runs expect(error).toBeInstanceOf(Error)
 *  immediately before reading name/message off it. */
function errorOf(e: unknown): Error {
  return e as Error;
}

/** The caught rejection as its domain error.
 *  SAFETY: every caller runs expect(error).toBeInstanceOf(SpawnError)
 *  immediately before reading fields off it. */
function spawnErrorOf(e: unknown): SpawnError {
  return e as SpawnError;
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
  }): boolean {
    if (this.metas.has(input.threadId)) return false;
    this.metas.set(input.threadId, {
      threadId: input.threadId,
      projectPath: input.projectPath,
      provider: input.provider,
      model: input.model,
      createdAt: input.createdAt,
      updatedAt: input.createdAt,
      title: input.title,
      lineage: input.lineage,
    });
    this.lineages.set(input.threadId, input.lineage);
    const parent = input.lineage.parentThreadId ?? "";
    const list = this.childrenByParent.get(parent) ?? [];
    list.push(input.threadId);
    this.childrenByParent.set(parent, list);
    return true;
  }

  threadLineage(threadId: string): ThreadLineage | null {
    return this.lineages.get(threadId) ?? null;
  }

  /** threadId → the agent it was bound to at spawn (delegation). */
  readonly bound = new Map<string, string>();

  bindThreadAgent(threadId: string, agentId: string) {
    this.bound.set(threadId, agentId);
    return { threadId, agentId };
  }

  spawnedChildren(parentThreadId: string): StoredThreadMeta[] {
    return (this.childrenByParent.get(parentThreadId) ?? [])
      .map((id) => this.metas.get(id))
      .filter((m): m is StoredThreadMeta => m !== undefined);
  }

  spawnDepth(threadId: string): number {
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
}

class FakeProviders implements SpawnEngineProviders {
  statuses: ProviderStatus[] = [];
  models: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};
  sessions: Session[] = [];
  /** Thread ids whose provider session the engine released (F6). */
  stopped: string[] = [];

  cachedSurface() {
    return { statuses: this.statuses, models: this.models };
  }

  async listSessions(): Promise<Session[]> {
    return this.sessions;
  }

  async stopSession(threadId: string): Promise<void> {
    this.stopped.push(threadId);
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
  /** When set, invoked with the child id right before sendThreadTurn rejects —
   *  simulates the live stream having already delivered a session + running
   *  turn before the provider refuses the turn (the partial-dispatch shape). */
  emitBeforeFailSend?: (threadId: string) => void = undefined;

  async startThread(input: SessionStartInput, options?: StartThreadOptions): Promise<Session> {
    if (this.failStart) throw new Error("provider CLI crashed on boot");
    this.started.push(input);
    this.startedParentTurns.push(options?.parentTurnId);
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
    return { threadId: input.threadId, turnId: `turn-${this.sent.length}` };
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

function makeEngine(): EngineHarness {
  const store = new FakeStore();
  const providers = new FakeProviders();
  const dispatcher = new FakeDispatcher();
  const bus = new EventBus();
  const engine = initSpawnEngine({
    store,
    providers,
    dispatcher,
    emit: (event) => bus.emit(event),
    onEvents: (listener) => bus.on(listener),
  });
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
      maxDepth: MAX_SPAWN_DEPTH,
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

