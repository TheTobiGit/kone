import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type { QueuedTurnEnqueueInput } from "./conversationStoreTypes.js";
import type {
  ModelDescriptor,
  ProviderAdapter,
  ProviderKind,
  QueuedTurnRow,
  QueuedTurnStore,
  SendTurnInput,
  StoredThreadMeta,
  ThreadCompactionCapability,
  TurnStartResult,
  UserInputRespondResult,
} from "./types.js";

// AgentService is exercised with fake adapters INJECTED through its options
// (adapters + store) — no module is mocked, so this file can never shadow a
// sibling test's imports (bun keeps ONE mock.module registry per worker, and
// agentService.test.ts used to pollute it with subset module mocks that made
// e.g. droidAdapter.test.ts crash with "Export named 'toolCallStatus' not
// found" whenever they shared a worker). The fakes capture the emit closure
// so tests can drive the merged event stream exactly like a provider would —
// no CLI is ever spawned. The userDataDir injection (temp dir) keeps the real
// provider settings/cache reads hermetic: a fresh temp dir has no files, so
// the real modules return empty snapshots and construction is side-effect
// free.

let userDataDir = mkdtempSync(path.join(tmpdir(), "kone-agentservice-test-"));

setUserDataDir(userDataDir);

// The real ConversationStore (reachable through the adapters' promptAttachments
// chain) imports node:sqlite — an Electron-runtime builtin this bun can't load.
// Stand it in with bun:sqlite, the same pattern the store tests use.
mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type EmitEvent = (event: import("./types.js").RuntimeEvent) => void;

/** The fake every adapter module exports: captures the emit closure (so the
 *  test can emit like the provider would) and records stopSession calls (so
 *  the wedge watchdog is observable). */
class FakeAdapter {
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
  };
  static stopped: string[] = [];
  /** Per thread, whether its reset had been announced when its stop came. */
  static announcedAtStop = new Map<string, boolean>();
  /** Every sendTurn the service routed to a fake — the queue tests assert the
   *  busy path never dispatches and the promotion path dispatches once. */
  static sentTurns: Array<{ threadId: string; input: SendTurnInput; turnId: string }> = [];
  static turnCounter = 0;
  /** (provider, emit) for every fake constructed — the test reaches the emit
   *  closures through this to drive the merged event stream. */
  static emits: { provider: string; emit: EmitEvent }[] = [];
  /** The constructed instances — tests attach/detach the optional steerTurn
   *  channel per provider (the real adapters mostly don't have one). */
  static instances: FakeAdapter[] = [];
  constructor(
    public emit: EmitEvent,
    readonly provider: string,
  ) {
    FakeAdapter.emits.push({ provider, emit });
    FakeAdapter.instances.push(this);
  }
  async stopSession(threadId: string): Promise<void> {
    FakeAdapter.stopped.push(threadId);
    FakeAdapter.announcedAtStop.set(
      threadId,
      received.some((e) => e.threadId === threadId && e.type === "session.state.changed" && e.state === "error"),
    );
  }
  async stopAll(): Promise<void> {}
  /** The service's liveness hook, as a real adapter keeps it. */
  alive: (threadId: string) => void = () => {};
  setLivenessHook(hook: (threadId: string) => void): void {
    this.alive = hook;
  }
  // The fake is injected as a `ProviderAdapter` wholesale (see the cast where
  // `adapters` is built); these stub methods are never called by the tests, so
  // they return the emptiest thing that reads as "nothing here".
  // eslint-disable-next-line anti-slop/no-unknown-returns
  async discover(): Promise<unknown> {
    return [];
  }
  async listModels(): Promise<unknown[]> {
    return FakeAdapter.models[this.provider] ?? [];
  }
  /** Per-provider catalogs the window-resolution tests warm. */
  static models: Partial<Record<ProviderKind, ModelDescriptor[]>> = {};
  // eslint-disable-next-line anti-slop/no-unknown-returns
  async startSession(): Promise<unknown> {
    return {};
  }
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const turnId = `turn-${++FakeAdapter.turnCounter}`;
    FakeAdapter.sentTurns.push({ threadId: input.threadId, input, turnId });
    return { threadId: input.threadId, turnId };
  }
  /** Optional per-adapter live-steer channel, exactly like the interface. */
  steerTurn?: (input: SendTurnInput) => Promise<TurnStartResult>;
  static interrupted: string[] = [];
  async interruptTurn(threadId?: string): Promise<void> {
    if (threadId) FakeAdapter.interrupted.push(threadId);
  }
  /** Every approval decision the service handed back. */
  static responded: Array<{ threadId: string; requestId: string; decision: string }> = [];
  async respondToRequest(threadId: string, requestId: string, decision: string): Promise<void> {
    FakeAdapter.responded.push({ threadId, requestId, decision });
  }
  async respondToUserInput(): Promise<UserInputRespondResult> {
    return { owned: true };
  }
  async listSessions(): Promise<unknown[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
}

/** In-memory stand-in for the store's queue slice (ConversationStore, landing
 *  in parallel). Mirrors the store contract: steer-first claiming, FIFO
 *  fallback, state transitions, and the (thread_id, user_block_id) dedupe.
 *  loadThread backs the transcript read the service uses to derive a row's
 *  userBlockId.
 *
 *  Journaling is NOT a side effect of enqueueing here, because it isn't one in
 *  production either: `dispatch.recordUserBlock` writes the block, and only
 *  the dispatcher calls it. An earlier version of this fake appended a
 *  synthetic block per accepted enqueue "because the real send path journals
 *  one" — which quietly guaranteed every row a distinct userBlockId and hid a
 *  real bug on the path that does NOT journal. Tests that stand in for the
 *  dispatcher call `journalUserBlock` themselves. */
/** The block shape the queue path reads back; `id` is what a row's userBlockId
 *  is derived from. */
type FakeUserBlock = { id: string; role: "user"; text: string; at: number };

/** Only the slice of a stored thread the queue path reads — deliberately
 *  narrower than the real `StoredThread`, which carries metadata the fake has
 *  no reason to invent. */
type FakeStoredThread = { threadId: string; blocks: FakeUserBlock[] };

class FakeQueueStore {
  rows: QueuedTurnRow[] = [];
  /** Journaled blocks marked as steered into a running turn. */
  steeredBlocks: string[] = [];
  private blocksByThread = new Map<string, FakeUserBlock[]>();
  private journaled = 0;

  seedUserBlocks(threadId: string, ids: string[]): void {
    this.blocksByThread.set(
      threadId,
      ids.map((id) => ({ id, role: "user" as const, text: id, at: Date.now() })),
    );
  }

  /** Journal a user block the way dispatch.sendThreadTurn does, before its
   *  send reaches the service. Tests that drive `service.sendTurn` directly
   *  call this to stand in for the dispatcher. */
  journalUserBlock(threadId: string, text: string): string {
    let blocks = this.blocksByThread.get(threadId);
    if (!blocks) {
      blocks = [];
      this.blocksByThread.set(threadId, blocks);
    }
    const id = `journaled-${++this.journaled}`;
    blocks.push({ id, role: "user", text, at: Date.now() });
    return id;
  }

  reset(): void {
    this.rows.length = 0;
    this.steeredBlocks.length = 0;
    this.blocksByThread.clear();
    this.journaled = 0;
  }

  loadThread(threadId: string): FakeStoredThread | null {
    const blocks = this.blocksByThread.get(threadId);
    if (!blocks) return null;
    return { threadId, blocks: [...blocks] };
  }

  latestUserBlockId(threadId: string): string | null {
    return this.blocksByThread.get(threadId)?.at(-1)?.id ?? null;
  }

  // Synchronous, like ConversationStore: the service is typed against the
  // store's own signatures, and a fake that answered with promises would hide
  // exactly the sync/async mistakes the real store exposes.
  enqueueQueuedTurn(input: QueuedTurnEnqueueInput): boolean {
    if (this.rows.some((r) => r.threadId === input.threadId && r.userBlockId === input.userBlockId)) {
      return false;
    }
    const now = Date.now();
    const { at: _at, ...fields } = input;
    this.rows.push({
      ...fields,
      dispatchMode: input.dispatchMode ?? "queue",
      state: "queued",
      attemptCount: 0,
      createdAt: now,
      updatedAt: now,
    });
    return true;
  }

