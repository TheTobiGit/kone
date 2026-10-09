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
import { createRegistry, type GatewayToolContext, type GatewayToolResult } from "../registry.js";
import { createAppForkTools, type AppForkToolOptions } from "./appForks.js";

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

// Production stamps these tools with target "assistant" (gateway/index.ts),
// which strips structuredContent: the text is what the model reads. Every
// test below goes through that mapping, so it asserts what the assistant
// actually sees.
function assistantRegistry(options?: AppForkToolOptions) {
  return createRegistry(
    createAppForkTools(options ?? {}).map((tool) => ({ ...tool, target: "assistant" as const })),
  );
}

function text(result: GatewayToolResult): string {
  return result.content.map((part) => part.text).join("\n");
}

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

async function seedRunningSource() {
  const { getConversationStore } = await import("../../ConversationStore.js");
  const store = getConversationStore();
  store.ensureThread({ threadId: "t-run", projectPath: "/p", provider: "codex", model: "gpt-x" });
  store.recordUserBlock({ threadId: "t-run", text: "go", at: 1 });
  store.applyEvent(turnStarted("t-run", "turn-1", 2));
  return store;
}

describe("app_fork_thread (assistant text)", () => {
  test("the success text carries the new thread id and where it opens", async () => {
    await seedSource();
    const registry = assistantRegistry({ newThreadId: () => "f-1" });
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      requestId: "r-1",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    const body = text(result);
    expect(body).toContain("Thread id: f-1");
    expect(body).toContain("t-src");
    expect(body).toContain("turn-1");
    expect(body).toContain("codex");
  });

  test("a replayed creation says the thread already exists and names it", async () => {
    await seedSource();
    const registry = assistantRegistry();
    const first = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      threadId: "f-1",
      requestId: "r-1",
    });
    expect(first.isError).toBeUndefined();
    const second = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      threadId: "f-1",
      requestId: "r-2",
    });
    expect(second.isError).toBeUndefined();
    expect(second.structuredContent).toBeUndefined();
    const body = text(second);
    expect(body).toContain("already exists");
    expect(body).toContain("Thread id: f-1");
  });

  test("refuses a rolled-back turn as isError text naming the reason", async () => {
    const store = await seedSource();
    store.markTurnsRolledBack("t-src", "turn-1");
    const registry = assistantRegistry({ newThreadId: () => "f-2" });
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "turn-1",
      requestId: "r-2",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const body = text(result);
    expect(body).toContain("invalid_input");
    expect(body).toContain("rolled back");
  });

  test("refuses a running source as isError text naming the reason", async () => {
    await seedRunningSource();
    const registry = assistantRegistry({ newThreadId: () => "f-3" });
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-run",
      turnId: "turn-1",
      requestId: "r-3",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const body = text(result);
    expect(body).toContain("invalid_input");
    expect(body).toContain("still running");
  });

  test("refuses an unknown source as isError text naming the reason", async () => {
    const registry = assistantRegistry({ newThreadId: () => "f-4" });
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "ghost",
      turnId: "turn-1",
      requestId: "r-4",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    const body = text(result);
    expect(body).toContain("invalid_input");
    expect(body).toContain("ghost");
  });

  test("refuses a turn that is not part of the source as isError text", async () => {
    await seedSource();
    const registry = assistantRegistry({ newThreadId: () => "f-5" });
    const result = await registry.call(ctx, "app_fork_thread", {
      sourceThreadId: "t-src",
      turnId: "ghost-turn",
      requestId: "r-5",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain("not part of this conversation");
  });
});

describe("app_merge_back (assistant text)", () => {
  test("the success text carries both thread ids and the timeline block id", async () => {
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
    const registry = assistantRegistry({ emit: (e) => emitted.push(e) });
    const result = await registry.call(ctx, "app_merge_back", {
      sourceThreadId: "t-src",
      forkThreadId: "f-merge",
    });
    expect(result.isError).toBeUndefined();
    expect(result.structuredContent).toBeUndefined();
    const body = text(result);
    expect(body).toContain("f-merge");
    expect(body).toContain("t-src");
    expect(body).toContain("Block id:");
    expect(emitted.some((e) => e.type === "thread.message-journaled")).toBe(true);
    const source = store.loadThread("t-src")!;
    const last = source.blocks.at(-1)!;
    expect(last.role).toBe("user");
    if (last.role === "user") {
      expect(last.sender).toEqual({ kind: "system" });
      expect(last.text).toContain("the fork found X");
      expect(body).toContain(last.id);
    }
  });

  test("refuses a fork that came from another source as isError text", async () => {
    const store = await seedSource();
    store.ensureThread({ threadId: "t-other", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "t-other", text: "other", at: 1 });
    store.applyEvent(turnStarted("t-other", "turn-1", 2));
    store.applyEvent(textItem("t-other", "turn-1", "i-9", "other answer"));
    store.applyEvent(turnCompleted("t-other", "turn-1", 5));
    const { forkThreadAtTurn } = await import("../../threadFork.js");
    forkThreadAtTurn({
      requestId: "r-other",
      threadId: "f-other",
      sourceThreadId: "t-other",
      turnId: "turn-1",
      userBlockId: null,
    });
    const registry = assistantRegistry();
    const result = await registry.call(ctx, "app_merge_back", {
      sourceThreadId: "t-src",
      forkThreadId: "f-other",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain("was not forked from");
  });

  test("refuses an unknown fork as isError text naming it", async () => {
    await seedSource();
    const registry = assistantRegistry();
    const result = await registry.call(ctx, "app_merge_back", {
      sourceThreadId: "t-src",
      forkThreadId: "ghost-fork",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain("ghost-fork");
  });

  test("refuses an unknown source as isError text naming it", async () => {
    await seedSource();
    const { forkThreadAtTurn } = await import("../../threadFork.js");
    forkThreadAtTurn({
      requestId: "r-fork2",
      threadId: "f-merge2",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    const registry = assistantRegistry();
    const result = await registry.call(ctx, "app_merge_back", {
      sourceThreadId: "ghost-src",
      forkThreadId: "f-merge2",
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toBeUndefined();
    expect(text(result)).toContain("ghost-src");
  });
});
