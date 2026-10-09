import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { ProviderAdapter, RuntimeEvent } from "./types.js";
import type { CheckpointStore } from "./conversationStoreTypes.js";

// Second round of Phase 2 review regressions: continuation admission at the
// handoff, cancellation during adoption (stop and interrupt), one delivery of
// the restart note, and the empty-list note.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const previewEntered = gate();
const previewRelease = gate();
let restored = false;
let previewCalls = 0;
mock.module("@kone/git-core/checkpoint.js", () => ({
  checkpointExists: async () => true,
  createCheckpoint: async () => ({ id: "cp", createdAt: 1 }),
  dropCheckpoint: async () => {},
  previewCheckpointRestore: async () => {
    previewCalls++;
    if (previewCalls === 1) {
      previewEntered.open();
      await previewRelease.promise;
    }
    return { wouldWrite: [], wouldDelete: [] };
  },
  restoreCheckpoint: async () => {
    restored = true;
  },
}));

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

const dir = mkdtempSync(path.join(tmpdir(), "kone-p2-review2-"));
setUserDataDir(dir);

const { ConversationStore } = await import("./ConversationStore.js");
const { AgentService } = await import("./AgentService.js");
const { initThreadDispatcher, ContinuationCancelled } = await import("./dispatch.js");

type Store = InstanceType<typeof ConversationStore>;
type Service = InstanceType<typeof AgentService>;
const store: Store = new ConversationStore();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Adapter {
  provider = "codex" as const;
  sent: string[] = [];
  interrupted: string[] = [];
  startGate: ReturnType<typeof gate> | null = null;
  sendGate: ReturnType<typeof gate> | null = null;
  startEntered: (() => void) | null = null;
  async startSession(input: { threadId: string }): Promise<Record<string, string>> {
    this.startEntered?.();
    if (this.startGate) await this.startGate.promise;
    return { threadId: input.threadId, provider: "codex", status: "ready" };
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async hasSession(): Promise<boolean> {
    return true;
  }
  async interruptTurn(threadId: string): Promise<void> {
    this.interrupted.push(threadId);
  }
  async sendTurn(input: { threadId: string; input: string }): Promise<{ threadId: string; turnId: string }> {
    if (this.sendGate) await this.sendGate.promise;
    this.sent.push(input.input);
    return { threadId: input.threadId, turnId: `t-${this.sent.length}` };
  }
}

function build(adapter: Adapter): Service {
  return new AgentService({
    // SAFETY: the real store satisfies the queue/history/continuation slices.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as ConstructorParameters<typeof AgentService>[0]["store"],
    historyStore: store,
    continuationStore: store,
    checkpointStore: null,
    retentionSweepMs: 0,
    stopTotalTimeoutMs: 200,
    adapters: () => {
      // SAFETY: one fake adapter is the whole roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [adapter as unknown as ProviderAdapter];
    },
  });
}

function dispatcherFor(svc: Service) {
  return initThreadDispatcher({ service: svc, store, broadcast: (_event: RuntimeEvent) => {} });
}

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("P2 review round 2", () => {
  test("a continuation whose row is gone is dropped at the handoff", async () => {
    const id = "handoff-guard";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    await expect(
      dispatcher.sendThreadTurn(
        { threadId: id, input: "continue" },
        { silent: true, continuationId: "does-not-exist" },
      ),
    ).rejects.toBeInstanceOf(ContinuationCancelled);
    expect(adapter.sent).toEqual([]);
    await svc.stopAll();
  });

  test("a stop during adoption consumes the continuation without retry", async () => {
    const id = "stop-adoption";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    adapter.startGate = gate();
    const entered = new Promise<void>((resolve) => {
      adapter.startEntered = resolve;
    });
    const svc = build(adapter);
    const dispatcher = dispatcherFor(svc);
    store.scheduleContinuation({
      threadId: id,
      kind: "quit-resume",
      dueAt: 0,
      payloadJson: JSON.stringify({ prompt: "continue", recordedAt: Date.now() }),
    });
    const sweep = dispatcher.dispatchDueContinuations();
    await entered;
    const stop = svc.stopThread(id);
    adapter.startGate.open();
    await stop;
    await sweep;
    expect(adapter.sent).toEqual([]);
    // Consumed, not retried: no row and no attempt was recorded.
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("an interrupt during adoption yields an interrupted turn, not a retry", async () => {
    const id = "interrupt-adoption";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    adapter.startGate = gate();
    const entered = new Promise<void>((resolve) => {
      adapter.startEntered = resolve;
    });
    const svc = build(adapter);
    const dispatcher = dispatcherFor(svc);
    store.scheduleContinuation({
      threadId: id,
      kind: "quit-resume",
      dueAt: 0,
      payloadJson: JSON.stringify({ prompt: "continue", recordedAt: Date.now() }),
    });
    const sweep = dispatcher.dispatchDueContinuations();
    await entered;
    await svc.interruptTurn(id);
    adapter.startGate.open();
    await sweep;
    await pause(10);
    // The continuation turn was sent and then interrupted; the row is consumed.
    expect(adapter.sent).toContain("continue");
    expect(adapter.interrupted).toContain(id);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("back-to-back sends carry the restart note only once", async () => {
    const id = "note-once";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    dispatcher.stageRestartBackgroundNote(id, [
      { kind: "subagent", id: "child", label: "unfinished research" },
    ]);
    adapter.sendGate = gate();
    const first = dispatcher.sendThreadTurn({ threadId: id, input: "first" });
    await pause(5);
    // The first send holds the provider; the second queues and must not compose
    // a second copy of the note.
    await dispatcher.sendThreadTurn({ threadId: id, input: "second" });
    const queued = store.listQueuedTurns(id);
    expect(queued[0]?.input).not.toContain("kone restarted");
    adapter.sendGate.open();
    await first;
    expect(adapter.sent.filter((text) => text.includes("kone restarted"))).toHaveLength(1);
    await svc.stopAll();
  });

  test("an empty restart note still delivers the shells-and-monitors line", async () => {
    const id = "empty-note";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    dispatcher.stageRestartBackgroundNote(id, []);
    await dispatcher.sendThreadTurn({ threadId: id, input: "carry on" });
    expect(adapter.sent[0]).toContain("Background shells and monitors cannot be listed");
    await svc.stopAll();
  });

  test("refused non-carrier must not release another send's reservation", async () => {
    const id = "non-owner-release";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    dispatcher.stageRestartBackgroundNote(id, [{ kind: "subagent", id: "child", label: "research" }]);
    adapter.sendGate = gate();
    const first = dispatcher.sendThreadTurn({ threadId: id, input: "first" });
    await expect(
      dispatcher.steerThreadTurn({ threadId: id, input: "refused steer" }, { liveOnly: true }),
    ).rejects.toThrow();
    await dispatcher.sendThreadTurn({ threadId: id, input: "third" });
    const queued = store.listQueuedTurns(id);
    adapter.sendGate.open();
    await first;
    await svc.stopAll();
    expect(queued[0]?.input).not.toContain("kone restarted");
  });

  test("cancelled queued carrier must release restart note", async () => {
    const id = "cancel-carrier";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    adapter.sendGate = gate();
    const first = svc.sendTurn({ threadId: id, input: "already sending" });
    dispatcher.stageRestartBackgroundNote(id, [{ kind: "subagent", id: "child", label: "lost research" }]);
    const carrier = await dispatcher.sendThreadTurn({ threadId: id, input: "queued carrier" });
    expect(carrier.queued).toBe(true);
    await svc.cancelQueuedTurn(id, carrier.turnId);
    adapter.sendGate.open();
    await first;
    await dispatcher.sendThreadTurn({ threadId: id, input: "retry after cancellation" });
    expect(adapter.sent.at(-1)).toContain("lost research");
    await svc.stopAll();
  });
});