  claimNextQueuedTurn(threadId: string): QueuedTurnRow | null {
    const pending = this.rows
      .filter((r) => r.threadId === threadId && (r.state === "queued" || r.state === "failed"))
      .sort((a, b) => {
        if (a.dispatchMode !== b.dispatchMode) return a.dispatchMode === "steer" ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
    // A held row pauses what runs after it, as in the store.
    const row = pending[0];
    if (!row || row.state !== "queued") return null;
    row.state = "promoting";
    row.attemptCount += 1;
    row.updatedAt = Date.now();
    return { ...row };
  }

  claimQueuedTurn(queueId: string): { row: QueuedTurnRow; from: "queued" | "failed" } | null {
    const row = this.rows.find((r) => r.queueId === queueId && (r.state === "queued" || r.state === "failed"));
    if (!row) return null;
    const from = row.state === "failed" ? "failed" : "queued";
    row.state = "promoting";
    row.attemptCount += 1;
    return { row: { ...row }, from };
  }

  isQueuedTurnClaimed(queueId: string): boolean {
    return this.rows.some((r) => r.queueId === queueId && r.state === "promoting");
  }

  markQueuedTurnPromoted(queueId: string): boolean {
    const idx = this.rows.findIndex((r) => r.queueId === queueId && r.state === "promoting");
    if (idx < 0) return false;
    this.rows.splice(idx, 1);
    return true;
  }

  releaseQueuedTurn(queueId: string, to: "queued" | "failed" = "queued"): boolean {
    const row = this.rows.find((r) => r.queueId === queueId && r.state === "promoting");
    if (!row) return false;
    row.state = to;
    row.updatedAt = Date.now();
    return true;
  }

  reorderQueuedTurns(threadId: string, queueIds: string[]): boolean {
    const mine = this.rows.filter((r) => r.threadId === threadId);
    const rest = this.rows.filter((r) => r.threadId !== threadId);
    const head = queueIds.flatMap((id) => mine.filter((r) => r.queueId === id));
    this.rows = [...head, ...mine.filter((r) => !queueIds.includes(r.queueId)), ...rest];
    return head.length > 0;
  }

  markUserBlockSteered(_threadId: string, blockId: string): void {
    this.steeredBlocks.push(blockId);
  }

  cancelQueuedTurn(queueId: string): boolean {
    const idx = this.rows.findIndex((r) => r.queueId === queueId && r.state !== "promoting");
    if (idx < 0) return false;
    this.rows.splice(idx, 1);
    return true;
  }

  cancelQueuedTurnsForThread(threadId: string): string[] {
    const ids = this.rows.filter((r) => r.threadId === threadId).map((r) => r.queueId);
    this.rows = this.rows.filter((r) => r.threadId !== threadId);
    return ids;
  }

  listQueuedTurns(threadId: string): QueuedTurnRow[] {
    return this.rows.filter((r) => r.threadId === threadId).map((r) => ({ ...r }));
  }

  queueBoundary(): number | null {
    return null;
  }

  pendingQueueIds(threadId: string): string[] {
    return this.rows.filter((r) => r.threadId === threadId).map((r) => r.queueId);
  }

  recoverStaleClaims(): number {
    return 0;
  }
}

const fakeStore = new FakeQueueStore();

import type { AgentService as AgentServiceType } from "./AgentService.js";

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let service: AgentServiceType;
let codexEmit: EmitEvent;
const codexBase = {
  threadId: "t-1",
  provider: "codex" as const,
  at: Date.now(),
  source: "codex.app-server" as const,
};
const received: import("./types.js").RuntimeEvent[] = [];

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  FakeAdapter.stopped.length = 0;
  FakeAdapter.emits.length = 0;
  FakeAdapter.instances.length = 0;
  FakeAdapter.sentTurns.length = 0;
  FakeAdapter.turnCounter = 0;
  FakeAdapter.models = {};
  fakeStore.reset();
  service = new AgentServiceCtor({
    wedgeSweepMs: 40,
    wedgeSilenceMs: 30,
    wedgeItemSilenceMs: 200,
    idleSweepMs: 40,
    idleThresholdMs: 50,
    // The fake implements the queue slice the service needs (its loadThread
    // only backs latestUserBlockId's user-block walk, so it is not a full
    // StoredThread) — cast at the boundary, the same contract the module mock
    // used to stand in for.
    // SAFETY: fakeStore implements the queued-turn slice this service reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: fakeStore as unknown as QueuedTurnStore,
    // The fakes are constructed inside the service with its real emit closure,
    // exactly like the real adapters — FakeAdapter.emits records them so the
    // tests below can drive the merged event stream.
    // SAFETY: five fake adapters are the whole provider roster here.
    adapters: (emit) =>
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      [
        new FakeAdapter(emit, "codex"),
        new FakeAdapter(emit, "claudeAgent"),
        new FakeAdapter(emit, "opencode"),
        new FakeAdapter(emit, "cursor"),
        new FakeAdapter(emit, "droid"),
      ] as unknown as ProviderAdapter[],
  });
  service.onEvent((e) => received.push(e));
  // The fakes are constructed inside AgentService; each captured the emit
  // closure it was handed, which is all the test needs to drive the stream.
  const codexFake = FakeAdapter.emits.find((e) => e.provider === "codex");
  if (!codexFake) throw new Error("codex fake was not constructed");
  codexEmit = codexFake.emit;
});

afterAll(async () => {
  await service.stopAll();
});

describe("AgentService recovery bookkeeping", () => {
  test("tracks parked approvals and replays them from pendingInteractions", () => {
    const approvalEvent = {
      ...codexBase,
      type: "approval.requested" as const,
      requestId: "req-1",
      turnId: "turn-1",
      approval: { kind: "command" as const, title: "rm -rf node_modules" },
    };
    codexEmit(approvalEvent);
    const pending = service.pendingInteractions();
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({
      threadId: "t-1",
      requestId: "req-1",
      kind: "approval",
    });
    expect(pending[0].event).toBe(approvalEvent);
  });

  test("tracks parked user-input questions with kind user-input", () => {
    const inputEvent = {
      ...codexBase,
      type: "user-input.requested" as const,
      requestId: "req-2",
      turnId: "turn-1",
      questions: [{ id: "q", header: "Q", question: "Which one?" }],
    };
    codexEmit(inputEvent);
    const pending = service.pendingInteractions();
    expect(pending).toHaveLength(2);
    expect(pending.find((p) => p.requestId === "req-2")?.kind).toBe("user-input");
  });

  test("resolved events drop the parked ask", () => {
    codexEmit({
      ...codexBase,
      type: "approval.resolved" as const,
      requestId: "req-1",
      decision: "allow-once",
    });
    const pending = service.pendingInteractions();
    expect(pending).toHaveLength(1);
    expect(pending[0].requestId).toBe("req-2");
  });

  test("Kone questions park the live turn, recover after reload, and answer without sending", async () => {
    const base = { ...codexBase, threadId: "t-kone-question" };
    codexEmit({ ...base, type: "turn.started", turnId: "question-turn" });
    const sentBefore = FakeAdapter.sentTurns.length;
    const answer = service.askUser({ ...base, cwd: "/tmp", turnId: "question-turn",
      questions: [{ id: "q0", header: "Question", question: "Which one?", options: [] }] });
    const pending = service.pendingInteractions().find((p) => p.threadId === base.threadId);
    if (!pending) throw new Error("missing recoverable question");
    expect(service.threadRuntime(base.threadId)).toMatchObject({ busy: true, parked: "user-input" });
    expect(await service.respondToUserInput(base.threadId, pending.requestId, { q0: "Blue" })).toEqual({ owned: true });
    expect(await answer).toEqual({ q0: "Blue" });
    expect(service.pendingInteractions().find((p) => p.threadId === base.threadId)).toBeUndefined();
    expect(service.threadRuntime(base.threadId)).toMatchObject({ busy: true, parked: null });
    expect(FakeAdapter.sentTurns).toHaveLength(sentBefore);
    expect(await service.respondToUserInput(base.threadId, pending.requestId, { q0: "Late" })).toEqual({ owned: false });
    codexEmit({ ...base, type: "turn.completed", turnId: "question-turn" });
  });

  test("aborting a turn clears Kone questions and unblocks its tool call", async () => {
    const base = { ...codexBase, threadId: "t-kone-question-abort" };
    codexEmit({ ...base, type: "turn.started", turnId: "question-turn" });
    const answer = service.askUser({ ...base, cwd: "/tmp", turnId: "question-turn",
      questions: [{ id: "q0", header: "Question", question: "Which one?", options: [] }] });
    codexEmit({ ...base, type: "turn.aborted", turnId: "question-turn", reason: "interrupted" });
    expect(await answer).toEqual({});
    expect(service.pendingInteractions().find((p) => p.threadId === base.threadId)).toBeUndefined();
    expect(await service.askUser({ ...base, cwd: "/tmp", turnId: "question-turn", questions: [] })).toEqual({});
  });

  test("a provider's question and a Kone question on one thread show one at a time, and none is hidden", async () => {
    const base = { ...codexBase, threadId: "t-overlap" };
    const shown = () => received.filter((e) => e.threadId === base.threadId && e.type === "user-input.requested");
    const parked = () => service.pendingInteractions().filter((p) => p.threadId === base.threadId);
    codexEmit({ ...base, type: "turn.started", turnId: "overlap-turn" });
    codexEmit({ ...base, type: "user-input.requested", requestId: "native-1", turnId: "overlap-turn",
      questions: [{ id: "q", header: "Native", question: "Native?" }] });
    const answer = service.askUser({ ...base, cwd: "/tmp", turnId: "overlap-turn",
      questions: [{ id: "q0", header: "Kone", question: "Kone?", options: [] }] });
    // The Kone question waits: the renderer, and a reload's replay, see only the native one.
    expect(shown().map((e) => e.requestId)).toEqual(["native-1"]);
    expect(parked().map((p) => p.requestId)).toEqual(["native-1"]);
    // The provider settles its own ask; the Kone question takes its place.
    codexEmit({ ...base, type: "user-input.resolved", requestId: "native-1", answers: { q: "yes" } });
    const kone = parked();
    expect(kone).toHaveLength(1);
    expect(kone[0]!.requestId.startsWith("question:")).toBe(true);
    expect(shown().map((e) => e.requestId)).toEqual(["native-1", kone[0]!.requestId]);
    // A provider ask arriving now waits behind it, and the turn's end drops both.
    codexEmit({ ...base, type: "user-input.requested", requestId: "native-2", turnId: "overlap-turn",
      questions: [{ id: "q", header: "Native", question: "Again?" }] });
    expect(parked().map((p) => p.requestId)).toEqual([kone[0]!.requestId]);
    codexEmit({ ...base, type: "turn.aborted", turnId: "overlap-turn", reason: "interrupted" });
    expect(await answer).toEqual({});
    expect(parked()).toHaveLength(0);
    expect(shown()).toHaveLength(2);
    // The adapter's late word on the dropped ask still reaches listeners.
    codexEmit({ ...base, type: "user-input.resolved", requestId: "native-2", answers: {} });
    expect(received.some((e) => e.type === "user-input.resolved" && e.requestId === "native-2")).toBe(true);
  });

  test("a terminal session drops every parked ask", () => {
    codexEmit({
      ...codexBase,
      type: "session.state.changed" as const,
      state: "stopped",
    });
    expect(service.pendingInteractions()).toHaveLength(0);
  });
});

