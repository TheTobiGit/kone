import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

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

import { setUserDataDir } from "./userDataDir.js";
import type { RuntimeEvent } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-merge-back-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "codex", at, source: "kone.store", turnId };
}
function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.completed", threadId, provider: "codex", at, source: "kone.store", turnId };
}
function textItem(threadId: string, turnId: string, itemId: string, text: string): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "codex",
    at: 10,
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
}

describe("mergeBackFork", () => {
  test("writes a system-attributed summary of the fork into its source", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const { forkThreadAtTurn } = await import("./threadFork.js");
    const { mergeBackFork } = await import("./mergeBack.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-src", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.recordUserBlock({ threadId: "t-src", text: "first", at: 1 });
    store.applyEvent(turnStarted("t-src", "turn-1", 2));
    store.applyEvent(textItem("t-src", "turn-1", "i-1", "answer"));
    store.applyEvent(turnCompleted("t-src", "turn-1", 5));

    forkThreadAtTurn({
      requestId: "r-merge",
      threadId: "f-1",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    // The fork runs its own turn.
    store.recordUserBlock({ threadId: "f-1", text: "explore", at: 10 });
    store.applyEvent(turnStarted("f-1", "turn-f", 11));
    store.applyEvent(textItem("f-1", "turn-f", "if-1", "the fork found X"));
    store.applyEvent(turnCompleted("f-1", "turn-f", 15));

    const result = mergeBackFork({ sourceThreadId: "t-src", forkThreadId: "f-1" });
    expect(result.block.role).toBe("user");
    expect(result.block.sender).toEqual({ kind: "system" });
    expect(result.block.text).toContain("Merge-back from fork f-1");
    expect(result.block.text).toContain("the fork found X");
  });

  test("refuses a thread that was not forked from the source", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const { forkThreadAtTurn } = await import("./threadFork.js");
    const { mergeBackFork } = await import("./mergeBack.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-a", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.ensureThread({ threadId: "t-c", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.recordUserBlock({ threadId: "t-c", text: "first", at: 1 });
    store.applyEvent(turnStarted("t-c", "turn-1", 2));
    store.applyEvent(textItem("t-c", "turn-1", "i-1", "answer"));
    store.applyEvent(turnCompleted("t-c", "turn-1", 5));
    // t-b is a fork of t-c, so merging it into t-a is refused.
    forkThreadAtTurn({
      requestId: "r-other",
      threadId: "t-b",
      sourceThreadId: "t-c",
      turnId: "turn-1",
      userBlockId: null,
    });
    expect(() => mergeBackFork({ sourceThreadId: "t-a", forkThreadId: "t-b" })).toThrow(
      /not forked from/,
    );
  });
});
