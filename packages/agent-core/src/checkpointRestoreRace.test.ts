import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { CheckpointStore } from "./conversationStoreTypes.js";
import type {
  ProviderAdapter,
  QueuedTurnStore,
  RuntimeEvent,
  SendTurnInput,
  TurnStartResult,
} from "./types.js";

// The window between the isolation check and the hard reset. Isolation is
// checked before the async checkpointExists/preview; a session or turn that
// starts during those awaits must stop the restore, and none may start in the
// directory while the reset runs. Git is replaced with gated stand-ins so each
// test can hold the revert at the exact await it needs.

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-restore-race-test-")));

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

function gate() {
  let open: () => void = () => {};
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
}

let previewEntered = gate();
let previewRelease = gate();
let restoreEntered = gate();
let restoreRelease = gate();
let holdPreview = true;
let holdRestore = false;
let restored = 0;

// Bun's module mocks outlive this file in a shared test process; keep the real
// module so afterAll can put it back for files that run real git.
const realCheckpoint = { ...(await import("@kone/git-core/checkpoint.js")) };

mock.module("@kone/git-core/checkpoint.js", () => ({
  checkpointExists: async () => true,
  createCheckpoint: async () => ({ id: "cp", ref: "refs/kone/checkpoints/cp", createdAt: 1 }),
  dropCheckpoint: async () => {},
  listCheckpoints: async () => [],
  previewCheckpointRestore: async () => {
    if (holdPreview) {
      holdPreview = false;
      previewEntered.open();
      await previewRelease.promise;
    }
    return { wouldWrite: [], wouldDelete: [] };
  },
  restoreCheckpoint: async () => {
    if (holdRestore) {
      holdRestore = false;
      restoreEntered.open();
      await restoreRelease.promise;
    }
    restored++;
  },
}));

const root = mkdtempSync(path.join(tmpdir(), "kone-restore-race-wt-"));

class Adapter {
  provider = "codex" as const;
  sendGate: ReturnType<typeof gate> | null = null;
  sent: string[] = [];
  async startSession(): Promise<Record<string, never>> {
    return {};
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    if (this.sendGate) await this.sendGate.promise;
    this.sent.push(input.input);
    return { threadId: input.threadId, turnId: `turn-${input.input}` };
  }
}

/** The owner runs in its own worktree at `root`; nothing else is stored, so
 *  any overlap the guard sees comes from a live session. */
const checkpoints: CheckpointStore = {
  threadProjectPath: () => root,
  threadWorkspace: () => ({ envMode: "worktree", worktreePath: root, requestedBranch: null }),
  allThreadWorkspaces: () => [],
  turnUserBlockId: () => null,
  recordTurnCheckpoint: () => false,
  getTurnCheckpoint: (threadId, turnId) => ({
    threadId,
    turnId,
    checkpointId: "cp",
    ref: "refs/kone/checkpoints/cp",
    createdAt: 1,
  }),
  listTurnCheckpoints: () => [],
  pruneTurnCheckpoints: () => [],
};

let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function build(adapter: Adapter) {
  const queueStub = {
    enqueueQueuedTurn: () => true,
    claimNextQueuedTurn: () => null,
  };
  return new AgentServiceCtor({
    // SAFETY: only the drain on session start reaches the queue slice here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: queueStub as unknown as QueuedTurnStore,
    checkpointStore: checkpoints,
    retentionSweepMs: 0,
    // SAFETY: the fake covers startSession/sendTurn, the only adapter surface
    // these tests reach.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: () => [adapter as unknown as ProviderAdapter],
  });
}