describe("AgentService wedge watchdog", () => {
  test("resets a live turn silent past the threshold, announcing the reset", async () => {
    const thread = "t-wedge";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-w" });
    // Silence > wedgeSilenceMs with the sweep at 40ms — the watchdog must stop
    // the session and announce it as an error.
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).toContain(thread);
    // SAFETY: the predicate matches only session.state.changed events.
    const reset = received.find(
      (e) => e.threadId === thread && e.type === "session.state.changed" && e.state === "error",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "session.state.changed" }> | undefined;
    expect(reset?.message).toBe("wedged — session reset");
    // Announced before the stop, whose own abort would otherwise read as an
    // interrupt somebody asked for, and a parent would hold its report.
    expect(FakeAdapter.announcedAtStop.get(thread)).toBe(true);
  }, 5_000);

  test("never resets a session parked on a human answer", async () => {
    const thread = "t-parked";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-p" });
    codexEmit({
      ...base,
      type: "approval.requested",
      requestId: "req-p",
      turnId: "turn-p",
      approval: { kind: "command", title: "git push" },
    });
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  test("a recent event keeps a live turn alive", async () => {
    const thread = "t-busy";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-b" });
    // Heartbeat well inside the silence threshold — emitted twice so the sweep
    // (40ms) always sees fresh activity.
    const heartbeat = setInterval(() => {
      codexEmit({ ...base, type: "thread.token-usage.updated", usage: { total: 1 } });
    }, 10);
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(heartbeat);
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  // A model that thinks without streaming text: the adapter sees the provider
  // working and says so through the liveness hook, with no event at all.
  test("a turn its adapter reports alive is not reset, though it emits nothing", async () => {
    const thread = "t-thinking";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-t" });
    const codex = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    const before = received.length;
    const thinking = setInterval(() => codex.alive(thread), 10);
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(thinking);
    expect(FakeAdapter.stopped).not.toContain(thread);
    // Kone-internal: nothing reached the event stream.
    expect(received.slice(before).filter((e) => e.threadId === thread)).toEqual([]);
  }, 5_000);

  test("liveness for another thread, or for a thread with no turn, keeps nobody alive", async () => {
    const thread = "t-silent";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    const codex = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    // Before the turn: nothing to keep alive, so nothing is remembered.
    codex.alive(thread);
    codexEmit({ ...base, type: "turn.started", turnId: "turn-s" });
    const elsewhere = setInterval(() => codex.alive("t-someone-else"), 10);
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(elsewhere);
    expect(FakeAdapter.stopped).toContain(thread);
  }, 5_000);

  test("a thread with an open item is not reset at the short silence threshold", async () => {
    const thread = "t-wedge-item-open";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-item" });
    codexEmit({
      ...base,
      type: "item.started",
      turnId: "turn-item",
      item: { itemId: "item-1", kind: "tool_call", status: "in-progress", text: "npm test" },
    });
    // Silence > wedgeSilenceMs (30) but < wedgeItemSilenceMs (200) — the open
    // item buys the thread the longer threshold, so it must not be reset.
    await new Promise((r) => setTimeout(r, 100));
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  test("a thread with an open item is still reset once silence exceeds the item threshold", async () => {
    const thread = "t-wedge-item-timeout";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-item" });
    codexEmit({
      ...base,
      type: "item.started",
      turnId: "turn-item",
      item: { itemId: "item-1", kind: "tool_call", status: "in-progress", text: "npm test" },
    });
    // Silence past wedgeItemSilenceMs (200) — even with an open item the thread
    // is genuinely wedged now.
    await new Promise((r) => setTimeout(r, 260));
    expect(FakeAdapter.stopped).toContain(thread);
  }, 5_000);

  test("item.completed clears the open item so the short threshold applies again", async () => {
    const thread = "t-wedge-item-closed";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...base, type: "turn.started", turnId: "turn-item" });
    codexEmit({
      ...base,
      type: "item.started",
      turnId: "turn-item",
      item: { itemId: "item-1", kind: "tool_call", status: "in-progress", text: "npm test" },
    });
    codexEmit({
      ...base,
      type: "item.completed",
      turnId: "turn-item",
      item: { itemId: "item-1", kind: "tool_call", status: "completed", text: "npm test" },
    });
    // The item settled, so the short threshold (30) governs again — 100ms of
    // silence must reset the thread.
    await new Promise((r) => setTimeout(r, 100));
    expect(FakeAdapter.stopped).toContain(thread);
  }, 5_000);
});

describe("AgentService: an end somebody asked for", () => {
  test("an interrupt or a stop marks it, before the teardown; a new send or session clears it", async () => {
    const thread = "t-end-asked";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    expect(service.endWasAsked(thread)).toBe(false);
    await service.interruptTurn(thread);
    expect(service.endWasAsked(thread)).toBe(true);
    await service.sendTurn({ threadId: thread, input: "next" });
    expect(service.endWasAsked(thread)).toBe(false);
    await service.stopSession(thread);
    expect(service.endWasAsked(thread)).toBe(true);
    codexEmit({ ...base, type: "session.started" });
    expect(service.endWasAsked(thread)).toBe(false);
  });

  test("reject-and-stop marks it, since the adapter ends the turn itself", async () => {
    const thread = "t-end-asked-reject";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.respondToRequest(thread, "req-1", "reject-and-stop");
    expect(service.endWasAsked(thread)).toBe(true);
  });

  test("an exit takes the mark with it, once its listeners have read it", async () => {
    const thread = "t-end-asked-exit";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.interruptTurn(thread);
    let seen: boolean | null = null;
    const off = service.onEvent((e) => {
      if (e.threadId === thread && e.type === "session.exited") seen = service.endWasAsked(thread);
    });
    codexEmit({ ...base, type: "session.exited", code: null });
    off?.();
    expect(seen).toBe(true);
    await Promise.resolve();
    expect(service.endWasAsked(thread)).toBe(false);
  });
});

describe("AgentService idle session reaper", () => {
  test("stops an inactive session whose inactivity exceeds the idle threshold", async () => {
    const thread = "t-idle-1";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    // Inactivity > idleThresholdMs (50ms) with sweep at 40ms — reaper must stop the session.
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).toContain(thread);
    // SAFETY: the predicate matches only session.state.changed events.
    const stoppedEvent = received.find(
      (e) => e.threadId === thread && e.type === "session.state.changed" && e.state === "stopped",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "session.state.changed" }> | undefined;
    expect(stoppedEvent?.message).toBe("idle session reaped");
  }, 5_000);

  test("never reaps a session while a turn is actively running", async () => {
    const thread = "t-idle-turn-active";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    FakeAdapter.stopped.length = 0;
    codexEmit({ ...base, type: "turn.started", turnId: "turn-running" });
    // Wait past the idle threshold (50ms) while a turn is in flight.
    await new Promise((r) => setTimeout(r, 150));
    // The idle reaper must NOT have stopped it (the wedge watchdog handles hung turns instead).
    const reapedEvent = received.find(
      (e) => e.threadId === thread && e.type === "session.state.changed" && e.message === "idle session reaped",
    );
    expect(reapedEvent).toBeUndefined();
  }, 5_000);

  test("never reaps a session parked on human approval or user input", async () => {
    const thread = "t-idle-parked";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    FakeAdapter.stopped.length = 0;
    codexEmit({ ...base, type: "turn.started", turnId: "turn-p" });
    codexEmit({
      ...base,
      type: "approval.requested",
      requestId: "req-idle-p",
      turnId: "turn-p",
      approval: { kind: "command", title: "git push" },
    });
    // Wait past the idle threshold.
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  test("recent activity resets the idle timer and keeps the session alive", async () => {
    const thread = "t-idle-heartbeat";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    FakeAdapter.stopped.length = 0;
    // Emit periodic activity within the 50ms threshold.
    const heartbeat = setInterval(() => {
      codexEmit({ ...base, type: "thread.token-usage.updated", usage: { total: 1 } });
    }, 15);
    await new Promise((r) => setTimeout(r, 150));
    clearInterval(heartbeat);
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  test("re-starting a reaped session starts cleanly and resumes", async () => {
    const thread = "t-idle-resume";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).toContain(thread);

    // Re-start the session.
    FakeAdapter.stopped.length = 0;
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask", resume: thread });
    expect(FakeAdapter.stopped).not.toContain(thread);
  }, 5_000);

  test("never reaps a session that has queued turns waiting", async () => {
    const thread = "t-idle-queued";
    const base = { ...codexBase, threadId: thread };
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    FakeAdapter.stopped.length = 0;
    // Set a live turn and enqueue a turn.
    codexEmit({ ...base, type: "turn.started", turnId: "turn-running-q" });
    await service.sendTurn({ threadId: thread, input: "queued follow up" });
    // Wait past the idle threshold.
    await new Promise((r) => setTimeout(r, 150));
    const reapedEvent = received.find(
      (e) => e.threadId === thread && e.type === "session.state.changed" && e.message === "idle session reaped",
    );
    expect(reapedEvent).toBeUndefined();
  }, 5_000);
});

describe("AgentService durable turn queue + steering", () => {
  /** Let the fire-and-forget promotion drain (claim → send → markPromoted →
   *  dispatch) run to completion. */
  const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

  /** Start a session and bring a turn live on it, exactly like the renderer's
   *  send path leaves the service. */
  async function startBusyThread(threadId: string, turnId: string): Promise<void> {
    await service.startSession({ threadId, provider: "codex", cwd: "/tmp", mode: "ask" });
    codexEmit({ ...codexBase, threadId, type: "turn.started", turnId });
  }

  beforeEach(() => {
    fakeStore.reset();
    FakeAdapter.sentTurns.length = 0;
  });

  test("a send while a turn is live is durably enqueued, not dispatched", async () => {
    const thread = "t-q-enqueue";
    fakeStore.seedUserBlocks(thread, ["block-first", "block-followup"]);
    await startBusyThread(thread, "live-1");

    const result = await service.sendTurn({
      threadId: thread,
      input: "follow-up please",
      model: "gpt-5",
      mode: "full-access",
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
    });

    // The busy path must NOT reach the adapter.
    expect(FakeAdapter.sentTurns.filter((t) => t.threadId === thread)).toHaveLength(0);
    expect(fakeStore.rows).toHaveLength(1);
    const row = fakeStore.rows[0];
    expect(row).toMatchObject({
      threadId: thread,
      userBlockId: "block-followup",
      dispatchMode: "queue",
      state: "queued",
      input: "follow-up please",
      model: "gpt-5",
      mode: "full-access",
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
      attemptCount: 0,
    });
    // The ack's turnId is the queue id — the renderer correlates with the
    // eventual turn.promoted by it.
    expect(result.turnId).toBe(row.queueId);

    // SAFETY: the predicate matches only turn.queued events.
    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    expect(queued).toMatchObject({
      queueId: row.queueId,
      userBlockId: "block-followup",
      dispatchMode: "queue",
      position: 1, // first queued entry in line
      input: "follow-up please",
    });
  });

  test("the enqueued row keeps its attachments, and turn.queued carries them", async () => {
    const thread = "t-q-enqueue-attachments";
    fakeStore.seedUserBlocks(thread, ["block-first", "block-followup"]);
    await startBusyThread(thread, "live-1");

    await service.sendTurn({
      threadId: thread,
      input: "with file",
      attachments: [
        { type: "file", id: "a1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 },
      ],
    });

    const row = fakeStore.rows.find((r) => r.threadId === thread)!;
    expect(row.attachments?.map((a) => a.id)).toEqual(["a1"]);
    // SAFETY: the predicate matches only turn.queued events.
    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    expect(queued?.attachmentsJson).toBe(JSON.stringify(row.attachments));
  });

  test("turn.queued carries the tier and model the row was journaled with", async () => {
    const thread = "t-q-enqueue-stamps";
    fakeStore.seedUserBlocks(thread, ["block-first", "block-followup"]);
    await startBusyThread(thread, "live-1");

    await service.sendTurn({
      threadId: thread,
      input: "follow-up please",
      effort: "high",
      model: "claude-opus-5",
    });

    const row = fakeStore.rows.find((r) => r.threadId === thread)!;
    // SAFETY: the predicate matches only turn.queued events.
    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    // The event says exactly what the durable row says, so a live queue and a
    // queue rebuilt after a quit stamp the promoted turn identically.
    expect(queued?.effort).toBe(row.effort!);
    expect(queued?.model).toBe(row.model!);
  });

  test("turn.completed promotes the queued turn with its original overrides", async () => {
    const thread = "t-q-promote";
    fakeStore.seedUserBlocks(thread, ["b1"]);
    await startBusyThread(thread, "live-1");
    await service.sendTurn({
      threadId: thread,
      input: "next task",
      model: "claude-4",
      mode: "accept-edits",
      effort: "max",
      serviceTier: "pro",
      contextWindow: "1m",
    });
    const queueId = fakeStore.rows[0].queueId;

    codexEmit({ ...codexBase, threadId: thread, type: "turn.completed", turnId: "live-1" });
    await flush();

    const sent = FakeAdapter.sentTurns.find((t) => t.threadId === thread);
    expect(sent?.input).toMatchObject({
      input: "next task",
      model: "claude-4",
      mode: "accept-edits",
      effort: "max",
      serviceTier: "pro",
      contextWindow: "1m",
    });
    // markQueuedTurnPromoted removed the row — the claim settled.
    expect(fakeStore.rows).toHaveLength(0);
    // SAFETY: the predicate matches only turn.queued events.
    const promoted = received.find(
      (e) => e.threadId === thread && e.type === "turn.promoted",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.promoted" }> | undefined;
    expect(promoted).toMatchObject({ queueId, turnId: sent?.turnId });
  });

  test("the assistant's view block reaches the provider, never the queue row", async () => {
    // A gateway that describes the screen for one thread only — every other
    // test's turns pass through it untouched.
    let screen = "screen one";
    const gateway = {
      ready: Promise.resolve(),
      connectionForThread: () => ({}),
      issueBootstrapToken: () => null,
      revokeThread: () => {},
      mcpEndpointUrl: () => "",
      shutdown: async () => {},
      viewBlockFor: (threadId: string) =>
        threadId === "t-view" ? `<kone_view>${screen}</kone_view>` : null,
    };
    // SAFETY: the service reads only the members stubbed above.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    service.attachGateway(gateway as unknown as Parameters<typeof service.attachGateway>[0]);

    fakeStore.seedUserBlocks("t-view", ["b1", "b2"]);
    await service.startSession({ threadId: "t-view", provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.sendTurn({ threadId: "t-view", input: "what is this?" });
    expect(FakeAdapter.sentTurns.at(-1)?.input.input).toBe(
      "<kone_view>screen one</kone_view>\n\nwhat is this?",
    );

    // A follow-up typed while that turn runs is queued as typed, and described
    // as the screen stands when it finally runs.
    codexEmit({ ...codexBase, threadId: "t-view", type: "turn.started", turnId: "live-v" });
    await service.sendTurn({ threadId: "t-view", input: "and now?" });
    expect(fakeStore.rows.find((r) => r.threadId === "t-view")?.input).toBe("and now?");
    screen = "screen two";
    codexEmit({ ...codexBase, threadId: "t-view", type: "turn.completed", turnId: "live-v" });
    await flush();
    expect(FakeAdapter.sentTurns.at(-1)?.input.input).toBe(
      "<kone_view>screen two</kone_view>\n\nand now?",
    );

    // Any other thread's turn goes out exactly as sent.
    await service.startSession({ threadId: "t-not-view", provider: "codex", cwd: "/tmp", mode: "ask" });
    await service.sendTurn({ threadId: "t-not-view", input: "plain" });
    expect(FakeAdapter.sentTurns.at(-1)?.input.input).toBe("plain");
  });

  test("stopSession cancels queued rows and no promotion fires", async () => {
    const thread = "t-q-stop";
    await startBusyThread(thread, "live-1");
    await service.sendTurn({ threadId: thread, input: "queued work" });
    const queueId = fakeStore.rows[0].queueId;

    await service.stopSession(thread);

    expect(fakeStore.rows).toHaveLength(0);
    expect(FakeAdapter.sentTurns.filter((t) => t.threadId === thread)).toHaveLength(0);
    expect(FakeAdapter.stopped).toContain(thread);
    const cancelled = received.filter(
      (e) => e.threadId === thread && e.type === "turn.queued-cancelled",
    );
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]).toMatchObject({ queueId, reason: "stop" });
  });

  test("cancelQueuedTurn drops one row with reason user", async () => {
    const thread = "t-q-cancel-user";
    fakeStore.seedUserBlocks(thread, ["b1"]);
    await startBusyThread(thread, "live-1");
    // Each send journals its own user block first, exactly as the dispatcher
    // does — that is what gives the two rows distinct userBlockIds instead of
    // colliding on the (thread_id, user_block_id) index.
    fakeStore.journalUserBlock(thread, "doomed");
    await service.sendTurn({ threadId: thread, input: "doomed" });
    fakeStore.journalUserBlock(thread, "kept");
    await service.sendTurn({ threadId: thread, input: "kept" });
    expect(fakeStore.rows).toHaveLength(2);
    const doomed = fakeStore.rows[0];

    const cancelled = await service.cancelQueuedTurn(thread, doomed.queueId);

    expect(cancelled).toBe(true);
    expect(fakeStore.rows).toHaveLength(1);
    expect(fakeStore.rows[0].input).toBe("kept");
    const evt = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued-cancelled",
    );
    expect(evt).toMatchObject({ queueId: doomed.queueId, reason: "user" });
  });

  test("steerTurn with a live turn routes to the adapter's steer channel", async () => {
    const thread = "t-q-steer-live";
    await startBusyThread(thread, "live-9");
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    let steered: SendTurnInput | undefined;
    // The adapter is the one that announces the steer, as the real ones do.
    codexFake.steerTurn = async (input: SendTurnInput) => {
      steered = input;
      codexFake.emit({
        ...codexBase,
        threadId: input.threadId,
        type: "turn.steered",
        turnId: "live-9",
        message: input.input,
        userBlockId: input.userBlockId!,
      });
      return { threadId: input.threadId, turnId: "steer-ack" };
    };

    const result = await service.steerTurn({ threadId: thread, input: "nudge the plan", userBlockId: "ub-nudge" });

    expect(result.turnId).toBe("steer-ack");
    expect(steered?.input).toBe("nudge the plan");
    expect(fakeStore.rows).toHaveLength(0); // nothing enqueued
    // Announced once — by the adapter, never again by the service.
    const steeredEvents = received.filter((e) => e.threadId === thread && e.type === "turn.steered");
    expect(steeredEvents).toHaveLength(1);
    expect(steeredEvents[0]).toMatchObject({ turnId: "live-9", message: "nudge the plan", userBlockId: "ub-nudge" });
    // The journaled prompt is marked, so a reload shows it as steered too.
    expect(fakeStore.steeredBlocks).toEqual(["ub-nudge"]);
    delete codexFake.steerTurn;
  });

  test("a steer carrying several blocks marks each of them, in order", async () => {
    const thread = "t-q-steer-batch";
    await startBusyThread(thread, "live-10");
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    codexFake.steerTurn = async (input: SendTurnInput) => {
      const steered: Extract<import("./types.js").RuntimeEvent, { type: "turn.steered" }> = {
        ...codexBase,
        threadId: input.threadId,
        type: "turn.steered",
        turnId: "live-10",
        message: input.input,
      };
      if (input.userBlockId) steered.userBlockId = input.userBlockId;
      if (input.userBlockIds) steered.userBlockIds = input.userBlockIds;
      codexFake.emit(steered);
      return { threadId: input.threadId, turnId: "steer-ack" };
    };

    await service.steerTurn({
      threadId: thread,
      input: "<agent_messages>…</agent_messages>",
      userBlockId: "ub-m2",
      userBlockIds: ["ub-m1", "ub-m2"],
    });

    expect(fakeStore.steeredBlocks).toEqual(["ub-m1", "ub-m2"]);
    delete codexFake.steerTurn;
  });

  test("steerTurn without a live turn is a plain send", async () => {
    const thread = "t-q-steer-idle";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });

    const result = await service.steerTurn({ threadId: thread, input: "start working" });

    const sent = FakeAdapter.sentTurns.find((t) => t.threadId === thread);
    expect(sent?.input.input).toBe("start working");
    expect(result.turnId).toBe(sent?.turnId);
  });

  test("steerTurn busy without an adapter steer channel enqueues a steer row", async () => {
    const thread = "t-q-steer-fallback";
    await startBusyThread(thread, "live-1");
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    delete codexFake.steerTurn; // ensure absent — earlier tests may have set it

    const result = await service.steerTurn({ threadId: thread, input: "change direction" });

    expect(fakeStore.rows).toHaveLength(1);
    const row = fakeStore.rows[0];
    expect(row).toMatchObject({ dispatchMode: "steer", input: "change direction", state: "queued" });
    expect(result.turnId).toBe(row.queueId);
    // SAFETY: the predicate matches only turn.queued events.
    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    expect(queued?.dispatchMode).toBe("steer");
    expect(FakeAdapter.interrupted).toContain(thread);
  });

  test("a second send landing before turn.started is queued, not dispatched", async () => {
    const thread = "t-q-same-tick";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    // Adapters emit turn.started from INSIDE sendTurn, after their own awaits
    // (ClaudeAdapter reads attachments and applies live settings first), so
    // `activeTurns` is still empty while the first send is in flight. Hold the
    // dispatch open to make that window deterministic.
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const realSend = FakeAdapter.prototype.sendTurn;
    codexFake.sendTurn = async (input: SendTurnInput) => {
      await held;
      return realSend.call(codexFake, input);
    };

    const first = service.sendTurn({ threadId: thread, input: "one" });
    fakeStore.journalUserBlock(thread, "two");
    const second = service.sendTurn({ threadId: thread, input: "two" });
    release?.();
    await Promise.all([first, second]);

    // Only the first reached the provider; the second is a durable row.
    const dispatched = FakeAdapter.sentTurns.filter((t) => t.threadId === thread);
    expect(dispatched.map((t) => t.input.input)).toEqual(["one"]);
    expect(fakeStore.rows.map((r) => r.input)).toEqual(["two"]);
    // SAFETY: FakeAdapter.sendTurn is an own-property override for this test only.
    delete (codexFake as Partial<FakeAdapter>).sendTurn;
  });

  test("turn.queued carries the run order and the mode the row will run in", async () => {
    const thread = "t-q-order";
    await startBusyThread(thread, "live-1");
    fakeStore.journalUserBlock(thread, "plain");
    await service.sendTurn({ threadId: thread, input: "plain", mode: "full-access" });
    fakeStore.journalUserBlock(thread, "second");
    await service.sendTurn({ threadId: thread, input: "second" });

    const queued = received.filter(
      (e): e is Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> =>
        e.threadId === thread && e.type === "turn.queued",
    );
    expect(queued[0]?.mode).toBe("full-access");
    expect(queued[1]?.order).toEqual(fakeStore.rows.map((r) => r.queueId));
  });

  test("send now steers a queued row into the live turn with its own settings", async () => {
    const thread = "t-q-send-now-steer";
    await startBusyThread(thread, "live-1");
    const blockId = fakeStore.journalUserBlock(thread, "queued words");
    await service.sendTurn({ threadId: thread, input: "queued words", model: "gpt-5", effort: "low", mode: "full-access" });
    const queueId = fakeStore.rows[0]!.queueId;
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    let steered: SendTurnInput | undefined;
    // The row is still in the queue (claimed) while the provider takes it.
    let stateDuringSteer: string | undefined;
    codexFake.steerTurn = async (input: SendTurnInput) => {
      steered = input;
      stateDuringSteer = fakeStore.rows.find((r) => r.queueId === queueId)?.state;
      return { threadId: input.threadId, turnId: "live-1" };
    };

    expect(await service.sendQueuedTurnNow(thread, queueId)).toBe(true);

    expect(stateDuringSteer).toBe("promoting");
    expect(steered).toMatchObject({ input: "queued words", model: "gpt-5", effort: "low", mode: "full-access", userBlockId: blockId });
    expect(fakeStore.rows).toHaveLength(0);
    expect(received.find((e) => e.threadId === thread && e.type === "turn.promoted")).toMatchObject({
      queueId,
      turnId: "live-1",
    });
    delete codexFake.steerTurn;
  });

  test("send now that the provider refuses puts the row back and says why", async () => {
    const thread = "t-q-send-now-refused";
    await startBusyThread(thread, "live-1");
    fakeStore.journalUserBlock(thread, "keep me");
    await service.sendTurn({ threadId: thread, input: "keep me" });
    const queueId = fakeStore.rows[0]!.queueId;
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    codexFake.steerTurn = async () => {
      throw new Error("turn ended");
    };

    await expect(service.sendQueuedTurnNow(thread, queueId)).rejects.toThrow("turn ended");

    expect(fakeStore.rows).toHaveLength(1);
    expect(fakeStore.rows[0]).toMatchObject({ queueId, state: "queued", input: "keep me" });
    const updates = received.filter((e) => e.threadId === thread && e.type === "turn.queued-updated");
    expect(updates.map((e) => (e.type === "turn.queued-updated" ? e.state : null))).toEqual(["promoting", "queued"]);
    expect(updates[1]).toMatchObject({ error: "turn ended" });
    delete codexFake.steerTurn;
  });

  test("send now without a live steer channel moves the row first and interrupts", async () => {
    const thread = "t-q-send-now-fallback";
    await startBusyThread(thread, "live-1");
    const codexFake = FakeAdapter.instances.find((a) => a.provider === "codex")!;
    delete codexFake.steerTurn;
    fakeStore.journalUserBlock(thread, "first");
    await service.sendTurn({ threadId: thread, input: "first" });
    fakeStore.journalUserBlock(thread, "urgent");
    await service.sendTurn({ threadId: thread, input: "urgent" });
    const urgent = fakeStore.rows[1]!.queueId;

    expect(await service.sendQueuedTurnNow(thread, urgent)).toBe(true);

    expect(fakeStore.rows.map((r) => r.input)).toEqual(["urgent", "first"]);
    expect(fakeStore.rows[0]?.state).toBe("queued");
    expect(received.find((e) => e.threadId === thread && e.type === "turn.queued-reordered")).toMatchObject({
      queueIds: [urgent],
    });
    expect(FakeAdapter.interrupted).toContain(thread);
    expect(FakeAdapter.sentTurns.filter((t) => t.threadId === thread)).toHaveLength(0);
  });

  test("send now on an idle thread starts the row as a turn", async () => {
    const thread = "t-q-send-now-idle";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    // A held row left from before: idle, nothing will drain it on its own.
    await fakeStore.enqueueQueuedTurn({
      queueId: "q-held",
      threadId: thread,
      userBlockId: "ub-held",
      dispatchMode: "queue",
      state: "failed",
      input: "try me again",
      attachmentsJson: null,
      model: "gpt-5",
      mode: null,
      effort: null,
      serviceTier: null,
      contextWindow: null,
      attemptCount: 4,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      promotedAt: null,
    });

    expect(await service.sendQueuedTurnNow(thread, "q-held")).toBe(true);

    const sent = FakeAdapter.sentTurns.filter((t) => t.threadId === thread);
    expect(sent.map((t) => t.input)).toEqual([{ threadId: thread, input: "try me again", model: "gpt-5" }]);
    expect(fakeStore.rows).toHaveLength(0);
  });

  test("send now on a row that already left the queue does nothing", async () => {
    await service.startSession({ threadId: "t-q-send-now-gone", provider: "codex", cwd: "/tmp", mode: "ask" });
    expect(await service.sendQueuedTurnNow("t-q-send-now-gone", "no-such-row")).toBe(false);
    expect(FakeAdapter.sentTurns.filter((t) => t.threadId === "t-q-send-now-gone")).toHaveLength(0);
  });
});

describe("AgentService thread archive + retention", () => {
  /** In-memory stand-in for the store's history slice — subtree stamps,
   *  thread metadata, retention candidates. Mirrors the real contract:
   *  ancestor-first thread ids on success, refusal shapes untouched, and the
   *  done semantics of `done_at` (null = never, 0 = user's "not finished",
   *  a stamp older than the last activity has self-cleared). */
  class FakeHistoryStore {
    /** threadId → parent id (null = root), the spawn pointers setArchived
     *  walks. Held flat; one parent level covers everything these tests pin. */
    private parents = new Map<string, string | null>();
    private providers = new Map<string, string>();
    /** threadId → the archived stamp (null = live) — what the tests assert on. */
    archivedStamp = new Map<string, number | null>();
    /** threadId → the done stamp, with the store's done_at semantics. */
    doneStamps = new Map<string, number | null>();
    /** Idle age per thread, what staleThreadIds's cutoffs read. */
    private ages = new Map<string, number>();
    /** When set to a thread id, the next archive write over that subtree
     *  refuses busy (a descendant mid-turn, from the store's side). */
    busyThread: string | null = null;

    seed(
      threadId: string,
      provider: string,
      parent: string | null = null,
      idleMs = 0,
    ): void {
      this.parents.set(threadId, parent);
      this.providers.set(threadId, provider);
      this.archivedStamp.set(threadId, null);
      this.doneStamps.set(threadId, null);
      this.ages.set(threadId, idleMs);
    }

    /** Whether a thread currently reads as done: a stamp that is not the
     *  cleared marker and has not been outgrown by activity. (With no activity
     *  clock here, a stamped thread reads done until un-marked.) */
    private readsDone(threadId: string): boolean {
      const stamp = this.doneStamps.get(threadId) ?? null;
      return stamp !== null && stamp !== 0;
    }

    private subtreeIds(threadId: string): string[] {
      const out = [threadId];
      for (const [id, parent] of this.parents) {
        if (parent !== null && out.includes(parent) && !out.includes(id)) out.push(id);
      }
      return out;
    }

    setArchived(
      threadId: string,
      archived: boolean,
    ): { ok: true; threadIds: string[] } | { ok: false; reason: "missing" | "busy" | "error" } {
      if (!this.parents.has(threadId)) return { ok: false, reason: "missing" };
      const ids = this.subtreeIds(threadId);
      if (archived && this.busyThread !== null && ids.includes(this.busyThread)) {
        return { ok: false, reason: "busy" };
      }
      const stamp = archived ? Date.now() : null;
      for (const id of ids) this.archivedStamp.set(id, stamp);
      return { ok: true, threadIds: ids };
    }

    setDone(threadId: string, done: boolean): void {
      this.doneStamps.set(threadId, done ? Date.now() : 0);
    }

    threadMeta(threadId: string): { threadId: string; provider: string } | null {
      const provider = this.providers.get(threadId);
      if (provider === undefined) return null;
      return { threadId, provider };
    }

    staleThreadIds(options: { unusedMs: number; limit: number; undone?: boolean }): string[] {
      return [...this.parents.entries()]
        .filter(([, parent]) => parent === null)
        .filter(([id]) => (this.archivedStamp.get(id) ?? null) === null)
        .filter(([id]) => (this.ages.get(id) ?? 0) >= options.unusedMs)
        // Mirrors the store's SQL: a done thread is not a done-pass candidate,
        // and neither is done_at = 0 — the user's "not finished" outranks age.
        .filter(([id]) => !options.undone || !(this.readsDone(id) || this.doneStamps.get(id) === 0))
        .sort((a, b) => (this.ages.get(a[0]) ?? 0) - (this.ages.get(b[0]) ?? 0))
        .map(([id]) => id)
        .slice(0, options.limit);
    }

    reset(): void {
      this.parents.clear();
      this.providers.clear();
      this.archivedStamp.clear();
      this.doneStamps.clear();
      this.ages.clear();
      this.busyThread = null;
    }
  }

  const history = new FakeHistoryStore();
  const events: import("./types.js").RuntimeEvent[] = [];
  // Constructed in beforeAll — AgentServiceCtor is assigned there (the dynamic
  // import lands after the sqlite shim), so module-evaluation-time construction
  // would see undefined.
  let archiveService: AgentServiceType;

  beforeAll(() => {
    // Retention's constructor timer is disabled — these tests drive the sweep
    // directly, so the timing knobs never matter.
    archiveService = new AgentServiceCtor({
      retentionSweepMs: 0,
      // SAFETY: fakeStore implements the queued-turn slice this service reads.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: fakeStore as unknown as QueuedTurnStore,
      // SAFETY: the fake implements exactly the three history methods the
      // archive/retention paths read.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      historyStore: history as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"],
      // SAFETY: one fake adapter is a whole enough provider roster here — no
      // archive test sends a turn.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      adapters: (emit) => [new FakeAdapter(emit, "codex") as unknown as ProviderAdapter],
    });
    archiveService.onEvent((e) => events.push(e));
  });

  /** A durable queued row on a thread, without walking the live-turn path. */
  async function seedQueuedTurn(threadId: string, queueId: string): Promise<void> {
    await fakeStore.enqueueQueuedTurn({
      queueId,
      threadId,
      userBlockId: `ub-${queueId}`,
      dispatchMode: "queue",
      state: "queued",
      input: "follow-up",
      attachmentsJson: null,
      model: null,
      mode: null,
      effort: null,
      serviceTier: null,
      contextWindow: null,
      attemptCount: 0,
      createdAt: Date.now(),
      updatedAt: Date.now(),
      promotedAt: null,
    });
  }

  beforeEach(() => {
    fakeStore.reset();
    history.reset();
    events.length = 0;
  });

  /** The archive events, narrowed without assertions — the predicate pins the
   *  union member and the compiler does the rest. */
  function archivedEvents(): Array<Extract<import("./types.js").RuntimeEvent, { type: "thread.archived" }>> {
    return events.filter(
      (e): e is Extract<import("./types.js").RuntimeEvent, { type: "thread.archived" }> =>
        e.type === "thread.archived",
    );
  }

  /** The done-mark events, narrowed the same way. */
  function doneEvents(): Array<
    Extract<import("./types.js").RuntimeEvent, { type: "thread.done.updated" }>
  > {
    return events.filter(
      (e): e is Extract<import("./types.js").RuntimeEvent, { type: "thread.done.updated" }> =>
        e.type === "thread.done.updated",
    );
  }

  test("archiving a subtree cancels its queued turns and announces every thread", async () => {
    history.seed("root-1", "codex");
    history.seed("child-1", "codex", "root-1");
    await seedQueuedTurn("child-1", "q-arch-1");
    await seedQueuedTurn("root-1", "q-arch-2");

    const result = await archiveService.setThreadArchived("root-1", true);

    expect(result).toEqual({ ok: true, threadIds: ["root-1", "child-1"] });
    // A hidden thread must not carry a queue the user can no longer see.
    expect(fakeStore.rows).toHaveLength(0);
    // One thread.archived per stamped thread — the root AND the child carried
    // along with it.
    expect(archivedEvents().map((e) => e.threadId)).toEqual(["root-1", "child-1"]);
    // One queued-cancelled per row, reason "archive" — the variant the
    // renderer already folds.
    const cancelled = events.filter(
      (e): e is Extract<import("./types.js").RuntimeEvent, { type: "turn.queued-cancelled" }> =>
        e.type === "turn.queued-cancelled",
    );
    expect(
      cancelled
        .map((e) => ({ queueId: e.queueId, reason: e.reason }))
        .sort((a, b) => a.queueId.localeCompare(b.queueId)),
    ).toEqual([
      { queueId: "q-arch-1", reason: "archive" },
      { queueId: "q-arch-2", reason: "archive" },
    ]);
  });

  test("unarchiving announces the subtree and touches no queue rows", async () => {
    history.seed("root-1", "codex");
    await archiveService.setThreadArchived("root-1", true);
    events.length = 0;
    await seedQueuedTurn("root-1", "q-unarch-1");

    const result = await archiveService.setThreadArchived("root-1", false);

    expect(result).toEqual({ ok: true, threadIds: ["root-1"] });
    expect(events.map((e) => e.type)).toEqual(["thread.unarchived"]);
    expect(events[0]).toMatchObject({ threadId: "root-1" });
    expect(fakeStore.rows).toHaveLength(1);
  });

  test("a busy refusal writes and announces nothing", async () => {
    history.seed("root-1", "codex");
    history.seed("child-1", "codex", "root-1");
    history.busyThread = "child-1";
    await seedQueuedTurn("root-1", "q-busy-1");

    const result = await archiveService.setThreadArchived("root-1", true);

    expect(result).toEqual({ ok: false, reason: "busy" });
    expect(events).toHaveLength(0);
    // The queue survives: the caller rolls its optimistic drop back.
    expect(fakeStore.rows).toHaveLength(1);
  });

  test("the retention sweep archives its candidates through the same path", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    history.seed("stale-1", "codex", null, 8 * DAY);
    history.seed("stale-2", "claudeAgent", null, 8 * DAY);
    history.seed("busy-1", "codex", null, 8 * DAY);
    history.busyThread = "busy-1";

    await archiveService.sweepStaleThreads();

    expect(history.archivedStamp.get("stale-1")).not.toBeNull();
    expect(history.archivedStamp.get("stale-2")).not.toBeNull();
    // A candidate that turned busy between the query and its write is
    // skipped, not forced — the next sweep picks it up.
    expect(history.archivedStamp.get("busy-1")).toBeNull();
    expect(archivedEvents().map((e) => e.threadId)).toEqual(["stale-1", "stale-2"]);
  });

  test("the sweep marks three-day-idle threads done before anything is archived", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    history.seed("cooling-1", "codex", null, 4 * DAY); // past done, short of archive
    history.seed("cold-1", "codex", null, 8 * DAY); // past both: done, then archived
    history.seed("kept-1", "codex", null, 4 * DAY); // the user said "not finished"
    history.seed("recent-1", "codex", null, 0); // not stale to any pass
    history.setDone("kept-1", false); // done_at = 0 (DONE_CLEARED)

    await archiveService.sweepStaleThreads();

    // Quiet for days → done: the thread stops asking but stays in the live
    // list, and nothing about it was hidden.
    expect(history.doneStamps.get("cooling-1")).not.toBeNull();
    expect(history.doneStamps.get("cooling-1")).not.toBe(0);
    expect(history.archivedStamp.get("cooling-1")).toBeNull();
    // A week-old thread rides the whole funnel: marked done by the first
    // pass, then put away by the second.
    expect(history.doneStamps.get("cold-1")).not.toBeNull();
    expect(history.archivedStamp.get("cold-1")).not.toBeNull();
    // The user's explicit "not finished" outranks age — no pass touches it.
    expect(history.doneStamps.get("kept-1")).toBe(0);
    expect(history.archivedStamp.get("kept-1")).toBeNull();
    // Recent activity is stale to neither pass.
    expect(history.doneStamps.get("recent-1")).toBeNull();
    expect(history.archivedStamp.get("recent-1")).toBeNull();
    // Each mark is announced, so lists waiting on the stream move the row
    // without needing a turn to happen first. Done-range order is oldest
    // first; the week-old thread rides both passes.
    expect(doneEvents().map((e) => ({ threadId: e.threadId, done: e.done }))).toEqual([
      { threadId: "cooling-1", done: true },
      { threadId: "cold-1", done: true },
    ]);
  });

  test("setThreadDone announces the mark and the un-mark, and nothing for unknown threads", () => {
    history.seed("t-1", "codex");

    archiveService.setThreadDone("t-1", true);
    expect(history.doneStamps.get("t-1")).not.toBeNull();
    expect(doneEvents().map((e) => ({ threadId: e.threadId, done: e.done }))).toEqual([
      { threadId: "t-1", done: true },
    ]);

    events.length = 0;
    archiveService.setThreadDone("t-1", false);
    expect(history.doneStamps.get("t-1")).toBe(0);
    expect(doneEvents().map((e) => e.done)).toEqual([false]);

    // Unknown threads have no row to agree with and no provider to route by —
    // announcing would send every list chasing a thread that isn't there.
    events.length = 0;
    archiveService.setThreadDone("never-existed", true);
    expect(events).toHaveLength(0);
  });

  test("a failing history store surfaces as a rejection, not a swallowed error", async () => {
    // The sweep has no internal error handling around its store reads, so a
    // store that throws rejects the returned promise. The timers that drive it
    // therefore have to attach a .catch — a try/catch around the call sees
    // nothing, and the rejection would take the process down instead.
    class ExplodingHistoryStore extends FakeHistoryStore {
      override staleThreadIds(): string[] {
        throw new Error("history store unavailable");
      }
    }
    const explodingService = new AgentServiceCtor({
      retentionSweepMs: 0,
      // SAFETY: fakeStore implements the queued-turn slice this service reads.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: fakeStore as unknown as QueuedTurnStore,
      // SAFETY: the fake implements exactly the history methods the paths read.
      historyStore:
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        new ExplodingHistoryStore() as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"],
      // SAFETY: one fake adapter is a whole enough provider roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      adapters: (emit) => [new FakeAdapter(emit, "codex") as unknown as ProviderAdapter],
    });

    await expect(explodingService.sweepStaleThreads()).rejects.toThrow("history store unavailable");
  });

  test("retentionDoneMs: 0 keeps the archive pass and drops the done pass", async () => {
    const DAY = 24 * 60 * 60 * 1000;
    const historyNoDone = new FakeHistoryStore();
    historyNoDone.seed("idle-1", "codex", null, 4 * DAY); // done-range, not archive-range
    const noDoneService = new AgentServiceCtor({
      retentionSweepMs: 0,
      retentionDoneMs: 0,
      // SAFETY: fakeStore implements the queued-turn slice this service reads.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: fakeStore as unknown as QueuedTurnStore,
      // SAFETY: the fake implements exactly the history methods the paths read.
      historyStore:
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        historyNoDone as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"],
      // SAFETY: one fake adapter is a whole enough provider roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      adapters: (emit) => [new FakeAdapter(emit, "codex") as unknown as ProviderAdapter],
    });
    const noDoneEvents: import("./types.js").RuntimeEvent[] = [];
    noDoneService.onEvent((e) => noDoneEvents.push(e));

    await noDoneService.sweepStaleThreads();

    // A thread in the done range is untouched: only the mark-done pass reads
    // the shorter cutoff, and it is disabled.
    expect(historyNoDone.doneStamps.get("idle-1")).toBeNull();
    expect(historyNoDone.archivedStamp.get("idle-1")).toBeNull();
    expect(noDoneEvents).toHaveLength(0);
  });
});

/** A FakeAdapter with a compaction story: native when `native` is true (the
 *  test drives the boundary through the captured emit), command-fallback
 *  otherwise. Command turns record per-instance (never the shared static),
 *  so these tests can't disturb the queue suite's turn assertions. */
class CompactFakeAdapter extends FakeAdapter {
  override capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
    // SAFETY: pins the widened literal to the compaction union so the
    // constructor can swap in the per-instance mechanism below.
    compaction: { kind: "unsupported" } as ThreadCompactionCapability,
  };
  compactCalls: string[] = [];
  failCompact = false;
  compactError = new Error("compact failed");
  /** When true the native call parks until the test calls releaseCompact. */
  parkCompact = false;
  releaseCompact: (() => void) | null = null;
  sentCommands: Array<{ threadId: string; input: string; turnId: string }> = [];
  compactThread?: (threadId: string) => Promise<void>;

  constructor(
    emit: EmitEvent,
    provider: string,
    readonly native: boolean,
  ) {
    super(emit, provider);
    if (native) {
      this.capabilities.compaction = { kind: "native" };
      this.compactThread = async (threadId: string): Promise<void> => {
        this.compactCalls.push(threadId);
        if (this.failCompact) throw this.compactError;
        if (this.parkCompact) {
          await new Promise<void>((resolve) => {
            this.releaseCompact = resolve;
          });
        }
      };
    } else {
      this.capabilities.compaction = {
        kind: "command",
        command: provider === "claudeAgent" ? "/compact" : "/compress",
      };
    }
  }

  override async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    const turnId = `compact-turn-${++FakeAdapter.turnCounter}`;
    this.sentCommands.push({ threadId: input.threadId, input: input.input, turnId });
    return { threadId: input.threadId, turnId };
  }
}

