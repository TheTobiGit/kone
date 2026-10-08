import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
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
import type { RuntimeEvent, StoredBlock } from "./types.js";

const { forkThreadAtTurn, resolveTurnCutBlock, sourceThreadRunning } = await import("./threadFork.js");

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-fork-test-"));
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

/** A thread with two settled turns on codex/gpt-x. */
async function seedTwoTurns(threadId = "t-src") {
  const { getConversationStore } = await import("./ConversationStore.js");
  const store = getConversationStore();
  store.ensureThread({ threadId, projectPath: "/p", provider: "codex", model: "gpt-x" });
  store.setTitle(threadId, "Fix the leak");
  store.recordUserBlock({ threadId, text: "first question", at: 100 });
  store.applyEvent(turnStarted(threadId, "turn-1", 110));
  store.applyEvent(textItem(threadId, "turn-1", "i-1", "first answer"));
  store.applyEvent(turnCompleted(threadId, "turn-1", 150));
  store.recordUserBlock({ threadId, text: "second question", at: 200 });
  store.applyEvent(turnStarted(threadId, "turn-2", 210));
  store.applyEvent(textItem(threadId, "turn-2", "i-2", "second answer"));
  store.applyEvent(turnCompleted(threadId, "turn-2", 250));
  return store;
}

describe("resolveTurnCutBlock", () => {
  const user = (id: string): StoredBlock => ({ id, role: "user", text: "q", at: 1 });
  const assistant = (id: string, turnId: string): StoredBlock => ({
    id,
    role: "assistant",
    turnId,
    items: [],
    state: "completed",
    at: 2,
  });

  test("cuts at the turn's last assistant block", () => {
    const blocks = [user("u1"), assistant("a1", "t1"), user("u2"), assistant("a2", "t2")];
    expect(resolveTurnCutBlock(blocks, "t1", "u1")).toBe("a1");
    expect(resolveTurnCutBlock(blocks, "t2", "u2")).toBe("a2");
  });

  test("falls back to the prompt block when the turn produced no answer", () => {
    const blocks = [user("u1"), user("u2")];
    expect(resolveTurnCutBlock(blocks, "t9", "u2")).toBe("u2");
    expect(resolveTurnCutBlock(blocks, "t9", null)).toBeNull();
  });
});

describe("sourceThreadRunning", () => {
  test("is true while a turn's assistant block is running", () => {
    const blocks: StoredBlock[] = [
      { id: "u", role: "user", text: "q", at: 1 },
      { id: "a", role: "assistant", turnId: "t", items: [], state: "running", at: 2 },
    ];
    expect(sourceThreadRunning(blocks)).toBe(true);
    expect(sourceThreadRunning([{ id: "u", role: "user", text: "q", at: 1 }])).toBe(false);
  });
});

describe("markTurnsRolledBack", () => {
  test("stamps the chosen turn and every later turn", async () => {
    const store = await seedTwoTurns();
    const stamped = store.markTurnsRolledBack("t-src", "turn-1", 999);
    expect(stamped.sort()).toEqual(["turn-1", "turn-2"]);
    expect(store.isTurnRolledBack("t-src", "turn-1")).toBe(true);
    expect(store.isTurnRolledBack("t-src", "turn-2")).toBe(true);
    expect(store.rolledBackTurnIds("t-src")).toEqual(new Set(["turn-1", "turn-2"]));
  });

  test("from the last turn stamps only that turn", async () => {
    const store = await seedTwoTurns();
    expect(store.markTurnsRolledBack("t-src", "turn-2")).toEqual(["turn-2"]);
    expect(store.isTurnRolledBack("t-src", "turn-1")).toBe(false);
    expect(store.isTurnRolledBack("t-src", "turn-2")).toBe(true);
  });

  test("an unknown boundary turn stamps nothing", async () => {
    const store = await seedTwoTurns();
    expect(store.markTurnsRolledBack("t-src", "nope")).toEqual([]);
  });
});

describe("forkThreadAtTurn", () => {
  test("forks a branch from the chosen turn's end, with the source as placeholder", async () => {
    const store = await seedTwoTurns();
    const result = forkThreadAtTurn({
      requestId: "r1",
      threadId: "f-1",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    expect(result.status).toBe("created");
    expect(result.provider).toBe("codex");
    expect(result.model).toBe("gpt-x");

    const fork = store.loadThread("f-1")!;
    // The import stops at turn 1's answer — turn 2 never happened here.
    expect(fork.blocks.map((b) => b.role)).toEqual(["user", "assistant"]);
    const [prompt, answer] = fork.blocks;
    if (prompt?.role !== "user" || answer?.role !== "assistant") {
      throw new Error("expected an imported user then assistant block");
    }
    expect(prompt.text).toBe("first question");
    expect(answer.items.map((item) => item.text).join("")).toContain("first answer");
    expect(store.threadForkContext("f-1")?.forkKind).toBe("branch");
    // No provider session was started: no conversation id was carried.
    expect(store.threadMeta("f-1")?.conversationId).toBeUndefined();
  });

  test("refuses a source with a running turn", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-run", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.recordUserBlock({ threadId: "t-run", text: "go", at: 1 });
    store.applyEvent(turnStarted("t-run", "turn-1", 2));
    expect(() =>
      forkThreadAtTurn({
        requestId: "r2",
        threadId: "f-2",
        sourceThreadId: "t-run",
        turnId: "turn-1",
        userBlockId: null,
      }),
    ).toThrow(/still running/);
  });

  test("refuses a turn that was rolled back", async () => {
    const store = await seedTwoTurns();
    store.markTurnsRolledBack("t-src", "turn-1");
    expect(() =>
      forkThreadAtTurn({
        requestId: "r3",
        threadId: "f-3",
        sourceThreadId: "t-src",
        turnId: "turn-1",
        userBlockId: null,
      }),
    ).toThrow(/rolled back/);
  });

  test("refuses a turn that is not part of the source", async () => {
    await seedTwoTurns();
    expect(() =>
      forkThreadAtTurn({
        requestId: "r4",
        threadId: "f-4",
        sourceThreadId: "t-src",
        turnId: "ghost-turn",
        userBlockId: null,
      }),
    ).toThrow(/not part of this conversation/);
  });

  test("the placeholder provider is replaced by the first send while no session exists", async () => {
    const store = await seedTwoTurns();
    forkThreadAtTurn({
      requestId: "r5",
      threadId: "f-5",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    // The placeholder is the source's provider/model, and no session exists.
    expect(store.threadMeta("f-5")?.provider).toBe("codex");
    expect(store.threadMeta("f-5")?.model).toBe("gpt-x");
    expect(store.threadMeta("f-5")?.conversationId).toBeUndefined();
    // Nothing has claimed it as a hand-in or a continuation commitment.
    expect(store.handInsForThread("f-5")).toEqual([]);
    expect(store.continuationsFromSource("t-src").map((link) => link.threadId)).toEqual(["f-5"]);

    // The first send registers its session with the chosen provider — the
    // placeholder is overwritten, not treated as a commitment.
    store.ensureThread({
      threadId: "f-5",
      projectPath: "/p",
      provider: "claudeAgent",
      model: "claude-sonnet-5",
    });
    expect(store.threadMeta("f-5")?.provider).toBe("claudeAgent");
    expect(store.threadMeta("f-5")?.model).toBe("claude-sonnet-5");
  });
});