beforeAll(async () => {
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

/** A service over the real store, so queued rows claim, promote and wake the
 *  way they do in the app. */
function buildWithStore(adapter: Adapter) {
  const store = new ConversationStoreCtor(mkdtempSync(path.join(tmpdir(), "kone-restore-race-store-")));
  store.ensureThread({ threadId: "owner", provider: "codex", projectPath: root });
  const svc = new AgentServiceCtor({
    // SAFETY: the real store satisfies the queue slice.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    checkpointStore: checkpoints,
    retentionSweepMs: 0,
    // SAFETY: the fake covers startSession/sendTurn, the only adapter surface
    // these tests reach.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: () => [adapter as unknown as ProviderAdapter],
  });
  return { store, svc };
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

beforeEach(() => {
  previewEntered = gate();
  previewRelease = gate();
  restoreEntered = gate();
  restoreRelease = gate();
  holdPreview = true;
  holdRestore = false;
  restored = 0;
});

afterAll(() => {
  mock.module("@kone/git-core/checkpoint.js", () => realCheckpoint);
  rmSync(root, { recursive: true, force: true });
});

describe("checkpoint restore race", () => {
  test("a session started in the directory during the preview stops the restore", async () => {
    const svc = build(new Adapter());
    try {
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await previewEntered.promise;
      await svc.startSession({ threadId: "newcomer", provider: "codex", cwd: root });
      previewRelease.open();
      const result = await reverting;
      expect(restored).toBe(0);
      expect(result).toEqual(
        expect.objectContaining({
          ok: false,
          reason: "shared-checkout",
          rewind: { sourceThreadId: "owner", turnId: "old", userBlockId: null },
        }),
      );
    } finally {
      await svc.stopAll();
    }
  });

  test("a turn the owner starts during the preview stops the restore as busy", async () => {
    const adapter = new Adapter();
    const svc = build(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await previewEntered.promise;
      adapter.sendGate = gate();
      const sending = svc.sendTurn({ threadId: "owner", input: "meanwhile" });
      previewRelease.open();
      expect(await reverting).toEqual({ ok: false, reason: "busy" });
      expect(restored).toBe(0);
      adapter.sendGate.open();
      await sending;
    } finally {
      await svc.stopAll();
    }
  });

  test("no session starts in the directory while the reset runs", async () => {
    holdPreview = false;
    holdRestore = true;
    const svc = build(new Adapter());
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      await expect(
        svc.startSession({ threadId: "newcomer", provider: "codex", cwd: path.join(root, "nested") }),
      ).rejects.toThrow("checkpoint restore is running");
      restoreRelease.open();
      expect(await reverting).toEqual({ ok: true });
      expect(restored).toBe(1);
      await svc.startSession({ threadId: "newcomer", provider: "codex", cwd: path.join(root, "nested") });
    } finally {
      await svc.stopAll();
    }
  });
});

// Every way a turn can start on the owner waits out the reset, then goes.
describe("turns held by a restore", () => {
  test("a send during the reset queues and goes out once the restore lets go", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    const { store, svc } = buildWithStore(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      store.recordUserBlock({ threadId: "owner", blockId: "during", text: "during" });
      const queued = await svc.sendTurn({ threadId: "owner", input: "during", userBlockId: "during" });
      expect(queued.queued).toBe(true);
      await pause(20);
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      expect(await reverting).toEqual({ ok: true });
      await pause(20);
      expect(adapter.sent).toEqual(["during"]);
    } finally {
      restoreRelease.open();
      await svc.stopAll();
      store.close();
    }
  });

  test("the queue drain holds off during the reset and runs after it", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    const { store, svc } = buildWithStore(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      store.recordUserBlock({ threadId: "owner", blockId: "queued-ask", text: "queued ask" });
      store.enqueueQueuedTurn({
        threadId: "owner",
        queueId: "q",
        userBlockId: "queued-ask",
        dispatchMode: "queue",
        input: "queued ask",
      });
      svc.kickTurnSlot("owner");
      await pause(20);
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      await reverting;
      await pause(20);
      expect(adapter.sent).toEqual(["queued ask"]);
    } finally {
      restoreRelease.open();
      await svc.stopAll();
      store.close();
    }
  });

  test("Send now during the reset is refused before it claims the row", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    const { store, svc } = buildWithStore(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      store.recordUserBlock({ threadId: "owner", blockId: "queued-ask", text: "queued ask" });
      store.enqueueQueuedTurn({
        threadId: "owner",
        queueId: "q",
        userBlockId: "queued-ask",
        dispatchMode: "queue",
        input: "queued ask",
      });
      await expect(svc.sendQueuedTurnNow("owner", "q")).rejects.toThrow("checkpoint restore");
      expect(store.listQueuedTurns("owner").map((row) => row.queueId)).toEqual(["q"]);
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      await reverting;
      await pause(20);
      // The restore's wake runs the row it held back.
      expect(adapter.sent).toEqual(["queued ask"]);
    } finally {
      restoreRelease.open();
      await svc.stopAll();
      store.close();
    }
  });

  test("a liveOnly steer refuses instead of queueing", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    const { store, svc } = buildWithStore(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      await expect(
        svc.steerTurn({ threadId: "owner", input: "urgent" }, { liveOnly: true }),
      ).rejects.toThrow("can take this steer");
      expect(store.listQueuedTurns("owner")).toEqual([]);
      restoreRelease.open();
      await reverting;
    } finally {
      restoreRelease.open();
      await svc.stopAll();
      store.close();
    }
  });

  test("a command compaction is refused while the reset runs", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = Object.assign(new Adapter(), {
      capabilities: { compaction: { kind: "command", command: "/compact" } },
    });
    const svc = build(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      await expect(svc.compactThread("owner")).rejects.toThrow("checkpoint restore is running");
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      await reverting;
    } finally {
      restoreRelease.open();
      await svc.stopAll();
    }
  });

  test("a send whose queue write fails is refused, not sent", async () => {
    holdPreview = false;
    holdRestore = true;
    const storeDir = mkdtempSync(path.join(tmpdir(), "kone-restore-race-store-"));
    const store = new ConversationStoreCtor(storeDir);
    store.ensureThread({ threadId: "owner", provider: "codex", projectPath: root });
    const sql = new Database(path.join(storeDir, "kone.sqlite"));
    sql.exec(
      "CREATE TRIGGER refuse_enqueue BEFORE INSERT ON queued_turns BEGIN SELECT RAISE(ABORT, 'queue write unavailable'); END",
    );
    const adapter = new Adapter();
    const svc = new AgentServiceCtor({
      // SAFETY: the real store satisfies the queue slice.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      store: store as unknown as QueuedTurnStore,
      checkpointStore: checkpoints,
      retentionSweepMs: 0,
      // SAFETY: the fake covers startSession/sendTurn, the only adapter
      // surface this test reaches.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      adapters: () => [adapter as unknown as ProviderAdapter],
    });
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      await expect(svc.sendTurn({ threadId: "owner", input: "must wait" })).rejects.toThrow(
        "queue write unavailable",
      );
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      await reverting;
    } finally {
      restoreRelease.open();
      await svc.stopAll();
      sql.close();
      store.close();
    }
  });

  test("an inbox turn waits out the reset", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    const svc = build(adapter);
    try {
      await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      let carried = false;
      svc.setTurnInbox({
        carry: () => {
          if (carried) return null;
          carried = true;
          return {
            input: { threadId: "owner", input: "incoming question" },
            sending() {},
            settle() {},
            release() {},
          };
        },
      });
      svc.kickTurnSlot("owner");
      await pause(20);
      expect(adapter.sent).toEqual([]);
      restoreRelease.open();
      await reverting;
      await pause(20);
      expect(adapter.sent).toEqual(["incoming question"]);
    } finally {
      restoreRelease.open();
      await svc.stopAll();
    }
  });

});

