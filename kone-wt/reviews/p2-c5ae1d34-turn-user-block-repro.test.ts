import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/userDataDir.js";

// Which user block started a turn — what the checkpoint-restore refusal hands
// to the branch-at-block rewind. Ordinary prompts are journaled with no turn
// id, so the answer comes from transcript order, against the real store.

mock.module("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/sqlite.js", () => ({ DatabaseSync: Database }));

let ConversationStoreCtor: typeof import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("/home/gideonsarfo/Developer/kone-wt/p2-safety/packages/agent-core/src/ConversationStore.js")).ConversationStore;
});

let clock = 1_000;

function openStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-turn-user-block-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  return store;
}

function startTurn(store: ReturnType<typeof openStore>, turnId: string): void {
  store.applyEvent({
    type: "turn.started",
    threadId: "t",
    provider: "codex",
    turnId,
    at: ++clock,
    source: "codex.app-server",
  });
}

test("an ordinary prompt is the block that started its turn", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "first-prompt", threadId: "t", text: "one" });
  startTurn(store, "turn-1");
  store.recordUserBlock({ blockId: "second-prompt", threadId: "t", text: "two" });
  startTurn(store, "turn-2");

  expect(store.turnUserBlockId("t", "turn-1")).toBe("first-prompt");
  expect(store.turnUserBlockId("t", "turn-2")).toBe("second-prompt");
});

test("a queued prompt moved to the tail on promotion still names its turn", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "running", threadId: "t", text: "running" });
  startTurn(store, "turn-1");
  store.recordUserBlock({ blockId: "queued", threadId: "t", text: "later" });
  store.recordUserBlock({ blockId: "note", threadId: "t", text: "a note that waited" });
  store.moveBlockToEnd("t", "queued");
  startTurn(store, "turn-2");

  expect(store.turnUserBlockId("t", "turn-2")).toBe("queued");
});

test("a turn no prompt led into has none, even after an earlier prompt", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "prompt", threadId: "t", text: "work" });
  startTurn(store, "turn-1");
  startTurn(store, "continuation");

  expect(store.turnUserBlockId("t", "continuation")).toBeNull();
});

test("a steer is never taken for a turn's prompt", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "prompt", threadId: "t", text: "work" });
  startTurn(store, "turn-1");
  store.recordUserBlock({ blockId: "steer", threadId: "t", text: "also this" });
  store.markUserBlockSteered("t", "steer", "turn-1", ++clock);
  startTurn(store, "continuation");

  expect(store.turnUserBlockId("t", "turn-1")).toBe("prompt");
  expect(store.turnUserBlockId("t", "continuation")).toBeNull();
});

test("an unknown turn has no prompt", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "prompt", threadId: "t", text: "work" });

  expect(store.turnUserBlockId("t", "never-started")).toBeNull();
});

test("several inbox-linked blocks select the first starting block and exclude later steers", () => {
 const store = openStore();
 for (const id of ["inbox-first", "inbox-second"]) {
  store.insertInboxMessage({inboxId:id,recipientThreadId:"t",senderThreadId:null,sender:null,kind:"question",body:id,projectPath:"/repo"});
  store.recordUserBlock({threadId:"t",blockId:id,text:id});
  store.setInboxBlockId(id,id);
 }
 const delivery = store.claimInbox("t",8,"ringing")!;
 startTurn(store,"inbox-turn");
 expect(store.linkInboxDelivery(delivery.deliveryId,"inbox-turn")).toBe(true);
 store.recordUserBlock({threadId:"t",blockId:"later-steer",text:"steer"});
 store.markUserBlockSteered("t","later-steer","inbox-turn",++clock);
 expect(store.turnUserBlockId("t","inbox-turn")).toBe("inbox-first");
});

test("a fork resolves copied prefix blocks to the fork's own block IDs", () => {
 const store = openStore();
 store.recordUserBlock({threadId:"t",blockId:"original",text:"original ask"});
 startTurn(store,"old-turn");
 store.applyEvent({type:"turn.completed",threadId:"t",turnId:"old-turn",provider:"codex",at:++clock,source:"codex.app-server"});
 store.recordUserBlock({threadId:"t",blockId:"edit-point",text:"next ask"});
 const fork = store.forkThreadAtBlock({threadId:"fork",sourceThreadId:"t",blockId:"edit-point",editedText:"new ask"});
 expect(fork.ok).toBe(true);
 const copied = store.loadThread("fork")!.blocks[0]!;
 expect(copied.id).not.toBe("original");
 expect(store.turnUserBlockId("fork","old-turn")).toBe(copied.id);
 store.applyEvent({type:"turn.started",threadId:"fork",turnId:"new-turn",provider:"codex",at:++clock,source:"codex.app-server"});
 if (!fork.ok) throw new Error("fork failed");
 expect(store.turnUserBlockId("fork","new-turn")).toBe(fork.editedBlockId);
});

test("an unpromoted queued block before the assistant must not become an earlier turn's rewind target", () => {
 const store = openStore();
 store.recordUserBlock({threadId:"t",blockId:"actual-prompt",text:"first actual ask"});
 // Followups arrive while the provider is still accepting the first turn.
 for (const id of ["queued-second", "queued-third"]) {
  store.recordUserBlock({threadId:"t",blockId:id,text:id});
  store.enqueueQueuedTurn({queueId:id,threadId:"t",userBlockId:id,dispatchMode:"queue",input:id});
 }
 startTurn(store,"first-turn");
 store.applyEvent({type:"turn.completed",threadId:"t",turnId:"first-turn",provider:"codex",at:++clock,source:"codex.app-server"});
 // The next delivery fails and is held. The third prompt has never promoted
 // and stays before the first assistant block in transcript order.
 const row = store.claimNextQueuedTurn("t")!;
 expect(row.queueId).toBe("queued-second");
 expect(store.releaseQueuedTurn(row.queueId,"failed")).toBe(true);
 expect(store.claimNextQueuedTurn("t")).toBeNull();
 expect(store.turnUserBlockId("t","first-turn")).toBe("actual-prompt");
});
