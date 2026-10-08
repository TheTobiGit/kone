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
mock.module("../../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

import { setUserDataDir } from "../../userDataDir.js";
import type { RuntimeEvent } from "../../types.js";
import { createRegistry, type GatewayToolContext } from "../registry.js";
import { createAppForkTools } from "./appForks.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-app-forks-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("../../ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

const ctx: GatewayToolContext = {
  threadId: "assistant-1",
  turnId: "turn-1",
  provider: "claudeAgent",
  model: "sonnet",
  cwd: process.cwd(),
  requestId: "req-1",
};

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

async function seedSource() {
  const { getConversationStore } = await import("../../ConversationStore.js");
  const store = getConversationStore();
  store.ensureThread({ threadId: "t-src", projectPath: "/p", provider: "codex", model: "gpt-x" });
  store.recordUserBlock({ threadId: "t-src", text: "first", at: 1 });
  store.applyEvent(turnStarted("t-src", "turn-1", 2));
  store.applyEvent(textItem("t-src", "turn-1", "i-1", "answer"));
  store.applyEvent(turnCompleted("t-src", "turn-1", 5));
  return store;
}

describe("app_fork_thread", () => {
  test("forks a finished turn into a new thread", async () => {
    await seedSource();
    const registry = createRegistry(createAppForkTools({ newThreadId: () => "f-1" }));
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      requestId: "r-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, threadId: "f-1", status: "created" });
  });

  test("refuses a rolled-back turn", async () => {
    const store = await seedSource();
    store.markTurnsRolledBack("t-src", "turn-1");
    const registry = createRegistry(createAppForkTools({ newThreadId: () => "f-2" }));
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      requestId: "r-2",
    });
    expect(result.isError).toBe(true);
    expect(JSON.stringify(result.structuredContent)).toContain("rolled back");
  });
});

describe("app_merge_back", () => {
  test("writes the fork's outcome into the source and emits the timeline event", async () => {
    const store = await seedSource();
    const { forkThreadAtTurn } = await import("../../threadFork.js");
    forkThreadAtTurn({
      requestId: "r-fork",
      threadId: "f-merge",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    store.recordUserBlock({ threadId: "f-merge", text: "explore", at: 10 });
    store.applyEvent(turnStarted("f-merge", "turn-f", 11));
    store.applyEvent(textItem("f-merge", "turn-f", "if-1", "the fork found X"));
    store.applyEvent(turnCompleted("f-merge", "turn-f", 15));

    const emitted: RuntimeEvent[] = [];
    const registry = createRegistry(createAppForkTools({ emit: (e) => emitted.push(e) }));
    const result = await registry.call(ctx, "app_merge_back", {
      sourceThreadId: "t-src",
      forkThreadId: "f-merge",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toMatchObject({ ok: true, sourceThreadId: "t-src" });
    expect(emitted.some((e) => e.type === "thread.message-journaled")).toBe(true);
    const source = store.loadThread("t-src")!;
    const last = source.blocks.at(-1)!;
    expect(last.role).toBe("user");
    if (last.role === "user") {
      expect(last.sender).toEqual({ kind: "system" });
      expect(last.text).toContain("the fork found X");
    }
  });
});
