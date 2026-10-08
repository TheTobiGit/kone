import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

// Durable scheduled continuations, at the store: one write claims a due row, so
// two callers can never both run it; a boot releases claims a dead process left
// behind; and new work, archive or settle drops unclaimed rows.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const { ConversationStore } = await import("./ConversationStore.js");
type Store = InstanceType<typeof ConversationStore>;

let testUserDataDir = "";
function freshStore(): Store {
  testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-continuations-test-"));
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}
function reopenStore(): Store {
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}

function seedThread(store: Store, threadId: string): void {
  store.ensureThread({ threadId, projectPath: "/proj", provider: "codex" });
}

describe("continuation store", () => {
  test("a due continuation is claimed exactly once", () => {
    const store = freshStore();
    seedThread(store, "t-1");
    const row = store.scheduleContinuation({
      threadId: "t-1",
      kind: "quit-resume",
      dueAt: 100,
      payloadJson: JSON.stringify({ prompt: "continue" }),
    });
    expect(row).not.toBeNull();

    const first = store.claimDueContinuations(50);
    expect(first).toEqual([]);
    const claimed = store.claimDueContinuations(200);
    expect(claimed.map((r) => r.continuationId)).toEqual([row?.continuationId]);
    expect(claimed[0]?.claimedAt).toBe(200);
    // The second caller sees the row already claimed.
    expect(store.claimDueContinuations(200)).toEqual([]);
  });

  test("a boot releases the claim a dead process left", () => {
    let store = freshStore();
    seedThread(store, "t-2");
    store.scheduleContinuation({ threadId: "t-2", kind: "quit-resume", dueAt: 100 });
    expect(store.claimDueContinuations(200)).toHaveLength(1);
    // The process died holding the claim.
    store.close();
    store = reopenStore();
    store.releaseOrphanedContinuationClaims();
    expect(store.claimDueContinuations(200)).toHaveLength(1);
  });

  test("unclaimed rows are cancelled for a thread, claimed ones are not", () => {
    const store = freshStore();
    seedThread(store, "t-3");
    const due = store.scheduleContinuation({ threadId: "t-3", kind: "quit-resume", dueAt: 1 });
    store.scheduleContinuation({ threadId: "t-3", kind: "quit-resume", dueAt: 1_000_000 });
    const [claimed] = store.claimDueContinuations(10);
    expect(claimed).toBeDefined();
    expect(claimed?.continuationId).toBe(due?.continuationId);

    expect(store.cancelContinuationsForThread("t-3")).toBe(1);
    const left = store.listContinuationsForThread("t-3");
    expect(left.map((r) => r.continuationId)).toEqual([claimed?.continuationId]);
  });

  test("nextDueAt reads the earliest unclaimed due time", () => {
    const store = freshStore();
    seedThread(store, "t-4");
    expect(store.nextContinuationDueAt()).toBeNull();
    store.scheduleContinuation({ threadId: "t-4", kind: "quit-resume", dueAt: 500 });
    store.scheduleContinuation({ threadId: "t-4", kind: "quit-resume", dueAt: 200 });
    expect(store.nextContinuationDueAt()).toBe(200);
    // Claiming the earliest leaves the later one.
    store.claimDueContinuations(500);
    expect(store.nextContinuationDueAt()).toBeNull();
  });

  test("deleting a continuation removes it", () => {
    const store = freshStore();
    seedThread(store, "t-5");
    const row = store.scheduleContinuation({ threadId: "t-5", kind: "quit-resume", dueAt: 1 });
    store.deleteContinuation(row!.continuationId);
    expect(store.listContinuationsForThread("t-5")).toEqual([]);
  });
});
