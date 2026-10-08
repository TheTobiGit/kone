import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { CheckpointStore } from "./conversationStoreTypes.js";
import type { ProviderAdapter, QueuedTurnStore, RuntimeEvent } from "./types.js";

// Regression tests for the Phase 2 review: each asserts the CORRECT behaviour
// for a defect Rowan reproduced. Real store, real service, real dispatcher;
// only the provider adapter is faked.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const dir = mkdtempSync(path.join(tmpdir(), "kone-p2-review-"));
setUserDataDir(dir);

const { ConversationStore } = await import("./ConversationStore.js");
const { AgentService } = await import("./AgentService.js");
const { initThreadDispatcher } = await import("./dispatch.js");

type Store = InstanceType<typeof ConversationStore>;
type Service = InstanceType<typeof AgentService>;
type Dispatcher = import("./dispatch.js").ThreadDispatcher;
const store: Store = new ConversationStore();

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

class Adapter {
  provider = "codex" as const;
  sent: string[] = [];
  startGate: ReturnType<typeof gate> | null = null;
  stopError: Error | null = null;
  sendError: Error | null = null;
  startEntered: (() => void) | null = null;
  async startSession(input: { threadId: string }): Promise<Record<string, string>> {
    this.startEntered?.();
    if (this.startGate) await this.startGate.promise;
    return { threadId: input.threadId, provider: "codex", status: "ready" };
  }
  async stopSession(): Promise<void> {
    if (this.stopError) throw this.stopError;
  }
  async stopAll(): Promise<void> {}
  async hasSession(): Promise<boolean> {
    return true;
  }
  async sendTurn(input: {
    threadId: string;
    input: string;
  }): Promise<{ threadId: string; turnId: string }> {
    if (this.sendError) {
      const err = this.sendError;
      this.sendError = null;
      throw err;
    }
    this.sent.push(input.input);
    return { threadId: input.threadId, turnId: `t-${this.sent.length}` };
  }
}

function service(adapter: Adapter): Service {
  return new AgentService({
    // SAFETY: the real store satisfies the queue slice the service reads.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    historyStore: store,
    checkpointStore: null,
    retentionSweepMs: 0,
    stopTotalTimeoutMs: 60,
    // SAFETY: one fake adapter is the whole provider roster here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: () => [adapter as unknown as ProviderAdapter],
  });
}

function dispatcherFor(svc: Service): Dispatcher {
  return initThreadDispatcher({ service: svc, store, broadcast: (_event: RuntimeEvent) => {} });
}

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("P2 review regressions", () => {
  test("a settle during session adoption stops the claimed continuation", async () => {
    const id = "settle-race";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    adapter.startGate = gate();
    const entered = new Promise<void>((resolve) => {
      adapter.startEntered = resolve;
    });
    const svc = service(adapter);
    const dispatcher = dispatcherFor(svc);
    store.scheduleContinuation({
      threadId: id,
      kind: "quit-resume",
      dueAt: 0,
      payloadJson: JSON.stringify({ prompt: "continue", recordedAt: Date.now() }),
    });
    const sweep = dispatcher.dispatchDueContinuations();
    await entered;
    // The user settles the thread while the session is still adopting.
    svc.setThreadDone(id, true);
    adapter.startGate.open();
    await sweep;
    expect(adapter.sent).not.toContain("continue");
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("a refused send keeps the restart note for the retry", async () => {
    const id = "note-race";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = service(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const dispatcher = dispatcherFor(svc);
    dispatcher.stageRestartBackgroundNote(id, [
      { kind: "subagent", id: "child", label: "unfinished research" },
    ]);
    adapter.sendError = new Error("transport unavailable");
    await expect(dispatcher.sendThreadTurn({ threadId: id, input: "next" })).rejects.toThrow();
    await dispatcher.sendThreadTurn({ threadId: id, input: "retry" });
    expect(adapter.sent[0]).toContain("kone restarted");
    expect(adapter.sent[0]).toContain("unfinished research");
    await svc.stopAll();
  });

  test("a failed dispatch backs off instead of spinning", async () => {
    const id = "retry-loop";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = service(adapter);
    const dispatcher = dispatcherFor(svc);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    adapter.sendError = new Error("offline");
    store.scheduleContinuation({ threadId: id, kind: "quit-resume", dueAt: 0 });
    await dispatcher.dispatchDueContinuations();
    const [row] = store.listContinuationsForThread(id);
    expect(row?.attempts).toBe(1);
    // The row is pushed into the future, so an immediate second sweep does not
    // retry it at all.
    expect(row?.dueAt ?? 0).toBeGreaterThan(Date.now());
    await dispatcher.dispatchDueContinuations();
    expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(1);
    await svc.stopAll();
  });

  test("the service settle cancels a future continuation, and un-settling does not revive it", async () => {
    const id = "service-settle";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = service(adapter);
    store.scheduleContinuation({ threadId: id, kind: "quit-resume", dueAt: Date.now() + 60_000 });
    svc.setThreadDone(id, true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    svc.setThreadDone(id, false);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("archiving a thread cancels its future continuation", async () => {
    const id = "service-archive";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = service(adapter);
    store.scheduleContinuation({ threadId: id, kind: "quit-resume", dueAt: Date.now() + 60_000 });
    const result = await svc.setThreadArchived(id, true);
    expect(result.ok).toBe(true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("a live session with no stored row still blocks a restore", async () => {
    const adapter = new Adapter();
    const svc = service(adapter);
    await svc.startSession({ threadId: "unregistered", provider: "codex", cwd: "/tmp" });
    const checkpoints: CheckpointStore = {
      threadProjectPath: () => "/tmp",
      threadWorkspace: () => ({ envMode: "worktree", worktreePath: "/tmp", requestedBranch: null }),
      allThreadWorkspaces: () => [],
      turnUserBlockId: () => null,
      recordTurnCheckpoint: () => false,
      getTurnCheckpoint: () => null,
      listTurnCheckpoints: () => [],
      pruneTurnCheckpoints: () => [],
    };
    const refusal = svc.checkpointRestoreRefusal(checkpoints, "owner", "t", "/tmp");
    expect(refusal?.reason).toBe("shared-checkout");
    await svc.stopAll();
  });
});
