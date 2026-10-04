import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place.
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

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

function openStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-block-order-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  store.ensureThread({ threadId: "other", projectPath: "/repo", provider: "codex" });
  return store;
}

test("a block moved to the end reads after everything written before the move", () => {
  const store = openStore();

  store.recordUserBlock({ blockId: "own", threadId: "t", text: "ship it" });
  store.recordUserBlock({ blockId: "carried", threadId: "t", text: "a note that waited" });
  store.moveBlockToEnd("t", "own");

  const ids = store.loadThread("t")?.blocks.map((b) => b.id);
  expect(ids).toEqual(["carried", "own"]);
});

// A block's seq is unique across every thread: the place after this thread's
// last block is often another thread's.
test("a block moves past another thread's newer block without colliding with it", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "first", threadId: "t", text: "one" });
  store.recordUserBlock({ blockId: "second", threadId: "t", text: "two" });
  store.recordUserBlock({ blockId: "elsewhere", threadId: "other", text: "meanwhile" });

  store.moveBlockToEnd("t", "first");

  expect(store.loadThread("t")?.blocks.map((b) => b.id)).toEqual(["second", "first"]);
  expect(store.loadThread("other")?.blocks.map((b) => b.id)).toEqual(["elsewhere"]);
});

test("claiming a queued row while another thread wrote last still claims it", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "earlier", threadId: "t", text: "running" });
  store.recordUserBlock({ blockId: "a", threadId: "t", text: "queued" });
  store.enqueueQueuedTurn({ queueId: "q-a", threadId: "t", userBlockId: "a", input: "queued" });
  store.recordUserBlock({ blockId: "elsewhere", threadId: "other", text: "meanwhile" });

  expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q-a");
});

// Two queued prompts, a note waiting: the first carries the note, and the
// transcript reads in the order things ran — the note, the first, the second.
test("mail carried by the first queued prompt does not put the second ahead of it", () => {
  const store = openStore();
  store.recordUserBlock({ blockId: "a", threadId: "t", text: "first" });
  store.enqueueQueuedTurn({ queueId: "q-a", threadId: "t", userBlockId: "a", input: "first", at: 1 });
  store.recordUserBlock({ blockId: "b", threadId: "t", text: "second" });
  store.enqueueQueuedTurn({ queueId: "q-b", threadId: "t", userBlockId: "b", input: "second", at: 2 });

  expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q-a");
  store.recordUserBlock({ blockId: "note", threadId: "t", text: "a note that waited" });
  store.moveBlockToEnd("t", "a");
  store.markQueuedTurnPromoted("q-a");

  expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q-b");
  store.markQueuedTurnPromoted("q-b");

  expect(store.loadThread("t")?.blocks.map((b) => b.id)).toEqual(["note", "a", "b"]);
});