describe("AgentService context compaction", () => {
  let svc: AgentServiceType;
  let fakes: CompactFakeAdapter[];
  let events: import("./types.js").RuntimeEvent[];
  let threadCounter = 0;

  const fakeFor = (provider: string): CompactFakeAdapter => {
    const fake = fakes.find((f) => f.provider === provider);
    if (!fake) throw new Error(`no ${provider} fake`);
    return fake;
  };

  const compactedEvent = (
    threadId: string,
    provider: "codex" | "claudeAgent" | "cursor" | "droid",
  ): import("./types.js").RuntimeEvent => ({
    threadId,
    provider,
    at: Date.now(),
    source: "kone.store",
    type: "thread.state.changed",
    state: "compacted",
  });

  beforeAll(() => {
    fakes = [];
    events = [];
    svc = new AgentServiceCtor({
      compactNativeTimeoutMs: 500,
      compactFallbackTimeoutMs: 500,
      // SAFETY: fakeStore implements the queued-turn slice this service reads.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: fakeStore as unknown as QueuedTurnStore,
      adapters: (emit) =>
        // SAFETY: four compaction fakes are the whole provider roster here.
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        [
          new CompactFakeAdapter(emit, "codex", true),
          new CompactFakeAdapter(emit, "claudeAgent", false),
          new CompactFakeAdapter(emit, "cursor", false),
          new CompactFakeAdapter(emit, "droid", false),
        ].map((fake) => {
          fakes.push(fake);
          return fake;
        }) as unknown as ProviderAdapter[],
    });
    svc.onEvent((e) => events.push(e));
  });

  beforeEach(() => {
    for (const fake of fakes) {
      fake.compactCalls.length = 0;
      fake.sentCommands.length = 0;
      fake.failCompact = false;
      fake.parkCompact = false;
      fake.releaseCompact = null;
    }
    events.length = 0;
    fakeStore.reset();
  });

  afterAll(async () => {
    await svc.stopAll();
  });

  async function startThread(provider: "codex" | "claudeAgent" | "cursor" | "droid"): Promise<string> {
    threadCounter += 1;
    const threadId = `compact-t-${threadCounter}`;
    await svc.startSession({ threadId, provider, cwd: "/tmp", mode: "ask" });
    return threadId;
  }

  function compactedCount(threadId: string): number {
    return events.filter(
      (e) => e.threadId === threadId && e.type === "thread.state.changed" && e.state === "compacted",
    ).length;
  }

  /** Flush microtasks so the service's one-shot watchers subscribe before the
   *  test drives the event stream (real adapters always settle after their
   *  sendTurn ack resolves; the fake would otherwise emit into nobody). */
  async function tick(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }

  /** Poll until `done` reads true — the queue drain runs fire-and-forget, so
   *  promotion lands a few ticks after the trigger, never synchronously. */
  async function waitFor(done: () => boolean, ms = 2000): Promise<void> {
    const start = Date.now();
    while (!done()) {
      if (Date.now() - start > ms) throw new Error("timed out waiting for promotion");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  test("rejects with no live session", async () => {
    await expect(svc.compactThread("compact-missing")).rejects.toThrow("No agent session");
  });

  test("rejects when the provider supports no manual compaction", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    const saved = fake.capabilities.compaction;
    fake.capabilities.compaction = { kind: "unsupported" };
    try {
      await expect(svc.compactThread(threadId)).rejects.toThrow("not supported");
    } finally {
      fake.capabilities.compaction = saved;
    }
  });

  test("rejects while a turn is running", async () => {
    const threadId = await startThread("codex");
    fakeFor("codex").emit({
      threadId,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.started",
      turnId: "turn-live",
    });
    await expect(svc.compactThread(threadId)).rejects.toThrow(
      "unavailable while a provider turn is running",
    );
    fakeFor("codex").emit({
      threadId,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.completed",
      turnId: "turn-live",
    });
  });

  test("native success resolves once the announced boundary lands", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    const pending = svc.compactThread(threadId);
    // The provider announces the boundary while the native call is in flight.
    fake.emit(compactedEvent(threadId, "codex"));
    const result = await pending;
    expect(result).toEqual({ threadId, provider: "codex", native: true });
    expect(fake.compactCalls).toEqual([threadId]);
    // Observed, not synthesized: exactly the one announced boundary.
    expect(compactedCount(threadId)).toBe(1);
  });

  test("native timeout synthesizes the boundary and rejects", async () => {
    const threadId = await startThread("codex");
    await expect(svc.compactThread(threadId)).rejects.toThrow("did not complete within 10 minutes");
    // The quiet provider gets one synthesized boundary, then the claim releases.
    expect(compactedCount(threadId)).toBe(1);
    expect(svc.isCompacting(threadId)).toBe(false);
  });

  test("native waits for the real boundary and holds the claim until it lands", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    const pending = svc.compactThread(threadId);
    // The native call resolves on acceptance — let it settle into the boundary
    // wait with no announcement yet.
    await tick();
    await tick();
    expect(svc.isCompacting(threadId)).toBe(true);
    expect(compactedCount(threadId)).toBe(0);
    // A send arriving mid-compaction queues behind it instead of dispatching.
    const userBlockId = fakeStore.journalUserBlock(threadId, "hello after");
    const ack = await svc.sendTurn({ threadId, input: "hello after" });
    const queued = fakeStore.rows.find((r) => r.threadId === threadId);
    expect(queued).toMatchObject({ input: "hello after", userBlockId });
    expect(ack.turnId).toBe(queued?.queueId);
    expect(fake.sentCommands).toHaveLength(0);
    // Still settling with no announcement: nothing synthesized, nothing released.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(svc.isCompacting(threadId)).toBe(true);
    expect(compactedCount(threadId)).toBe(0);
    expect(fake.sentCommands).toHaveLength(0);
    expect(fakeStore.rows.filter((r) => r.threadId === threadId)).toHaveLength(1);

    fake.emit(compactedEvent(threadId, "codex"));
    await expect(pending).resolves.toMatchObject({ threadId, native: true });
    // Exactly the announced boundary — no synthesis alongside it.
    expect(compactedCount(threadId)).toBe(1);
    await waitFor(() => fake.sentCommands.some((s) => s.input === "hello after"));
    await waitFor(() => fakeStore.rows.filter((r) => r.threadId === threadId).length === 0);
    expect(svc.isCompacting(threadId)).toBe(false);
  });

  test("late real boundary after call resolution journals exactly one compaction", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    const pending = svc.compactThread(threadId);
    // Let the native call resolve with no boundary yet — resolution alone must
    // journal nothing.
    await tick();
    await tick();
    expect(compactedCount(threadId)).toBe(0);
    // The real announcement lands late, after the call settled.
    fake.emit(compactedEvent(threadId, "codex"));
    await expect(pending).resolves.toMatchObject({ threadId, native: true });
    expect(compactedCount(threadId)).toBe(1);
    expect(svc.isCompacting(threadId)).toBe(false);
  });

  test("a boundary that lands despite a failed call still wins", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    fake.failCompact = true;
    const pending = svc.compactThread(threadId);
    fake.emit(compactedEvent(threadId, "codex"));
    await expect(pending).resolves.toMatchObject({ threadId, native: true });
  });

  test("a failed call with no boundary surfaces the failure", async () => {
    const threadId = await startThread("codex");
    fakeFor("codex").failCompact = true;
    await expect(svc.compactThread(threadId)).rejects.toThrow("compact failed");
    expect(compactedCount(threadId)).toBe(0);
  });

  test("a second compaction while one runs is rejected (single flight)", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    fake.parkCompact = true;
    const first = svc.compactThread(threadId);
    await expect(svc.compactThread(threadId)).rejects.toThrow("already in progress");
    fake.releaseCompact?.();
    fake.emit(compactedEvent(threadId, "codex"));
    await expect(first).resolves.toMatchObject({ native: true });
    expect(svc.isCompacting(threadId)).toBe(false);
  });

  test("sends during compaction queue and run against the compacted context", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    fake.parkCompact = true;
    const pending = svc.compactThread(threadId);
    // The dispatcher journals the prompt before sending; the test stands in
    // for it so the queue row anchors to a real user block.
    const userBlockId = fakeStore.journalUserBlock(threadId, "hello after");
    const ack = await svc.sendTurn({ threadId, input: "hello after" });
    // Queued, not refused: the ack carries the queue id like a busy send.
    const queued = fakeStore.rows.find((r) => r.threadId === threadId);
    expect(queued).toMatchObject({ input: "hello after", userBlockId });
    expect(ack.turnId).toBe(queued?.queueId);
    expect(fake.sentCommands).toHaveLength(0);

    fake.releaseCompact?.();
    fake.emit(compactedEvent(threadId, "codex"));
    await pending;
    // The boundary promotes the row, which dispatches as the next turn. Both
    // halves are async fire-and-forget, so wait for dispatch AND drain
    // completion — the send lands a few ticks before its row is reaped.
    await waitFor(() => fake.sentCommands.some((s) => s.input === "hello after"));
    await waitFor(() => fakeStore.rows.filter((r) => r.threadId === threadId).length === 0);
    expect(svc.isCompacting(threadId)).toBe(false);
  });

  test("steers still refuse while compacting", async () => {
    const threadId = await startThread("codex");
    const fake = fakeFor("codex");
    fake.parkCompact = true;
    const pending = svc.compactThread(threadId);
    await expect(svc.steerTurn({ threadId, input: "nudge" })).rejects.toThrow(
      "Wait for context compaction",
    );
    fake.releaseCompact?.();
    fake.emit(compactedEvent(threadId, "codex"));
    await pending;
  });

  test("fallback sends /compact and synthesizes the boundary on settle", async () => {
    const threadId = await startThread("claudeAgent");
    const fake = fakeFor("claudeAgent");
    const pending = svc.compactThread(threadId);
    await tick();
    // The command turn was handed straight to the adapter (never queued, never
    // journaled by the service).
    expect(fake.sentCommands).toHaveLength(1);
    expect(fake.sentCommands[0]).toMatchObject({ threadId, input: "/compact" });
    const turnId = fake.sentCommands[0]?.turnId ?? "";
    fake.emit({
      threadId,
      provider: "claudeAgent",
      at: Date.now(),
      source: "kone.store",
      type: "turn.completed",
      turnId,
    });
    await expect(pending).resolves.toMatchObject({ threadId, native: false });
    expect(compactedCount(threadId)).toBe(1);
  });

  test("fallback resolves on the announced boundary without synthesizing", async () => {
    const threadId = await startThread("claudeAgent");
    const fake = fakeFor("claudeAgent");
    const pending = svc.compactThread(threadId);
    await tick();
    const turnId = fake.sentCommands[0]?.turnId ?? "";
    // Claude announces compact_boundary mid-turn; the turn settles after.
    fake.emit(compactedEvent(threadId, "claudeAgent"));
    fake.emit({
      threadId,
      provider: "claudeAgent",
      at: Date.now(),
      source: "kone.store",
      type: "turn.completed",
      turnId,
    });
    await pending;
    expect(compactedCount(threadId)).toBe(1);
  });

  test("fallback sends /compress for cursor", async () => {
    const threadId = await startThread("cursor");
    const fake = fakeFor("cursor");
    const pending = svc.compactThread(threadId);
    await tick();
    expect(fake.sentCommands[0]?.input).toBe("/compress");
    fake.emit(compactedEvent(threadId, "cursor"));
    await pending;
  });

  test("fallback sends /compress for droid", async () => {
    const threadId = await startThread("droid");
    const fake = fakeFor("droid");
    const pending = svc.compactThread(threadId);
    await tick();
    expect(fake.sentCommands[0]?.input).toBe("/compress");
    fake.emit(compactedEvent(threadId, "droid"));
    await expect(pending).resolves.toMatchObject({ threadId, provider: "droid", native: false });
  });

  test("an interrupted fallback turn throws without synthesizing", async () => {
    const threadId = await startThread("claudeAgent");
    const fake = fakeFor("claudeAgent");
    const pending = svc.compactThread(threadId);
    await tick();
    const turnId = fake.sentCommands[0]?.turnId ?? "";
    fake.emit({
      threadId,
      provider: "claudeAgent",
      at: Date.now(),
      source: "kone.store",
      type: "turn.aborted",
      turnId,
      reason: "interrupted",
    });
    await expect(pending).rejects.toThrow("interrupted before it could settle");
    expect(compactedCount(threadId)).toBe(0);
  });

  test("supportsThreadCompaction mirrors the capability", () => {
    expect(svc.supportsThreadCompaction("codex")).toBe(true);
    expect(svc.supportsThreadCompaction("cursor")).toBe(true);
    expect(svc.supportsThreadCompaction("droid")).toBe(true);
  });
});

