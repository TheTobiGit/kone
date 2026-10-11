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
  async startSession(): Promise<Record<string, never>> {
    return {};
  }
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  async sendTurn(input: SendTurnInput): Promise<TurnStartResult> {
    if (this.sendGate) await this.sendGate.promise;
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
});

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

  test("no session or turn starts in the directory while the reset runs", async () => {
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
      await expect(svc.sendTurn({ threadId: "owner", input: "during" })).rejects.toThrow(
        "checkpoint restore is running",
      );
      restoreRelease.open();
      expect(await reverting).toEqual({ ok: true });
      expect(restored).toBe(1);
      // The claim is released with the restore: the owner can work again.
      const after = await svc.sendTurn({ threadId: "owner", input: "after" });
      expect(after.turnId).toBe("turn-after");
    } finally {
      await svc.stopAll();
    }
  });
});

 test("inbox turn slot must not start an adapter turn while restore is active", async () => {
    holdPreview = false;
    holdRestore = true;
    const adapter = new Adapter();
    let sends = 0;
    const originalSend = adapter.sendTurn.bind(adapter);
    adapter.sendTurn = async (input) => { sends++; return originalSend(input); };
    const svc = build(adapter);
    try {
      await svc.startSession({threadId: "owner", provider: "codex", cwd: root});
      const reverting = svc.revertToTurnCheckpoint("owner", "old", true);
      await restoreEntered.promise;
      let carried = false;
      svc.setTurnInbox({carry: () => {
        if (carried) return null;
        carried = true;
        return {input: {threadId: "owner", input: "incoming question"}, sending() {}, settle() {}, release() {}};
      }});
      svc.kickTurnSlot("owner");
      await new Promise(resolve => setTimeout(resolve, 20));
      const during = sends;
      restoreRelease.open();
      await reverting;
      expect(during).toBe(0);
    } finally { restoreRelease.open(); await svc.stopAll(); }
 });

for (const delivery of ["automatic-drain", "send-now"]) {
 test(`queued ${delivery} must not reach adapter while restore is active`, async () => {
  holdPreview = false;
  holdRestore = true;
  const {ConversationStore} = await import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/ConversationStore.js");
  const store = new ConversationStore(mkdtempSync(path.join(tmpdir(),"kone-queue-restore-")));
  store.ensureThread({threadId:"owner",provider:"codex",projectPath:root});
  const adapter = new Adapter();
  let sends = 0;
  const send = adapter.sendTurn.bind(adapter);
  adapter.sendTurn = async input => { sends++; return send(input); };
  const svc = new AgentServiceCtor({store,checkpointStore:checkpoints,retentionSweepMs:0,adapters:()=>[adapter as unknown as ProviderAdapter]});
  try {
   await svc.startSession({threadId:"owner",provider:"codex",cwd:root});
   const reverting = svc.revertToTurnCheckpoint("owner","old",true);
   await restoreEntered.promise;
   store.recordUserBlock({threadId:"owner",blockId:"queued-ask",text:"queued ask"});
   store.enqueueQueuedTurn({threadId:"owner",queueId:"q",userBlockId:"queued-ask",dispatchMode:"queue",input:"queued ask"});
   if (delivery === "send-now") await svc.sendQueuedTurnNow("owner","q");
   else { svc.kickTurnSlot("owner"); await new Promise(resolve => setTimeout(resolve,20)); }
   const during = sends;
   restoreRelease.open();
   await reverting;
   expect(during).toBe(0);
  } finally { restoreRelease.open(); await svc.stopAll(); store.close(); }
 });
}
