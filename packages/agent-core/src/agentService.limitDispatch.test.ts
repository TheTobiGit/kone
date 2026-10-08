import { afterAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { ProviderAdapter, RuntimeEvent } from "./types.js";

// Phase 3: a queued follow-up that hits a usage limit is held (not failed) and
// drains once the limit clears, and the dispatcher's limit-reset continuation
// resumes a limited thread but cancels for one that is no longer limited.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const dir = mkdtempSync(path.join(tmpdir(), "kone-limit-dispatch-"));
setUserDataDir(dir);

const { ConversationStore } = await import("./ConversationStore.js");
const { AgentService } = await import("./AgentService.js");
const { initThreadDispatcher } = await import("./dispatch.js");

type Store = InstanceType<typeof ConversationStore>;
type Service = InstanceType<typeof AgentService>;
const store: Store = new ConversationStore();
const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

class Adapter {
  provider = "codex" as const;
  emit: ((event: RuntimeEvent) => void) | null = null;
  sent: string[] = [];
  sendError: Error | null = null;
  async startSession(input: { threadId: string }): Promise<Record<string, string>> {
    return { threadId: input.threadId, provider: "codex", status: "ready" };
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async hasSession(): Promise<boolean> {
    return true;
  }
  async sendTurn(input: { threadId: string; input: string }): Promise<{ threadId: string; turnId: string }> {
    if (this.sendError) {
      const err = this.sendError;
      this.sendError = null;
      throw err;
    }
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
    stopTotalTimeoutMs: 60,
    adapters: (emit) => {
      adapter.emit = emit;
      // SAFETY: one fake adapter is the whole roster here.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [adapter as unknown as ProviderAdapter];
    },
  });
}

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("P3 usage-limit dispatch", () => {
  test("a queued follow-up that hits a limit is held, then drains after recovery", async () => {
    const id = "queue-hold";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const emit = adapter.emit;
    if (!emit) throw new Error("adapter emit not captured");
    // A live turn makes the next send queue.
    emit({ type: "turn.started", threadId: id, provider: "codex", at: Date.now(), source: "kone.store", turnId: "live-1" });
    await svc.sendTurn({ threadId: id, input: "queued follow-up" });
    expect(store.listQueuedTurns(id)).toHaveLength(1);
    // The drain now tries the row and hits the limit.
    adapter.sendError = new Error("429 usage limit reached");
    emit({ type: "turn.completed", threadId: id, provider: "codex", at: Date.now(), source: "kone.store", turnId: "live-1" });
    await pause(60);
    const [held] = store.listQueuedTurns(id);
    expect(held?.state).toBe("queued");
    expect(store.threadMeta(id)?.limitedAt ?? null).not.toBeNull();
    // Recovery clears the limit and the next drain sends the held row.
    svc.clearThreadLimited(id);
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    await pause(60);
    expect(adapter.sent).toContain("queued follow-up");
    await svc.stopAll();
  });

  test("a limit-reset continuation resumes a limited thread but cancels for one no longer limited", async () => {
    const limited = "limit-resume";
    store.ensureThread({ threadId: limited, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    // Mark limited (schedules its own future row), then replace with a due-now
    // limit-reset row for the sweep.
    svc.setThreadLimited(limited, Date.now() + 60_000);
    store.cancelContinuationsForThread(limited);
    store.scheduleContinuation({
      threadId: limited,
      kind: "limit-reset",
      dueAt: 0,
      payloadJson: JSON.stringify({ resetAt: 0 }),
    });
    await dispatcher.dispatchDueContinuations();
    expect(adapter.sent.some((text) => text.includes("usage limit has reset"))).toBe(true);

    // A thread no longer limited: the same row is cancelled, not dispatched.
    const cleared = "limit-cleared";
    store.ensureThread({ threadId: cleared, provider: "codex", projectPath: "/tmp" });
    store.scheduleContinuation({ threadId: cleared, kind: "limit-reset", dueAt: 0 });
    adapter.sent.length = 0;
    await dispatcher.dispatchDueContinuations();
    expect(adapter.sent).toEqual([]);
    expect(store.listContinuationsForThread(cleared)).toEqual([]);
    await svc.stopAll();
  });
});
