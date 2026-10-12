import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";

// Which user block started a turn — what the checkpoint-restore refusal hands
// to the branch-at-block rewind. Ordinary prompts are journaled with no turn
// id, so the answer comes from transcript order, against the real store.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
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

test("a prompt still waiting in the queue is passed over", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "actual-prompt", threadId: "t", text: "first" });
  // Follow-ups journaled and queued while the first turn was being accepted.
  for (const id of ["queued-second", "queued-third"]) {
    store.recordUserBlock({ blockId: id, threadId: "t", text: id });
    store.enqueueQueuedTurn({ queueId: id, threadId: "t", userBlockId: id, dispatchMode: "queue", input: id });
  }
  startTurn(store, "first-turn");
  expect(store.turnUserBlockId("t", "first-turn")).toBe("actual-prompt");
  // The next delivery fails and is held; the third cannot pass it and stays
  // before the first turn's assistant block.
  const row = store.claimNextQueuedTurn("t");
  expect(row?.queueId).toBe("queued-second");
  expect(store.releaseQueuedTurn("queued-second", "failed")).toBe(true);
  expect(store.claimNextQueuedTurn("t")).toBeNull();
  expect(store.turnUserBlockId("t", "first-turn")).toBe("actual-prompt");
});

test("a claimed row's prompt names the turn it starts", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "running", threadId: "t", text: "running" });
  startTurn(store, "turn-1");
  store.recordUserBlock({ blockId: "queued", threadId: "t", text: "queued" });
  store.enqueueQueuedTurn({ queueId: "q", threadId: "t", userBlockId: "queued", dispatchMode: "queue", input: "queued" });
  expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q");
  startTurn(store, "turn-2");
  // Still 'promoting' until the provider's acceptance is recorded.
  expect(store.turnUserBlockId("t", "turn-2")).toBe("queued");
});