// A steer handed to the provider can outlive the turn it aimed at and start a
// fresh one, so the restore must not claim the checkout while it is in flight.
test("a restore waits out a steer in flight as busy", async () => {
  holdPreview = false;
  const steerEntered = gate();
  const steerRelease = gate();
  const adapter = new Adapter();
  let emit: (event: RuntimeEvent) => void = () => {};
  const steering = Object.assign(adapter, {
    steerTurn: async (input: SendTurnInput): Promise<TurnStartResult> => {
      steerEntered.open();
      await steerRelease.promise;
      adapter.sent.push(input.input);
      return { threadId: input.threadId, turnId: "fresh-from-steer" };
    },
  });
  const svc = new AgentServiceCtor({
    // SAFETY: only the drain on session start reaches the queue slice here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: { enqueueQueuedTurn: () => true, claimNextQueuedTurn: () => null } as unknown as QueuedTurnStore,
    checkpointStore: checkpoints,
    retentionSweepMs: 0,
    adapters: (listener) => {
      emit = listener;
      // SAFETY: the fake covers startSession/sendTurn/steerTurn, the only
      // adapter surface this test reaches.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [steering as unknown as ProviderAdapter];
    },
  });
  const event = (type: "turn.started" | "turn.completed", turnId: string) =>
    emit({ type, threadId: "owner", provider: "codex", turnId, at: Date.now(), source: "codex.app-server" });
  try {
    await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
    event("turn.started", "live");
    const steered = svc.steerTurn({ threadId: "owner", input: "late steer" });
    await steerEntered.promise;
    // The turn the steer aimed at ends while the provider still holds it.
    event("turn.completed", "live");
    expect(await svc.revertToTurnCheckpoint("owner", "old", true)).toEqual({ ok: false, reason: "busy" });
    expect(restored).toBe(0);
    steerRelease.open();
    await steered;
    expect(await svc.revertToTurnCheckpoint("owner", "old", true)).toEqual({ ok: true });
  } finally {
    steerRelease.open();
    await svc.stopAll();
  }
});

