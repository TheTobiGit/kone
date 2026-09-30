import { afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { EmitEvent, ProviderAdapter, RuntimeEvent, SendTurnInput, TurnStartResult } from "./types.js";

// The hand-off lifecycle against a REAL AgentService, ConversationStore and
// ThreadDispatcher, with only the provider faked. The durable turn queue is
// what these lock down: a send to a thread whose interrupted turn has not
// finished aborting is queued and answered with a queue id, and a queued
// follow-up is promoted the moment a turn settles — neither of which a fake
// dispatcher that always answers with a turn id would ever show.
//
// ConversationStore imports node:sqlite; stand it in for bun:sqlite and point
// the state dir at a temp dir, as dispatch.test.ts does.
setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-handoff-queue-test-")));
mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let initThreadDispatcher: typeof import("./dispatch.js").initThreadDispatcher;
let HandOffLifecycleCtor: typeof import("./handOffLifecycle.js").HandOffLifecycle;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  initThreadDispatcher = (await import("./dispatch.js")).initThreadDispatcher;
  HandOffLifecycleCtor = (await import("./handOffLifecycle.js")).HandOffLifecycle;
});

type Options = {
  /** The interrupt settles the running turn before it returns. Off, it only
   *  asks — the way Cline sends a cancel notification and returns, and Codex
   *  and OpenCode settle a moment later — and the test lands the abort. */
  abortOnInterrupt?: boolean;
  /** Every turn the provider takes finishes before its send returns. */
  settleOnSend?: boolean;
};

const harnesses: Array<{ stopAll(): Promise<void> }> = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) await h.stopAll();
});

async function harness(options: Options = {}) {
  const store = new ConversationStoreCtor(mkdtempSync(path.join(tmpdir(), "kone-handoff-queue-db-")));
  let emit: EmitEvent = () => {};
  const sent: Array<{ threadId: string; input: string; turnId: string }> = [];
  const events: RuntimeEvent[] = [];
  const running = new Map<string, string>();
  let count = 0;

  const turnEvent = (type: "turn.started" | "turn.completed" | "turn.aborted", threadId: string, turnId: string) => {
    if (type === "turn.started") running.set(threadId, turnId);
    else if (running.get(threadId) === turnId) running.delete(threadId);
    emit({ type, threadId, turnId, provider: "codex", source: "kone.store", at: Date.now() });
  };

  const adapter = {
    provider: "codex",
    capabilities: { supportsResume: false },
    discover: async () => [],
    listModels: async () => [],
    startSession: async ({ threadId }: { threadId: string }) => ({ threadId, provider: "codex" }),
    sendTurn: async (input: SendTurnInput): Promise<TurnStartResult> => {
      const turnId = `real-${++count}`;
      sent.push({ threadId: input.threadId, input: input.input, turnId });
      turnEvent("turn.started", input.threadId, turnId);
      if (options.settleOnSend) turnEvent("turn.completed", input.threadId, turnId);
      return { threadId: input.threadId, turnId };
    },
    // A live-steer channel, so what kone tells a working delegate lands in its
    // turn rather than interrupting it.
    steerTurn: async (input: SendTurnInput): Promise<TurnStartResult> => ({
      threadId: input.threadId,
      turnId: running.get(input.threadId) ?? "none",
    }),
    interruptTurn: async (threadId: string) => {
      const turnId = running.get(threadId);
      if (options.abortOnInterrupt && turnId) turnEvent("turn.aborted", threadId, turnId);
    },
    stopSession: async () => {},
    stopAll: async () => {},
  };

  const service = new AgentServiceCtor({
    store,
    checkpointStore: null,
    adapters: (fn: EmitEvent) => {
      emit = fn;
      // SAFETY: the fake implements every method these paths reach.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [adapter as unknown as ProviderAdapter];
    },
  });
  harnesses.push(service);

  store.ensureThread({ threadId: "main", projectPath: tmpdir(), provider: "codex" });
  store.writeSpawnedThread({
    threadId: "child",
    projectPath: tmpdir(),
    provider: "codex",
    createdAt: Date.now(),
    title: "Child",
    lineage: { parentThreadId: "main", relationshipToParent: "delegation", rootThreadId: "main" },
  });
  for (const threadId of ["main", "child"]) await service.startSession({ threadId, provider: "codex", cwd: tmpdir() });

  const dispatcher = initThreadDispatcher({ service, store, broadcast: () => {} });
  const lifecycle = new HandOffLifecycleCtor({ store, service, dispatcher });
  service.onEvent((event) => {
    events.push(event);
    lifecycle.onEvent(event);
  });

  /** Put a turn on the thread the way the provider would. */
  const startTurn = (threadId: string, turnId: string) => turnEvent("turn.started", threadId, turnId);
  return { store, service, lifecycle, sent, events, turnEvent, startTurn };
}

