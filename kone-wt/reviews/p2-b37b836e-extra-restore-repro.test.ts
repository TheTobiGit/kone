import { afterAll, beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/userDataDir.js";
import type { CheckpointStore } from "/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/conversationStoreTypes.js";
import type { ProviderAdapter, QueuedTurnStore, SendTurnInput, TurnStartResult } from "/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/types.js";

// The window between the isolation check and the hard reset. Isolation is
// checked before the async checkpointExists/preview; a session or turn that
// starts during those awaits must stop the restore, and none may start in the
// directory while the reset runs. Git is replaced with gated stand-ins so each
// test can hold the revert at the exact await it needs.

setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-restore-race-test-")));

mock.module("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/sqlite.js", () => ({ DatabaseSync: Database }));

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

let AgentServiceCtor: typeof import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/AgentService.js").AgentService;
let ConversationStoreCtor: typeof import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/ConversationStore.js").ConversationStore;

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
  AgentServiceCtor = (await import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/AgentService.js")).AgentService;
  ConversationStoreCtor = (await import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/ConversationStore.js")).ConversationStore;
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

test("liveOnly steer must refuse rather than queue during restore", async () => {
 holdPreview=false; holdRestore=true;
 const adapter=new Adapter();
 const {store,svc}=buildWithStore(adapter);
 try {
  await svc.startSession({threadId:"owner",provider:"codex",cwd:root});
  const reverting=svc.revertToTurnCheckpoint("owner","old",true);
  await restoreEntered.promise;
  let error:unknown;
  try { await svc.steerTurn({threadId:"owner",input:"urgent live only"},{liveOnly:true}); } catch(e) { error=e; }
  const queued=store.listQueuedTurns("owner");
  restoreRelease.open(); await reverting; await pause(20);
  expect(error).toBeDefined();
  expect(queued).toEqual([]);
 } finally {restoreRelease.open(); await svc.stopAll();store.close();}
});

test("command compaction must not start an adapter turn during restore", async () => {
 holdPreview=false; holdRestore=true;
 const adapter=Object.assign(new Adapter(),{capabilities:{compaction:{kind:"command",command:"/compact"}}});
 const svc=new AgentServiceCtor({store:{enqueueQueuedTurn:()=>true,claimNextQueuedTurn:()=>null} as unknown as QueuedTurnStore,checkpointStore:checkpoints,retentionSweepMs:0,compactFallbackTimeoutMs:30,adapters:()=>[adapter as unknown as ProviderAdapter]});
 try {
  await svc.startSession({threadId:"owner",provider:"codex",cwd:root});
  const reverting=svc.revertToTurnCheckpoint("owner","old",true);
  await restoreEntered.promise;
  const compacting=svc.compactThread("owner").catch(()=>null);
  await pause(10);
  const sent=[...adapter.sent];
  restoreRelease.open(); await reverting; await compacting;
  expect(sent).toEqual([]);
 } finally {restoreRelease.open();await svc.stopAll();}
});

test("post-restore kicks must not double-start alongside an existing drain", async () => {
 holdPreview=false;holdRestore=true;
 const adapter=new Adapter();
 const {store,svc}=buildWithStore(adapter);
 try {
  await svc.startSession({threadId:"owner",provider:"codex",cwd:root});
  const reverting=svc.revertToTurnCheckpoint("owner","old",true);
  await restoreEntered.promise;
  for(const id of ["one","two"]) {
   store.recordUserBlock({threadId:"owner",blockId:id,text:id});
   await svc.sendTurn({threadId:"owner",input:id,userBlockId:id,dispatchMode:"steer"});
  }
  let starts=0;
  const original=adapter.sendTurn.bind(adapter);
  adapter.sendTurn=async(input)=>{starts++;return original(input);};
  adapter.sendGate=gate();
  svc.kickTurnSlot("owner");
  restoreRelease.open();await reverting;
  for(let i=0;i<5;i++)svc.kickTurnSlot("owner");
  await pause(20);
  const during=starts;
  adapter.sendGate.open();await pause(20);
  expect(during).toBe(1);
 }finally {restoreRelease.open();adapter.sendGate?.open();await svc.stopAll();store.close();}
});