// The direct send after a failed queue write is the same kind of handoff: the
// turn it followed can end while the provider prepares it, and the provider
// then starts it fresh.
test("a restore waits out a queue-failure send in flight as busy", async () => {
  holdPreview = false;
  const storeDir = mkdtempSync(path.join(tmpdir(), "kone-restore-race-store-"));
  const store = new ConversationStoreCtor(storeDir);
  store.ensureThread({ threadId: "owner", provider: "codex", projectPath: root });
  const sql = new Database(path.join(storeDir, "kone.sqlite"));
  sql.exec(
    "CREATE TRIGGER refuse_enqueue BEFORE INSERT ON queued_turns BEGIN SELECT RAISE(ABORT, 'queue write unavailable'); END",
  );
  const sendEntered = gate();
  const sendRelease = gate();
  const adapter = new Adapter();
  adapter.sendTurn = async (input: SendTurnInput): Promise<TurnStartResult> => {
    sendEntered.open();
    await sendRelease.promise;
    adapter.sent.push(input.input);
    return { threadId: input.threadId, turnId: "fresh-from-fallback" };
  };
  let emit: (event: RuntimeEvent) => void = () => {};
  const svc = new AgentServiceCtor({
    // SAFETY: the real store satisfies the queue slice.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    store: store as unknown as QueuedTurnStore,
    checkpointStore: checkpoints,
    retentionSweepMs: 0,
    adapters: (listener) => {
      emit = listener;
      // SAFETY: the fake covers startSession/sendTurn, the only adapter
      // surface this test reaches.
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      return [adapter as unknown as ProviderAdapter];
    },
  });
  const event = (type: "turn.started" | "turn.completed", turnId: string) =>
    emit({ type, threadId: "owner", provider: "codex", turnId, at: Date.now(), source: "codex.app-server" });
  try {
    await svc.startSession({ threadId: "owner", provider: "codex", cwd: root });
    event("turn.started", "live");
    // Busy, so the follow-up goes to the queue; the write fails and it is
    // handed straight to the provider.
    const sending = svc.sendTurn({ threadId: "owner", input: "late fallback" });
    await sendEntered.promise;
    event("turn.completed", "live");
    expect(await svc.revertToTurnCheckpoint("owner", "old", true)).toEqual({ ok: false, reason: "busy" });
    expect(restored).toBe(0);
    sendRelease.open();
    await sending;
    expect(adapter.sent).toEqual(["late fallback"]);
    expect(await svc.revertToTurnCheckpoint("owner", "old", true)).toEqual({ ok: true });
  } finally {
    sendRelease.open();
    await svc.stopAll();
    sql.close();
    store.close();
  }
});