/** Let the service's fire-and-forget queue drain run. */
const drain = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a decision turn sent while the stopped turn is still aborting", () => {
  test("is queued, and the agent is deciding until the real decision turn settles", async () => {
    const h = await harness();
    h.startTurn("main", "stopped-turn");
    h.startTurn("child", "child-turn");
    await h.service.interruptTurn("main");

    expect((await h.lifecycle.onUserStopped("main")).decisionTurn).toBe(true);
    const [queued] = h.store.listQueuedTurns("main");
    expect(queued).toBeDefined();
    expect(h.lifecycle.isDeciding("main")).toBe(true);

    // The interrupted turn's abort lands; the queued decision is promoted.
    h.turnEvent("turn.aborted", "main", "stopped-turn");
    await drain();
    expect(h.lifecycle.isDeciding("main")).toBe(true);
    const decision = h.sent.find((s) => s.threadId === "main");
    expect(decision?.input).toContain("agent_keep_or_stop");
    expect(decision?.turnId).not.toBe(queued?.queueId);

    h.turnEvent("turn.completed", "main", decision!.turnId);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });

  test("that finishes before its promotion is announced still ends the decision", async () => {
    const h = await harness({ settleOnSend: true });
    h.startTurn("main", "stopped-turn");
    h.startTurn("child", "child-turn");

    await h.lifecycle.onUserStopped("main");
    expect(h.lifecycle.isDeciding("main")).toBe(true);

    h.turnEvent("turn.aborted", "main", "stopped-turn");
    await drain();
    expect(h.sent.some((s) => s.threadId === "main")).toBe(true);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });

  test("that is cancelled before it runs is no longer awaited", async () => {
    const h = await harness();
    h.startTurn("main", "stopped-turn");
    h.startTurn("child", "child-turn");

    await h.lifecycle.onUserStopped("main");
    expect(h.store.listQueuedTurns("main")).toHaveLength(1);
    await h.service.stopSession("main");

    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });
});

describe("a decision turn sent once the stopped turn has aborted", () => {
  test("runs straight away and ends when it settles", async () => {
    const h = await harness({ abortOnInterrupt: true });
    h.startTurn("main", "stopped-turn");
    h.startTurn("child", "child-turn");
    await h.service.interruptTurn("main");

    await h.lifecycle.onUserStopped("main");
    expect(h.store.listQueuedTurns("main")).toHaveLength(0);
    const decision = h.sent.find((s) => s.threadId === "main");
    expect(h.lifecycle.isDeciding("main")).toBe(true);

    h.turnEvent("turn.completed", "main", decision!.turnId);
    expect(h.lifecycle.isDeciding("main")).toBe(false);
  });
});

describe("stop everything", () => {
  test("drops the thread's queued follow-ups instead of promoting them on the abort", async () => {
    const h = await harness({ abortOnInterrupt: true });
    h.startTurn("main", "running");
    h.startTurn("child", "child-turn");
    await h.service.sendTurn({ threadId: "main", userBlockId: "queued-block", input: "continue doing the work" });
    expect(h.store.listQueuedTurns("main")).toHaveLength(1);

    const stopped = await h.lifecycle.stopEverything("main");
    await drain();

    expect(stopped).toEqual(["child", "main"]);
    expect(h.sent.map((s) => s.input)).not.toContain("continue doing the work");
    expect(h.store.listQueuedTurns("main")).toHaveLength(0);
    expect(h.events).toContainEqual(
      expect.objectContaining({ type: "turn.queued-cancelled", threadId: "main", reason: "stop" }),
    );
    expect(h.service.isThreadBusy("main")).toBe(false);
  });
});