describe("handoff window resolution", () => {
  const meta = (overrides: Partial<StoredThreadMeta>): StoredThreadMeta => ({
    threadId: "t-window",
    projectPath: "/p",
    provider: "codex",
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  });
  const historyWith = (m: StoredThreadMeta) => {
    // SAFETY: the service only reads threadMeta from this injected slice here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    return { threadMeta: () => m } as unknown as import("./AgentService.js").AgentServiceOptions["historyStore"];
  };

  const serviceFor = (m: StoredThreadMeta) =>
    new AgentServiceCtor({
      // SAFETY: one fake codex adapter is the whole provider roster here.
      adapters: (emit) =>
        // eslint-disable-next-line anti-slop/no-chained-type-assertions
        [new FakeAdapter(emit, "codex") as unknown as ProviderAdapter],
      historyStore: historyWith(m),
    });

  test("uses the stored model's catalog window when the turn omits a model", async () => {
    FakeAdapter.models.codex = [{ id: "gpt-8k", label: "8k", contextWindowTokens: 8_000 }];
    const service = serviceFor(meta({ model: "gpt-8k" }));
    await service.listModels("codex");
    expect(service.handoffWindowTokensFor("t-window")).toBe(8_000);
  });

  test("falls back to the thread's reported window for an uncatalogued model", async () => {
    FakeAdapter.models.codex = [];
    const service = serviceFor(meta({ model: "mystery", contextWindow: 8_000 }));
    await service.listModels("codex");
    expect(service.handoffWindowTokensFor("t-window")).toBe(8_000);
  });

  test("prefers the selected auto-compact window over the model capacity", async () => {
    FakeAdapter.models.codex = [
      {
        id: "big",
        label: "big",
        contextWindowTokens: 1_000_000,
        contextWindows: [{ id: "small", label: "200k", tokens: 200_000 }],
      },
    ];
    const service = serviceFor(meta({ model: "big", selection: { contextWindow: "small" } }));
    await service.listModels("codex");
    expect(service.handoffWindowTokensFor("t-window")).toBe(200_000);
  });

  test("a dropped requested override falls back to the stored model, not the reported window", async () => {
    // The adapter keeps running the stored model when an invalid override is
    // dropped, so the budget must use that model's window — not the thread's
    // reported 128k.
    FakeAdapter.models.codex = [{ id: "small", label: "8k", contextWindowTokens: 8_000 }];
    const service = serviceFor(meta({ model: "small", contextWindow: 128_000 }));
    await service.listModels("codex");
    expect(service.handoffWindowTokensFor("t-window", "foreign-model")).toBe(8_000);
  });
});
