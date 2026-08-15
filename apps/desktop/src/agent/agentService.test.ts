import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import type {
  ProviderAdapter,
  QueuedTurnRow,
  QueuedTurnStore,
  SendTurnInput,
  TurnStartResult,
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
mock.module("node:sqlite", () => ({
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
  }
  async stopAll(): Promise<void> {}
  async discover(): Promise<unknown> {
    return [];
  }
  async listModels(): Promise<unknown[]> {
    return [];
  }
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
  async interruptTurn(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<void> {}
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
 *  loadThread emulates the transcript read the service uses to derive a row's
 *  userBlockId: seeded blocks, plus a synthetic block appended per accepted
 *  enqueue (the real dispatch.recordUserBlock journals a fresh block per
 *  send, so consecutive sends derive distinct ids). */
class FakeQueueStore {
  rows: QueuedTurnRow[] = [];
  private blocksByThread = new Map<string, Array<{ id: string; role: "user"; text: string; at: number }>>();
  private journaled = 0;

  seedUserBlocks(threadId: string, ids: string[]): void {
    this.blocksByThread.set(
      threadId,
      ids.map((id) => ({ id, role: "user" as const, text: id, at: Date.now() })),
    );
  }

  reset(): void {
    this.rows.length = 0;
    this.blocksByThread.clear();
    this.journaled = 0;
  }

  loadThread(threadId: string): unknown {
    const blocks = this.blocksByThread.get(threadId);
    if (!blocks) return null;
    return { threadId, blocks: [...blocks] };
  }

  async enqueueQueuedTurn(row: QueuedTurnRow): Promise<boolean> {
    if (this.rows.some((r) => r.threadId === row.threadId && r.userBlockId === row.userBlockId)) {
      return false;
    }
    this.rows.push({ ...row });
    const blocks = this.blocksByThread.get(row.threadId);
    if (blocks) {
      blocks.push({ id: `journaled-${++this.journaled}`, role: "user", text: row.input, at: row.createdAt });
    }
    return true;
  }

  async claimNextQueuedTurn(threadId: string): Promise<QueuedTurnRow | null> {
    const candidates = this.rows
      .filter((r) => r.threadId === threadId && r.state === "queued")
      .sort((a, b) => {
        if (a.dispatchMode !== b.dispatchMode) return a.dispatchMode === "steer" ? -1 : 1;
        return a.createdAt - b.createdAt;
      });
    const row = candidates[0];
    if (!row) return null;
    row.state = "promoting";
    row.attemptCount += 1;
    row.updatedAt = Date.now();
    return { ...row };
  }

  async markQueuedTurnPromoted(queueId: string): Promise<boolean> {
    const idx = this.rows.findIndex((r) => r.queueId === queueId && r.state === "promoting");
    if (idx < 0) return false;
    this.rows.splice(idx, 1);
    return true;
  }

  async releaseQueuedTurn(queueId: string): Promise<void> {
    const row = this.rows.find((r) => r.queueId === queueId);
    if (row) {
      row.state = "queued";
      row.updatedAt = Date.now();
    }
  }

  async cancelQueuedTurn(queueId: string): Promise<boolean> {
    const idx = this.rows.findIndex((r) => r.queueId === queueId);
    if (idx < 0) return false;
    this.rows.splice(idx, 1);
    return true;
  }

  async cancelQueuedTurnsForThread(threadId: string): Promise<string[]> {
    const ids = this.rows.filter((r) => r.threadId === threadId).map((r) => r.queueId);
    this.rows = this.rows.filter((r) => r.threadId !== threadId);
    return ids;
  }

  async listQueuedTurns(threadId: string): Promise<QueuedTurnRow[]> {
    return this.rows.filter((r) => r.threadId === threadId).map((r) => ({ ...r }));
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
  fakeStore.reset();
  service = new AgentServiceCtor({
    wedgeSweepMs: 40,
    wedgeSilenceMs: 30,
    idleSweepMs: 40,
    idleThresholdMs: 50,
    // The fake implements the queue slice the service needs (its loadThread
    // only backs latestUserBlockId's user-block walk, so it is not a full
    // StoredThread) — cast at the boundary, the same contract the module mock
    // used to stand in for.
    store: fakeStore as unknown as QueuedTurnStore,
    // The fakes are constructed inside the service with its real emit closure,
    // exactly like the real adapters — FakeAdapter.emits records them so the
    // tests below can drive the merged event stream.
    adapters: (emit) =>
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
    const reset = received.find(
      (e) => e.threadId === thread && e.type === "session.state.changed" && e.state === "error",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "session.state.changed" }> | undefined;
    expect(reset?.message).toBe("wedged — session reset");
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
});

describe("AgentService idle session reaper", () => {
  test("stops an inactive session whose inactivity exceeds the idle threshold", async () => {
    const thread = "t-idle-1";
    await service.startSession({ threadId: thread, provider: "codex", cwd: "/tmp", mode: "ask" });
    // Inactivity > idleThresholdMs (50ms) with sweep at 40ms — reaper must stop the session.
    await new Promise((r) => setTimeout(r, 150));
    expect(FakeAdapter.stopped).toContain(thread);
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
      mode: "auto",
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
      mode: "auto",
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
      attemptCount: 0,
    });
    // The ack's turnId is the queue id — the renderer correlates with the
    // eventual turn.promoted by it.
    expect(result.turnId).toBe(row.queueId);

    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    expect(queued).toMatchObject({
      queueId: row.queueId,
      userBlockId: "block-followup",
      dispatchMode: "queue",
      position: 2, // the live turn is slot 1, this entry slot 2
    });
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
    const promoted = received.find(
      (e) => e.threadId === thread && e.type === "turn.promoted",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.promoted" }> | undefined;
    expect(promoted).toMatchObject({ queueId, turnId: sent?.turnId });
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
    await service.sendTurn({ threadId: thread, input: "doomed" });
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
    codexFake.steerTurn = async (input: SendTurnInput) => {
      steered = input;
      return { threadId: input.threadId, turnId: "steer-ack" };
    };

    const result = await service.steerTurn({ threadId: thread, input: "nudge the plan" });

    expect(result.turnId).toBe("steer-ack");
    expect(steered?.input).toBe("nudge the plan");
    expect(fakeStore.rows).toHaveLength(0); // nothing enqueued
    const steeredEvent = received.find(
      (e) => e.threadId === thread && e.type === "turn.steered",
    );
    expect(steeredEvent).toMatchObject({ turnId: "live-9", message: "nudge the plan" });
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
    const queued = received.find(
      (e) => e.threadId === thread && e.type === "turn.queued",
    ) as Extract<import("./types.js").RuntimeEvent, { type: "turn.queued" }> | undefined;
    expect(queued?.dispatchMode).toBe("steer");
  });
});
