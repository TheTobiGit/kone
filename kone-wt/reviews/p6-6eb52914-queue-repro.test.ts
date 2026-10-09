import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/userDataDir.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in with
// bun:sqlite and import the store only once the stub is in place.
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

mock.module("/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type ConversationStoreType = import("/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-queue-edit-test-")));
  const store = new ConversationStoreCtor();
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  return store;
}

function enqueue(
  store: ConversationStoreType,
  queueId: string,
  blockId: string,
  text: string,
  at: number,
  extra: { model?: string; dispatchMode?: "queue" | "steer" } = {},
): void {
  store.recordUserBlock({ blockId, threadId: "t", text, at });
  store.enqueueQueuedTurn({
    queueId,
    threadId: "t",
    userBlockId: blockId,
    input: text,
    at,
    ...extra,
  });
}

beforeAll(async () => {
  ConversationStoreCtor = (await import("/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/ConversationStore.js")).ConversationStore;
});

describe("editing a queued turn in place", () => {
  test("rewrites the row and its hidden block, keeping position", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "first", 100);
    enqueue(store, "q2", "ub-2", "second", 200);
    // q2 first, then q1.
    store.reorderQueuedTurns("t", ["q2", "q1"]);
    const before = store.listQueuedTurns("t").map((r) => [r.queueId, r.sortKey]);

    expect(store.editQueuedTurn("t", "q2", { input: "edited second" })).not.toBeNull();

    const after = store.listQueuedTurns("t");
    expect(after.map((r) => r.queueId)).toEqual(["q2", "q1"]);
    // The sort keys are untouched — an edit is not a requeue.
    expect(after.map((r) => [r.queueId, r.sortKey])).toEqual(before);
    expect(after[0]?.input).toBe("edited second");
  });

  test("an edit is visible in the transcript after promotion, in its place", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "first", 100);
    enqueue(store, "q2", "ub-2", "second", 200);
    store.reorderQueuedTurns("t", ["q2", "q1"]);
    store.editQueuedTurn("t", "q2", { input: "edited second" });

    const claimed = store.claimNextQueuedTurn("t");
    expect(claimed?.queueId).toBe("q2");
    expect(claimed?.input).toBe("edited second");
    // The running turn journals its assistant block, then the row settles.
    store.applyEvent({
      type: "turn.started",
      threadId: "t",
      provider: "codex",
      at: 300,
      source: "kone.store",
      turnId: "turn-1",
    });
    store.markQueuedTurnPromoted("q2");

    const timeline = (store.loadThread("t")?.blocks ?? []).map((b) =>
      b.role === "user" ? `user: ${b.text}` : `assistant: ${b.turnId}`,
    );
    // The edited prompt sits right before its own reply; q1 is still hidden.
    expect(timeline).toContain("user: edited second");
    expect(timeline).not.toContain("user: second");
    expect(timeline).not.toContain("user: first");
  });

  test("edits replace the searchable text and retain it after promotion", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "oldqueueword", 100);
    expect(store.searchConversations("oldqueueword").length).toBeGreaterThan(0);
    store.editQueuedTurn("t", "q1", { input: "newqueueword" });
    expect(store.searchConversations("newqueueword").some((hit) => hit.blockId === "ub-1")).toBe(true);
    expect(store.searchConversations("oldqueueword").some((hit) => hit.blockId === "ub-1")).toBe(false);

    expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q1");
    store.applyEvent({
      type: "turn.started",
      threadId: "t",
      provider: "codex",
      at: 300,
      source: "kone.store",
      turnId: "turn-1",
    });
    store.markQueuedTurnPromoted("q1");
    expect(store.searchConversations("newqueueword").some((hit) => hit.blockId === "ub-1")).toBe(true);
    expect(store.searchConversations("oldqueueword").some((hit) => hit.blockId === "ub-1")).toBe(false);
  });

  test("refuses a claimed (promoting) row", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "hello", 100);
    expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q1");
    expect(store.editQueuedTurn("t", "q1", { input: "changed" })).toBeNull();
  });

  test("refuses a cancelled row and an unknown row", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "hello", 100);
    store.cancelQueuedTurn("q1");
    expect(store.editQueuedTurn("t", "q1", { input: "changed" })).toBeNull();
    expect(store.editQueuedTurn("t", "missing", { input: "changed" })).toBeNull();
  });

  test("keeps the queued model unless the patch names one", () => {
    const store = freshStore();
    enqueue(store, "q1", "ub-1", "hello", 100, { model: "gpt-6-luna" });
    store.editQueuedTurn("t", "q1", { input: "hello again" });
    expect(store.listQueuedTurns("t")[0]?.model).toBe("gpt-6-luna");
    store.editQueuedTurn("t", "q1", { input: "hello once more", model: "gpt-6-sol" });
    expect(store.listQueuedTurns("t")[0]?.model).toBe("gpt-6-sol");
  });
});

