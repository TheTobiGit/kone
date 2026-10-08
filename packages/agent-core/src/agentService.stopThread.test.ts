import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { StartCancelled, type ProviderAdapter, type QueuedTurnStore } from "./types.js";

// Stop is split into the request and its confirmation, and a stop that arrives
// while a session is still connecting must take effect. The adapter is faked
// and its start held open on a gate, so the "connecting" window is real.

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-stop-thread-test-")));
mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let startGate: Promise<void> | null = null;
let openStart: (() => void) | null = null;

function holdStart(): void {
  startGate = new Promise<void>((resolve) => {
    openStart = resolve;
  });
}
function releaseStart(): void {
  openStart?.();
  startGate = null;
  openStart = null;
}

/** The interrupt/stop calls the adapter saw, across every service built here. */
const adapterCalls: Array<{ kind: "interrupt" | "stop"; threadId: string }> = [];
/** When set, the fake adapter's teardown throws this. */
let adapterStopError: Error | null = null;

class StopFakeAdapter {
  provider = "codex" as const;
  constructor(public emit: (event: import("./types.js").RuntimeEvent) => void) {}
  async startSession(_input: { threadId: string }): Promise<Record<string, never>> {
    if (startGate) await startGate;
    return {};
  }
  async stopSession(threadId: string): Promise<void> {
    adapterCalls.push({ kind: "stop", threadId });
    if (adapterStopError) throw adapterStopError;
  }
  async stopAll(): Promise<void> {}
  async sendTurn(input: { threadId: string }): Promise<{ threadId: string; turnId: string }> {
    return { threadId: input.threadId, turnId: "turn-1" };
  }
  async interruptTurn(threadId: string): Promise<void> {
    adapterCalls.push({ kind: "interrupt", threadId });
  }
}

type AgentServiceType = import("./AgentService.js").AgentService;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

function buildService(): AgentServiceType {
  const queueStub = {
    enqueueQueuedTurn: () => true,
    claimNextQueuedTurn: () => null,
    cancelQueuedTurnsForThread: () => [],
  };
  return new AgentServiceCtor({
    // SAFETY: the two stubbed queue methods are all these stop paths reach.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: queueStub as unknown as QueuedTurnStore,
    checkpointStore: null,
    // A short whole-stop deadline so the unresolved-start test is fast.
    stopTotalTimeoutMs: 60,
    // SAFETY: one fake adapter is the whole provider roster here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: (emit) => [new StopFakeAdapter(emit) as unknown as ProviderAdapter],
  });
}

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
});

afterAll(() => {
  releaseStart();
});

describe("AgentService.stopThread", () => {
  test("an idle thread confirms stopped without requesting an interrupt", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      expect(await service.stopThread("t-idle")).toEqual({
        interruptRequested: false,
        confirmedStopped: true,
        wasRunning: false,
      });
      expect(adapterCalls).toEqual([]);
    } finally {
      await service.stopAll();
    }
  });

  test("a live session reports both the request and its confirmation", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      await service.startSession({ threadId: "t-live", provider: "codex", cwd: "/tmp" });
      expect(await service.stopThread("t-live")).toEqual({
        interruptRequested: true,
        confirmedStopped: true,
        wasRunning: true,
      });
      expect(adapterCalls).toEqual([{ kind: "stop", threadId: "t-live" }]);
      expect(service.hasLiveSession("t-live")).toBe(false);
    } finally {
      await service.stopAll();
    }
  });

  test("a stop during startup tears the session down and the start rejects as cancelled", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      holdStart();
      const starting = service.startSession({ threadId: "t-start", provider: "codex", cwd: "/tmp" });
      const startingResult = starting.catch((err: Error) => err);
      // The start is parked in the adapter; stopping must not race it.
      const stopping = service.stopThread("t-start");
      releaseStart();
      const result = await stopping;
      expect(await startingResult).toBeInstanceOf(StartCancelled);
      expect(result.interruptRequested).toBe(true);
      expect(result.confirmedStopped).toBe(true);
      expect(result.wasRunning).toBe(true);
      expect(adapterCalls).toEqual([{ kind: "stop", threadId: "t-start" }]);
      expect(service.hasLiveSession("t-start")).toBe(false);
    } finally {
      await service.stopAll();
    }
  });

  test("an interrupt during startup keeps the session and cancels only the first turn", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      holdStart();
      const starting = service.startSession({
        threadId: "t-start-int",
        provider: "codex",
        cwd: "/tmp",
      });
      const startingResult = starting.catch((err: Error) => err);
      await service.interruptTurn("t-start-int");
      releaseStart();
      // The start rejects as cancelled so no caller sends the first prompt...
      expect(await startingResult).toBeInstanceOf(StartCancelled);
      // ...but the session itself is NOT stopped, and no adapter stop was asked.
      expect(service.hasLiveSession("t-start-int")).toBe(true);
      expect(adapterCalls).toEqual([]);
    } finally {
      await service.stopAll();
    }
  });

  test("a stop whose start never resolves is not confirmed and is bounded", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      holdStart();
      const starting = service.startSession({
        threadId: "t-unresolved",
        provider: "codex",
        cwd: "/tmp",
      });
      void starting.catch(() => undefined);
      // Never release the gate: the stop must answer within its deadline,
      // reporting the request but not a confirmation.
      const result = await service.stopThread("t-unresolved");
      expect(result.interruptRequested).toBe(true);
      expect(result.confirmedStopped).toBe(false);
      expect(result.detail).toBeTruthy();
      releaseStart();
      await service.stopAll();
    } finally {
      releaseStart();
    }
  });

  test("a teardown failure is reported, never thrown", async () => {
    adapterCalls.length = 0;
    const service = buildService();
    try {
      await service.startSession({ threadId: "t-throw", provider: "codex", cwd: "/tmp" });
      adapterStopError = new Error("teardown failure");
      const result = await service.stopThread("t-throw");
      adapterStopError = null;
      expect(result.confirmedStopped).toBe(false);
      expect(result.detail).toContain("teardown failure");
    } finally {
      adapterStopError = null;
      await service.stopAll();
    }
  });
});
