import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { ContinuationStore } from "./conversationStoreTypes.js";
import type { ProviderAdapter, QueuedTurnStore, StoredThreadMeta } from "./types.js";

// A usage-limit failure is a real state: the service marks the thread limited
// with the provider's reset, schedules a resume at it, and clears both when
// real new work is accepted. The store slices are injected fakes, so no
// database is opened and no CLI is spawned.

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-limit-test-")));
mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const RESET = Date.now() + 3_600_000;

type EmitEvent = (event: import("./types.js").RuntimeEvent) => void;

class LimitFakeAdapter {
  provider = "codex" as const;
  static emits: EmitEvent[] = [];
  static turnCounter = 0;
  constructor(public emit: EmitEvent) {
    LimitFakeAdapter.emits.push(emit);
  }
  async startSession(): Promise<Record<string, never>> {
    return {};
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async sendTurn(input: { threadId: string }): Promise<{ threadId: string; turnId: string }> {
    return { threadId: input.threadId, turnId: `turn-${++LimitFakeAdapter.turnCounter}` };
  }
}

class FakeHistory {
  limitedAt = new Map<string, number | null>();
  limitResetAt = new Map<string, number | null>();
  snoozedUntil = new Map<string, number | null>();
  constructor(private readonly provider: "codex" = "codex") {}
  threadMeta(threadId: string): StoredThreadMeta {
    return {
      threadId,
      projectPath: "/p",
      provider: this.provider,
      createdAt: 0,
      updatedAt: 0,
      limitedAt: this.limitedAt.get(threadId) ?? null,
      limitResetAt: this.limitResetAt.get(threadId) ?? null,
      snoozedUntil: this.snoozedUntil.get(threadId) ?? null,
    };
  }
  setArchived(): void {}
  setDone(): void {}
  setLimited(threadId: string, resetAt: number | null): void {
    this.limitedAt.set(threadId, Date.now());
    this.limitResetAt.set(threadId, resetAt);
  }
  clearLimited(threadId: string): void {
    this.limitedAt.set(threadId, null);
    this.limitResetAt.set(threadId, null);
  }
  setSnooze(threadId: string, until: number | null): void {
    this.snoozedUntil.set(threadId, until);
  }
  staleThreadIds(): string[] {
    return [];
  }
}

class FakeContinuations implements ContinuationStore {
  scheduled: Array<{ threadId: string; kind: string; dueAt: number }> = [];
  cancelled: string[] = [];
  scheduleContinuation(input: {
    threadId: string;
    kind: string;
    dueAt: number;
    payloadJson?: string | null;
  }) {
    this.scheduled.push({ threadId: input.threadId, kind: input.kind, dueAt: input.dueAt });
    return { continuationId: "c1" };
  }
  cancelContinuationsForThread(threadId: string): number {
    this.cancelled.push(threadId);
    return 0;
  }
}

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;

function build() {
  const history = new FakeHistory();
  const continuations = new FakeContinuations();
  const queueStub = {
    enqueueQueuedTurn: () => true,
    claimNextQueuedTurn: () => null,
    cancelQueuedTurnsForThread: () => [],
  };
  const service = new AgentServiceCtor({
    // SAFETY: the queue slice is never exercised by these limit paths.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: queueStub as unknown as QueuedTurnStore,
    checkpointStore: null,
    continuationStore: continuations,
    historyStore: history,
    // SAFETY: one fake adapter is the whole roster here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: (emit) => [new LimitFakeAdapter(emit) as unknown as ProviderAdapter],
  });
  return { service, history, continuations };
}

function lastEmit(): EmitEvent {
  const emit = LimitFakeAdapter.emits[LimitFakeAdapter.emits.length - 1];
  if (!emit) throw new Error("no fake adapter emit captured");
  return emit;
}

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
});

describe("AgentService usage limits", () => {
  test("a limit failure marks the thread and schedules a resume at the reset", async () => {
    LimitFakeAdapter.emits.length = 0;
    const { service, history, continuations } = build();
    try {
      await service.startSession({ threadId: "t-limit", provider: "codex", cwd: "/tmp" });
      lastEmit()({
        type: "turn.aborted",
        threadId: "t-limit",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "turn-1",
        reason: "failed",
        message: "429 usage limit reached",
        limitResetAt: RESET,
      });
      expect(history.limitedAt.get("t-limit")).not.toBeNull();
      expect(history.limitResetAt.get("t-limit")).toBe(RESET);
      expect(continuations.scheduled).toEqual([
        { threadId: "t-limit", kind: "limit-reset", dueAt: RESET },
      ]);
    } finally {
      await service.stopAll();
    }
  });

  test("a limit failure with no reset marks the thread but schedules nothing", async () => {
    LimitFakeAdapter.emits.length = 0;
    const { service, history, continuations } = build();
    try {
      await service.startSession({ threadId: "t-noreset", provider: "codex", cwd: "/tmp" });
      lastEmit()({
        type: "turn.aborted",
        threadId: "t-noreset",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "turn-1",
        reason: "failed",
        message: "usage limit reached",
      });
      expect(history.limitedAt.get("t-noreset")).not.toBeNull();
      expect(history.limitResetAt.get("t-noreset")).toBeNull();
      expect(continuations.scheduled).toEqual([]);
    } finally {
      await service.stopAll();
    }
  });

  test("real new work accepted by the adapter clears the limit and its resume", async () => {
    LimitFakeAdapter.emits.length = 0;
    const { service, history, continuations } = build();
    try {
      await service.startSession({ threadId: "t-clear", provider: "codex", cwd: "/tmp" });
      lastEmit()({
        type: "turn.aborted",
        threadId: "t-clear",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "turn-1",
        reason: "failed",
        message: "429 usage limit",
        limitResetAt: RESET,
      });
      continuations.cancelled.length = 0;
      await service.sendTurn({ threadId: "t-clear", input: "try again" });
      expect(history.limitedAt.get("t-clear")).toBeNull();
      expect(continuations.cancelled).toContain("t-clear");
    } finally {
      await service.stopAll();
    }
  });

  test("a non-limit failure does not mark the thread limited", async () => {
    LimitFakeAdapter.emits.length = 0;
    const { service, history, continuations } = build();
    try {
      await service.startSession({ threadId: "t-plain", provider: "codex", cwd: "/tmp" });
      lastEmit()({
        type: "turn.aborted",
        threadId: "t-plain",
        provider: "codex",
        at: Date.now(),
        source: "kone.store",
        turnId: "turn-1",
        reason: "failed",
        message: "connection reset",
      });
      expect(history.limitedAt.get("t-plain") ?? null).toBeNull();
      expect(continuations.scheduled).toEqual([]);
    } finally {
      await service.stopAll();
    }
  });
});