describe("editing a queued turn in place — field preservation and ownership", () => {
  test("a text-only edit keeps existing attachments and skills; explicit [] clears", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-1", threadId: "t", text: "hi", at: 100 });
    store.enqueueQueuedTurn({
      queueId: "q1",
      threadId: "t",
      userBlockId: "ub-1",
      input: "hi",
      attachments: [{ type: "file", id: "a1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
      skills: [{ name: "s", path: "/s" }],
      at: 100,
    });

    store.editQueuedTurn("t", "q1", { input: "hi again" });
    const kept = store.listQueuedTurns("t")[0]!;
    expect(kept.attachments).toHaveLength(1);
    expect(kept.skills).toHaveLength(1);

    store.editQueuedTurn("t", "q1", { input: "hi once more", attachments: [], skills: [] });
    expect(store.listQueuedTurns("t")[0]?.attachments ?? []).toEqual([]);
    expect(store.listQueuedTurns("t")[0]?.skills ?? []).toEqual([]);
  });

  test("refuses a queue id that belongs to another thread", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "u", projectPath: "/repo", provider: "codex" });
    store.recordUserBlock({ blockId: "ub-1", threadId: "t", text: "hi", at: 100 });
    store.enqueueQueuedTurn({ queueId: "q1", threadId: "t", userBlockId: "ub-1", input: "hi", at: 100 });
    expect(store.editQueuedTurn("u", "q1", { input: "changed" })).toBeNull();
    // The real owner can still edit it.
    expect(store.editQueuedTurn("t", "q1", { input: "changed" })).not.toBeNull();
  });
});

describe("queue cancel binds the row to its thread", () => {
  test("a cross-thread queue id is refused", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "u", projectPath: "/repo", provider: "codex" });
    enqueue(store, "q1", "ub-1", "hi", 100);
    expect(store.cancelQueuedTurn("q1", "u")).toBe(false);
    expect(store.cancelQueuedTurn("q1", "t")).toBe(true);
  });
});

test("review: edit then cancel removes both old and edited search text", () => {
 const store = freshStore();
 try {
 enqueue(store,"q1","ub-1","oldreviewword",100);
 expect(store.editQueuedTurn("t","q1",{input:"editedreviewword"})).not.toBeNull();
 expect(store.cancelQueuedTurn("q1","t")).toBe(true);
 expect(store.searchConversations("oldreviewword")).toEqual([]);
 expect(store.searchConversations("editedreviewword")).toEqual([]);
 } finally {store.close();}
});
test("review: promoted row keeps edited search text despite late edit and cancel", () => {
 const store = freshStore();
 try {
 enqueue(store,"q1","ub-1","oldreviewword",100);
 store.editQueuedTurn("t","q1",{input:"editedreviewword"});
 expect(store.claimNextQueuedTurn("t")?.input).toBe("editedreviewword");
 expect(store.editQueuedTurn("t","q1",{input:"lateword"})).toBeNull();
 expect(store.cancelQueuedTurn("q1","t")).toBe(false);
 store.markQueuedTurnPromoted("q1");
 expect(store.searchConversations("editedreviewword")).toHaveLength(1);
 expect(store.searchConversations("oldreviewword")).toEqual([]);
 expect(store.searchConversations("lateword")).toEqual([]);
 } finally {store.close();}
});

test("review: failed block update rolls queue and search back", async () => {
 const store = freshStore();
 const {getUserDataDir} = await import("/Users/gideonsarfo/Developer/kone-wt/p6-queue/packages/agent-core/src/userDataDir.ts");
 const db = new Database(path.join(getUserDataDir(),"kone.sqlite"));
 try {
 enqueue(store,"q1","ub-1","oldreviewword",100);
 db.exec("CREATE TRIGGER refuse_edit BEFORE UPDATE ON blocks BEGIN SELECT RAISE(ABORT,'review injected failure'); END");
 expect(store.editQueuedTurn("t","q1",{input:"editedreviewword"})).toBeNull();
 expect(store.listQueuedTurns("t")[0]?.input).toBe("oldreviewword");
 expect(store.searchConversations("oldreviewword")).toHaveLength(1);
 expect(store.searchConversations("editedreviewword")).toEqual([]);
 } finally { db.close();store.close(); }
});
