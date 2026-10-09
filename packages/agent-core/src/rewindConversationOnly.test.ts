import { afterAll, afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
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
import type { EmitEvent, ProviderAdapter, RuntimeEvent } from "./types.js";
import type { AgentService as AgentServiceType } from "./AgentService.js";

let tmpDir: string;
let AgentServiceCtor: typeof import("./AgentService.js").AgentService;
let service: AgentServiceType;

/** Minimal adapter stand-in: records dispatched turns so the rewind tests can
 *  prove nothing was sent. Capabilities name no native fork, so rewinds take
 *  the portable branch import. */
class FakeAdapter {
  capabilities = {
    sessionModelSwitch: "unsupported" as const,
    streamsText: false,
    supportsToolEvents: false,
    supportsResume: false,
    supportsModelList: false,
    supportsSubagents: false,
    supportsFork: false,
  };
  static sentTurns: string[] = [];
  constructor(
    public emit: EmitEvent,
    readonly provider: string,
  ) {}
  async stopSession(): Promise<void> {}
  async stopAll(): Promise<void> {}
  setLivenessHook(): void {}
  // eslint-disable-next-line anti-slop/no-unknown-returns
  async discover(): Promise<unknown> {
    return [];
  }
  async listModels(): Promise<unknown[]> {
    return [];
  }
  // eslint-disable-next-line anti-slop/no-unknown-returns
  async startSession(): Promise<unknown> {
    return {};
  }
  async sendTurn(input: { threadId: string }): Promise<{ threadId: string; turnId: string }> {
    FakeAdapter.sentTurns.push(input.threadId);
    return { threadId: input.threadId, turnId: "turn-live" };
  }
  async listSessions(): Promise<unknown[]> {
    return [];
  }
  async hasSession(): Promise<boolean> {
    return false;
  }
}

beforeEach(async () => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-rewind-test-"));
  setUserDataDir(tmpDir);
  AgentServiceCtor = (await import("./AgentService.js")).AgentService;
  FakeAdapter.sentTurns = [];
  service = new AgentServiceCtor({
    retentionSweepMs: 0,
    pullRequestSweepMs: 0,
    wedgeSweepMs: 40,
    wedgeSilenceMs: 30,
    wedgeItemSilenceMs: 200,
    idleSweepMs: 40,
    idleThresholdMs: 50,
    // SAFETY: the fake implements the adapter surface this service reads
    // (provider, capabilities, session lifecycle) for these tests.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    adapters: (emit) =>
      // eslint-disable-next-line anti-slop/no-chained-type-assertions
      [new FakeAdapter(emit, "codex")] as unknown as ProviderAdapter[],
  });
});

afterEach(async () => {
  await service.stopAll();
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

afterAll(async () => {
  await service.stopAll();
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

async function seedSource() {
  const { getConversationStore } = await import("./ConversationStore.js");
  const store = getConversationStore();
  store.ensureThread({ threadId: "t-src", projectPath: "/p", provider: "codex", model: "gpt-x" });
  store.recordUserBlock({ threadId: "t-src", text: "first", at: 1 });
  store.applyEvent(turnStarted("t-src", "turn-1", 2));
  store.applyEvent(textItem("t-src", "turn-1", "i-1", "answer"));
  store.applyEvent(turnCompleted("t-src", "turn-1", 5));
  const prompt = store.loadThread("t-src")!.blocks.find((block) => block.role === "user")!;
  if (prompt.role !== "user") throw new Error("seeded source has no user block");
  return { store, promptId: prompt.id };
}

describe("rewindConversationOnly", () => {
  test("rewinds at the named turn without touching files, sessions, or turns", async () => {
    const { store, promptId } = await seedSource();
    const sourceBlocks = store.loadThread("t-src")!.blocks.length;
    const result = service.rewindConversationOnly({
      requestId: "r-1",
      threadId: "f-1",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: promptId,
    });
    expect(result.status).toBe("created");
    expect(result.threadId).toBe("f-1");
    // The source is untouched: same block count, no rollback stamp.
    expect(store.loadThread("t-src")!.blocks.length).toBe(sourceBlocks);
    expect(store.isTurnRolledBack("t-src", "turn-1")).toBe(false);
    // The fork carries the history through the turn's end.
    const fork = store.loadThread("f-1")!;
    expect(fork.blocks.length).toBeGreaterThan(0);
    // No provider session started and nothing sent: the fork waits for the
    // user's first message.
    expect(store.threadMeta("f-1")?.conversationId).toBeUndefined();
    expect(FakeAdapter.sentTurns).toEqual([]);
    expect(service.hasLiveSession("f-1")).toBe(false);
  });

  test("a null userBlockId cuts at the turn's last assistant block", async () => {
    const { store } = await seedSource();
    const result = service.rewindConversationOnly({
      requestId: "r-2",
      threadId: "f-2",
      sourceThreadId: "t-src",
      turnId: "turn-1",
      userBlockId: null,
    });
    expect(result.status).toBe("created");
    const fork = store.loadThread("f-2")!;
    const texts = fork.blocks
      .filter((block) => block.role === "assistant")
      .flatMap((block) => (block.role === "assistant" ? block.items.map((item) => item.text) : []));
    expect(texts.join("")).toContain("answer");
    expect(FakeAdapter.sentTurns).toEqual([]);
  });

  test("refuses a running source without writing anything", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-run", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.recordUserBlock({ threadId: "t-run", text: "go", at: 1 });
    store.applyEvent(turnStarted("t-run", "turn-1", 2));
    expect(() =>
      service.rewindConversationOnly({
        requestId: "r-3",
        threadId: "f-3",
        sourceThreadId: "t-run",
        turnId: "turn-1",
        userBlockId: null,
      }),
    ).toThrow(/still running/);
    expect(store.threadMeta("f-3")).toBeNull();
  });

  test("refuses a rolled-back turn", async () => {
    const { store } = await seedSource();
    store.markTurnsRolledBack("t-src", "turn-1");
    expect(() =>
      service.rewindConversationOnly({
        requestId: "r-4",
        threadId: "f-4",
        sourceThreadId: "t-src",
        turnId: "turn-1",
        userBlockId: null,
      }),
    ).toThrow(/rolled back/);
  });

  test("refuses an unknown source", async () => {
    expect(() =>
      service.rewindConversationOnly({
        requestId: "r-5",
        threadId: "f-5",
        sourceThreadId: "ghost",
        turnId: "turn-1",
        userBlockId: null,
      }),
    ).toThrow(/not found/);
  });
});
