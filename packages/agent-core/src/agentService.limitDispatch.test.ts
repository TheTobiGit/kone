import { afterAll, describe, expect, mock, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { claimRestoreDir } from "./checkpointRestoreSafety.js";
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
  // SAFETY: this test fake always represents the Codex adapter.
  provider = "codex" as const;
  capabilities: ProviderAdapter["capabilities"] = {
    sessionModelSwitch: "unsupported",
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: true,
    supportsModelList: false,
    supportsSubagents: false,
  };
  emit: ((event: RuntimeEvent) => void) | null = null;
  sent: string[] = [];
  sendError: Error | null = null;
  startError: Error | null = null;
  startGate: Promise<void> | null = null;
  startEntered: (() => void) | null = null;
  async discover(): Promise<Awaited<ReturnType<ProviderAdapter["discover"]>>> {
    return { provider: "codex", label: "Codex", available: false, authStatus: "unknown", readiness: "not-installed" };
  }
  async listModels(): Promise<Awaited<ReturnType<ProviderAdapter["listModels"]>>> {
    return [];
  }
  async startSession(input: Parameters<ProviderAdapter["startSession"]>[0]): Promise<Awaited<ReturnType<ProviderAdapter["startSession"]>>> {
    if (this.startError) throw this.startError;
    this.startEntered?.();
    if (this.startGate) await this.startGate;
    if (this.startError) throw this.startError;
    return { threadId: input.threadId, provider: input.provider, cwd: input.cwd, status: "ready" };
  }
  async interruptTurn(): Promise<void> {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async respondToRequest(): Promise<void> {}
  async respondToUserInput(): Promise<Awaited<ReturnType<ProviderAdapter["respondToUserInput"]>>> {
    return { owned: false };
  }
  async listSessions(): Promise<Awaited<ReturnType<ProviderAdapter["listSessions"]>>> {
    return [];
  }
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
    store,
    historyStore: store,
    continuationStore: store,
    checkpointStore: null,
    retentionSweepMs: 0,
    stopTotalTimeoutMs: 60,
    adapters: (emit) => {
      adapter.emit = emit;
      return [adapter];
    },
  });
}

