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
import type { RuntimeEvent } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-handoff-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "opencode", at, source: "kone.store", turnId };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.completed", threadId, provider: "opencode", at, source: "kone.store", turnId };
}

function textItem(threadId: string, turnId: string, itemId: string, text: string): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "opencode",
    at: 10,
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
}

/** A two-exchange source thread. */
async function seedSource(threadId = "t-src") {
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

describe("createHandoffThread", () => {
  test("hands the full transcript to the target provider, keeping the title", async () => {
    await seedSource();
    const { createHandoffThread } = await import("./handoff.js");
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();

    const result = createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });
    expect(result.status).toBe("created");
    expect(result.provider).toBe("claudeAgent");
    expect(result.model).toBe("claude-sonnet-5");

    const handoff = store.loadThread("h-1");
    expect(handoff).not.toBeNull();
    expect(handoff!.title).toBe("Fix the leak");
    expect(handoff!.provider).toBe("claudeAgent");
    // Full transcript, not a prefix: both exchanges, in order.
    expect(handoff!.blocks.map((b) => (b.role === "user" ? b.text : "[assistant]"))).toEqual([
      "first question",
      "[assistant]",
      "second question",
      "[assistant]",
    ]);
    // Every imported row reads as an import, with its original timestamps
    // (assistant rows carry their turn's `at`, like the source).
    for (const block of handoff!.blocks) {
      expect(block.source).toBe("fork-import");
    }
    expect(handoff!.blocks.map((b) => b.at)).toEqual([100, 110, 200, 210]);

    const meta = store.threadMeta("h-1");
    expect(meta?.sourceThreadId).toBe("t-src");
    expect(meta?.parentThreadId).toBeUndefined();
    expect(meta?.forkContext).toMatchObject({
      sourceThreadId: "t-src",
      bootstrapStatus: "pending",
      forkKind: "handoff",
      sourceProvider: "codex",
      sourceModel: "gpt-x",
    });
  });

  test("replay with the same thread id resolves exists; request id conflict throws", async () => {
    await seedSource();
    const { createHandoffThread } = await import("./handoff.js");

    const first = createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent" },
    });
    expect(first.status).toBe("created");

    const replay = createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent" },
    });
    expect(replay).toMatchObject({ status: "exists", threadId: "h-1" });

    expect(() =>
      createHandoffThread({
        requestId: "r-1",
        threadId: "h-2",
        sourceThreadId: "t-src",
        target: { provider: "claudeAgent" },
      }),
    ).toThrow(/Idempotency conflict/);
  });

  test("many handoffs may leave one source", async () => {
    await seedSource();
    const { createHandoffThread } = await import("./handoff.js");

    const a = createHandoffThread({
      requestId: "r-a",
      threadId: "h-a",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent" },
    });
    const b = createHandoffThread({
      requestId: "r-b",
      threadId: "h-b",
      sourceThreadId: "t-src",
      target: { provider: "opencode" },
    });
    expect(a.status).toBe("created");
    expect(b.status).toBe("created");
  });

  test("refuses an unknown source, an empty source, and a target identical to the source", async () => {
    const { createHandoffThread } = await import("./handoff.js");
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "empty", projectPath: "/p", provider: "codex" });
    await seedSource();

    expect(() =>
      createHandoffThread({
        requestId: "r-x",
        threadId: "h-x",
        sourceThreadId: "missing",
        target: { provider: "claudeAgent" },
      }),
    ).toThrow(/not found/);
    expect(() =>
      createHandoffThread({
        requestId: "r-y",
        threadId: "h-y",
        sourceThreadId: "empty",
        target: { provider: "claudeAgent" },
      }),
    ).toThrow(/no conversation/);
    expect(() =>
      createHandoffThread({
        requestId: "r-z",
        threadId: "h-z",
        sourceThreadId: "t-src",
        target: { provider: "codex", model: "gpt-x" },
      }),
    ).toThrow(/different provider or model/);
  });

  test("a handoff must run a native turn before it can itself be handed off", async () => {
    await seedSource();
    const { createHandoffThread, handoffEligibility } = await import("./handoff.js");
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();

    createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent" },
    });
    expect(handoffEligibility("h-1").ok).toBe(false);

    // One native turn on the handoff lifts the gate.
    store.recordUserBlock({ threadId: "h-1", text: "follow-up", at: 300 });
    store.applyEvent(turnStarted("h-1", "turn-3", 310));
    store.applyEvent(textItem("h-1", "turn-3", "i-3", "third answer"));
    store.applyEvent(turnCompleted("h-1", "turn-3", 350));
    expect(handoffEligibility("h-1").ok).toBe(true);

    const again = createHandoffThread({
      requestId: "r-2",
      threadId: "h-2",
      sourceThreadId: "h-1",
      target: { provider: "opencode" },
    });
    expect(again.status).toBe("created");
    // The chain accumulates: the grandparent import plus the native turn.
    const chain = store.loadThread("h-2");
    expect(chain!.blocks.length).toBeGreaterThan(4);
  });

  test("the first turn carries the handoff bootstrap exactly once", async () => {    await seedSource();
    const { createHandoffThread, HANDOFF_INTRO, HANDOFF_BOUNDARY_INSTRUCTION } =
      await import("./handoff.js");
    const { sidechatBootstrapForTurn } = await import("./sidechat.js");
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();

    createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent" },
    });

    const preamble = sidechatBootstrapForTurn("h-1", "carry on");
    expect(preamble).toContain(HANDOFF_INTRO);
    expect(preamble).toContain(HANDOFF_BOUNDARY_INSTRUCTION);
    expect(preamble).toContain("first question");
    expect(preamble).toContain("<latest_user_message>\ncarry on\n</latest_user_message>");

    // Settling the first turn consumes the bootstrap — it never runs twice.
    store.recordUserBlock({ threadId: "h-1", text: "carry on", at: 300 });
    store.applyEvent(turnStarted("h-1", "turn-3", 310));
    store.applyEvent(textItem("h-1", "turn-3", "i-3", "on it"));
    store.applyEvent(turnCompleted("h-1", "turn-3", 350));
    expect(store.threadForkContext("h-1")?.bootstrapStatus).toBe("completed");
    expect(sidechatBootstrapForTurn("h-1", "again")).toBeNull();
  });

  test("handoffsFromSource lists only handoffs, oldest first", async () => {
    await seedSource();
    const { createHandoffThread } = await import("./handoff.js");
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();

    createHandoffThread({
      requestId: "r-1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });
    createHandoffThread({
      requestId: "r-2",
      threadId: "h-2",
      sourceThreadId: "t-src",
      target: { provider: "opencode" },
    });
    // A non-handoff fork off the same source must not leak into the markers.
    const [u1] = store
      .loadThread("t-src")!
      .blocks.filter((b) => b.role === "user")
      .map((b) => b.id);
    const forked = store.forkThreadAtBlock({
      threadId: "f-1",
      sourceThreadId: "t-src",
      blockId: u1!,
      editedText: "revised",
      requestId: "r-3",
    });
    expect(forked.ok).toBe(true);

    const links = store.handoffsFromSource("t-src");
    expect(links.map((l) => l.threadId)).toEqual(["h-1", "h-2"]);
    expect(links[0]).toMatchObject({
      provider: "claudeAgent",
      model: "claude-sonnet-5",
      title: "Fix the leak",
    });
    expect(links[0]!.handedAt).toBeGreaterThan(0);
    expect(links[1]).toMatchObject({ provider: "opencode" });
    expect(store.handoffsFromSource("missing")).toEqual([]);
  });
});
