import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place (the
// pattern the sibling store tests use).
class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

import type { RuntimeEvent, StoredBlock } from "./types.js";

function freshStore(): ConversationStoreType {
  setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-queue-order-test-")));
  const store = new ConversationStoreCtor();
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  return store;
}

function turnStarted(turnId: string, at: number): RuntimeEvent {
  return {
    type: "turn.started",
    threadId: "t",
    provider: "opencode",
    at,
    source: "kone.store",
    turnId,
  };
}

/** The transcript as a user can read it: each user block by its own words,
 *  each assistant block by the turn that produced it. */
function timeline(store: ConversationStoreType): string[] {
  const blocks = store.loadThread("t")?.blocks ?? [];
  return blocks.map((b: StoredBlock) => (b.role === "user" ? `user: ${b.text}` : `assistant: ${b.turnId}`));
}

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

describe("a promoted queued turn keeps its place before its own reply", () => {
  /** The real drain sequence, in the real order: the prompt is journaled when
   *  it is sent (while the turn below is still running), the row is claimed,
   *  the adapter announces turn.started from inside sendTurn, and only then
   *  does the row settle as promoted. */
  function drainedStore(): ConversationStoreType {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-1", threadId: "t", text: "hey", at: 100 });
    store.applyEvent(turnStarted("turn-1", 110));
    // Sent while turn-1 runs, so it is journaled now and waits in the queue.
    store.recordUserBlock({ blockId: "ub-2", threadId: "t", text: "you good?", at: 200 });
    store.enqueueQueuedTurn({
      threadId: "t",
      queueId: "q-1",
      userBlockId: "ub-2",
      input: "you good?",
      at: 200,
    });
    store.applyEvent(turnStarted("turn-1", 300));

    // The drain: claim, hand to the provider (which journals turn-2), settle.
    const row = store.claimNextQueuedTurn("t");
    expect(row?.queueId).toBe("q-1");
    store.applyEvent(turnStarted("turn-2", 310));
    expect(store.markQueuedTurnPromoted("q-1")).toBe(true);
    return store;
  }

  test("the drained prompt reads before the reply it produced", () => {
    expect(timeline(drainedStore())).toEqual([
      "user: hey",
      "assistant: turn-1",
      "user: you good?",
      "assistant: turn-2",
    ]);
  });

  test("Send now places its row the same way a drain does", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-1", threadId: "t", text: "hey", at: 100 });
    store.applyEvent(turnStarted("turn-1", 110));
    store.recordUserBlock({ blockId: "ub-2", threadId: "t", text: "you good?", at: 200 });
    store.enqueueQueuedTurn({
      threadId: "t",
      queueId: "q-1",
      userBlockId: "ub-2",
      input: "you good?",
      at: 200,
    });

    expect(store.claimQueuedTurn("q-1")?.row.queueId).toBe("q-1");
    store.applyEvent(turnStarted("turn-2", 310));
    expect(store.markQueuedTurnPromoted("q-1")).toBe(true);

    expect(timeline(store)).toEqual([
      "user: hey",
      "assistant: turn-1",
      "user: you good?",
      "assistant: turn-2",
    ]);
  });

  test("the prompt keeps its sent-at time, not its promotion time", () => {
    const store = drainedStore();
    const prompt = store.loadThread("t")?.blocks.find((b) => b.role === "user" && b.text === "you good?");
    expect(prompt?.role === "user" ? prompt.at : undefined).toBe(200);
  });
});