afterAll(() => {
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

describe("P3 usage-limit dispatch", () => {
  test("arms a reset timer when a limit is scheduled after an empty sweep", async () => {
    const id = "limit-timer-after-boot";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    await dispatcher.dispatchDueContinuations();
    svc.setThreadLimited(id, Date.now() + 50);
    await pause(180);
    expect(adapter.sent.some((text) => text.includes("usage limit has reset"))).toBe(true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

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

  test("a reset due during restore stays scheduled and sends after restore releases", async () => {
    const id = "limit-reset-restore";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 60_000);
    store.cancelContinuationsForThread(id);
    store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: 0 });
    const release = claimRestoreDir("/tmp");
    try {
      await dispatcher.dispatchDueContinuations();
      expect(adapter.sent).toEqual([]);
      expect(store.listContinuationsForThread(id)).toHaveLength(1);
    } finally {
      release();
    }
    await pause(400);
    expect(adapter.sent.some((text) => text.includes("usage limit has reset"))).toBe(true);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    expect(store.threadMeta(id)?.limitedAt ?? null).toBeNull();
    await svc.stopAll();
  });

  test("restore deferral bounds continuation sweeps until its retry time", async () => {
    const id = "limit-reset-restore-backoff";
    const other = "limit-reset-restore-backoff-other";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    store.ensureThread({ threadId: other, provider: "codex", projectPath: "/Users/gideonsarfo" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 15);
    svc.setThreadLimited(other, Date.now() + 60);
    const release = claimRestoreDir("/tmp");
    let claims = 0;
    const claim = store.claimDueContinuations.bind(store);
    store.claimDueContinuations = (now, excluded = []) => {
      claims += 1;
      return claim(now, excluded);
    };
    try {
      await dispatcher.dispatchDueContinuations();
      await pause(120);
      expect(claims).toBeLessThanOrEqual(3);
      expect(adapter.sent.filter((text) => text.includes("usage limit has reset"))).toHaveLength(1);
      expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(0);
    } finally {
      release();
      store.claimDueContinuations = claim;
    }
    await pause(450);
    expect(adapter.sent.filter((text) => text.includes("usage limit has reset"))).toHaveLength(2);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("session-less quit resume stays unclaimed through five restore sweeps", async () => {
    const id = "quit-resume-restore-adoption";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    const recordedAt = Date.now() - 1_000;
    store.scheduleContinuation({
      threadId: id,
      kind: "quit-resume",
      dueAt: recordedAt,
      payloadJson: JSON.stringify({ prompt: "continue after restart", recordedAt }),
    });
    const release = claimRestoreDir("/tmp");
    try {
      for (let sweep = 0; sweep < 5; sweep += 1) {
        await dispatcher.dispatchDueContinuations();
        await pause(270);
      }
      expect(adapter.sent).toEqual([]);
      expect(store.listContinuationsForThread(id)).toHaveLength(1);
      expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(0);
    } finally {
      release();
    }
    await pause(400);
    expect(adapter.sent).toEqual(["continue after restart"]);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("restore refusal during quit-resume adoption does not burn an attempt", async () => {
    const id = "quit-resume-restore-adoption-race";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    let releaseStart = (): void => {};
    let notifyStarted = (): void => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    adapter.startEntered = notifyStarted;
    adapter.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    const recordedAt = Date.now() - 1_000;
    store.scheduleContinuation({
      threadId: id,
      kind: "quit-resume",
      dueAt: recordedAt,
      payloadJson: JSON.stringify({ prompt: "continue after adoption", recordedAt }),
    });
    const sweep = dispatcher.dispatchDueContinuations();
    await started;
    const releaseRestore = claimRestoreDir("/tmp");
    adapter.startError = new Error("session admission refused by active restore");
    releaseStart();
    try {
      await sweep;
      expect(adapter.sent).toEqual([]);
      expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(0);
    } finally {
      releaseRestore();
    }
    adapter.startError = null;
    await pause(300);
    await dispatcher.dispatchDueContinuations();
    expect(adapter.sent).toEqual(["continue after adoption"]);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("manual recovery gives a later reset and restore fresh deferral state", async () => {
    const id = "limit-reset-fresh-deferral-episode";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    await dispatcher.ensureThreadSession(id, { resume: true });

    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const claim = store.claimDueContinuations.bind(store);
    let releaseRestore = claimRestoreDir("/tmp");
    try {
      svc.setThreadLimited(id, now - 1);
      await dispatcher.dispatchDueContinuations();
      expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(0);

      releaseRestore();
      releaseRestore = () => {};
      await dispatcher.resumeLimitedThread(id);
      expect(adapter.sent).toHaveLength(1);
      expect(store.listContinuationsForThread(id)).toEqual([]);

      svc.setThreadLimited(id, Date.now() - 1);
      await dispatcher.dispatchDueContinuations();
      expect(adapter.sent).toEqual([
        "Continue where you left off — the usage limit has reset.",
        "Continue where you left off — the usage limit has reset.",
      ]);
      expect(store.listContinuationsForThread(id)).toEqual([]);

      svc.setThreadLimited(id, Date.now() + 60_000);
      store.cancelContinuationsForThread(id);
      store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: Date.now() - 1 });
      const claimedCounts: number[] = [];
      store.claimDueContinuations = (at, excluded = []) => {
        const rows = claim(at, excluded);
        claimedCounts.push(rows.length);
        return rows;
      };
      releaseRestore = claimRestoreDir("/tmp");
      await dispatcher.dispatchDueContinuations();
      clock.mockReturnValue(now + 249);
      await dispatcher.dispatchDueContinuations();
      clock.mockReturnValue(now + 250);
      await dispatcher.dispatchDueContinuations();
      expect(claimedCounts).toEqual([1, 0, 1]);
      expect(store.listContinuationsForThread(id)[0]?.attempts).toBe(0);
    } finally {
      releaseRestore();
      svc.clearThreadLimited(id);
      clock.mockRestore();
      store.claimDueContinuations = claim;
    }
    await svc.stopAll();
  });

  test("restore during adoption holds a continuation without queueing a duplicate", async () => {
    const id = "limit-reset-restore-adoption";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    let releaseStart = (): void => {};
    let notifyStarted = (): void => {};
    const started = new Promise<void>((resolve) => { notifyStarted = resolve; });
    adapter.startEntered = notifyStarted;
    adapter.startGate = new Promise<void>((resolve) => { releaseStart = resolve; });
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 60_000);
    store.cancelContinuationsForThread(id);
    store.scheduleContinuation({ threadId: id, kind: "limit-reset", dueAt: 0 });
    const sweep = dispatcher.dispatchDueContinuations();
    await started;
    const releaseRestore = claimRestoreDir("/tmp");
    releaseStart();
    try {
      await sweep;
      expect(adapter.sent).toEqual([]);
      expect(store.listQueuedTurns(id)).toEqual([]);
      expect(store.listContinuationsForThread(id)).toHaveLength(1);
    } finally {
      releaseRestore();
    }
    await pause(450);
    expect(adapter.sent.filter((text) => text.includes("usage limit has reset"))).toHaveLength(1);
    expect(store.listQueuedTurns(id)).toEqual([]);
    const emit = adapter.emit;
    if (!emit) throw new Error("adapter emit not captured");
    emit({ type: "turn.completed", threadId: id, provider: "codex", at: Date.now(), source: "kone.store", turnId: "t-1" });
    await pause(40);
    expect(adapter.sent.filter((text) => text.includes("usage limit has reset"))).toHaveLength(1);
    expect(store.listQueuedTurns(id)).toEqual([]);
    expect(store.listContinuationsForThread(id)).toEqual([]);
    await svc.stopAll();
  });

  test("a failed manual resume session start keeps the limit and continuation", async () => {
    const id = "manual-resume-start-failure";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    adapter.startError = new Error("session adoption failed");
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 60_000);
    await expect(dispatcher.resumeLimitedThread(id)).rejects.toThrow("session adoption failed");
    expect(store.threadMeta(id)?.limitedAt ?? null).not.toBeNull();
    expect(store.listContinuationsForThread(id)).toHaveLength(1);
    await svc.stopAll();
  });

  test("manual resume sends its reset prompt before queued follow-ups", async () => {
    const id = "manual-resume-order";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    svc.setThreadLimited(id, Date.now() + 60_000);
    store.enqueueQueuedTurn({
      queueId: "manual-resume-follow-up",
      threadId: id,
      userBlockId: "manual-resume-follow-up-block",
      input: "queued follow-up",
    });
    expect(store.listQueuedTurns(id)).toHaveLength(1);
    await dispatcher.resumeLimitedThread(id);
    const emit = adapter.emit;
    if (!emit) throw new Error("adapter emit not captured");
    emit({ type: "turn.completed", threadId: id, provider: "codex", at: Date.now(), source: "kone.store", turnId: "t-1" });
    await pause(60);
    expect(adapter.sent[0]).toContain("usage limit has reset");
    expect(adapter.sent.indexOf("queued follow-up")).toBeGreaterThan(adapter.sent.indexOf("usage limit has reset"));
    await svc.stopAll();
  });

  test("manual resume held by restore preserves limit, snooze, continuation, and queue", async () => {
    const id = "manual-resume-restore-held";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const resetAt = Date.now() + 60_000;
    svc.setThreadLimited(id, resetAt);
    svc.setThreadSnooze(id, resetAt);
    const release = claimRestoreDir("/tmp");
    try {
      await expect(dispatcher.resumeLimitedThread(id)).rejects.toThrow("held by a restore");
      expect(store.threadMeta(id)?.limitedAt ?? null).not.toBeNull();
      expect(store.threadMeta(id)?.snoozedUntil).toBe(resetAt);
      expect(store.listContinuationsForThread(id)).toHaveLength(1);
      expect(store.listQueuedTurns(id)).toEqual([]);
      expect(adapter.sent).toEqual([]);
    } finally {
      release();
      await svc.stopAll();
    }
  });

  test("a refused manual resume send preserves limit, snooze, and continuation", async () => {
    const id = "manual-resume-send-refused";
    store.ensureThread({ threadId: id, provider: "codex", projectPath: "/tmp" });
    const adapter = new Adapter();
    const svc = build(adapter);
    const dispatcher = initThreadDispatcher({ service: svc, store, broadcast: () => {} });
    await svc.startSession({ threadId: id, provider: "codex", cwd: "/tmp" });
    const resetAt = Date.now() + 60_000;
    svc.setThreadLimited(id, resetAt);
    svc.setThreadSnooze(id, resetAt);
    const before = store.listContinuationsForThread(id);
    adapter.sendError = new Error("provider refused resume");
    await expect(dispatcher.resumeLimitedThread(id)).rejects.toThrow("provider refused resume");
    expect(store.threadMeta(id)?.limitedAt ?? null).not.toBeNull();
    expect(store.threadMeta(id)?.snoozedUntil).toBe(resetAt);
    expect(store.listContinuationsForThread(id)).toEqual(before);
    expect(store.listQueuedTurns(id)).toEqual([]);
    expect(adapter.sent).toEqual([]);
    await svc.stopAll();
  });
});
