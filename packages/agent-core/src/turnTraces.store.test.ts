import { beforeAll, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { RuntimeEvent } from "./types.js";

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
let turnTraces: typeof import("./turnTraces.js").turnTraces;

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
  ({ turnTraces } = await import("./turnTraces.js"));
});

function freshStore(): ConversationStoreType {
  setUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-trace-store-test-")));
  return new ConversationStoreCtor();
}

function sessionStarted(
  threadId: string,
  at: number,
  provider: "codex",
  conversationId?: string,
): RuntimeEvent {
  const base = { type: "session.started" as const, threadId, provider, at, source: "kone.store" as const };
  return conversationId ? { ...base, refs: { conversationId } } : base;
}

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "codex", at, source: "kone.store", turnId };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.completed", threadId, provider: "codex", at, source: "kone.store", turnId };
}

function usage(
  threadId: string,
  at: number,
  counts: { input: number; output: number; total: number },
  conversationId?: string,
): RuntimeEvent {
  const base = {
    type: "thread.token-usage.updated" as const,
    threadId,
    provider: "codex" as const,
    at,
    source: "kone.store" as const,
    usage: counts,
  };
  return conversationId ? { ...base, refs: { conversationId } } : base;
}

describe("turnTraces over the real store", () => {
  test("a fresh same-provider session with no hand-in is never subtracted from the old one", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.applyEvent(sessionStarted("t-1", 100, "codex", "session-a"));
    store.applyEvent(turnStarted("t-1", "turn-1", 110));
    store.applyEvent(usage("t-1", 120, { input: 1000, output: 200, total: 1200 }, "session-a"));
    store.applyEvent(turnCompleted("t-1", "turn-1", 130));

    // The provider refused the resume (or this is a fresh start): same
    // provider, same model, no hand-in, and the new counter starts higher
    // than the old one.
    store.applyEvent(sessionStarted("t-1", 140, "codex", "session-b"));
    store.applyEvent(turnStarted("t-1", "turn-2", 150));
    store.applyEvent(usage("t-1", 160, { input: 1800, output: 300, total: 2100 }, "session-b"));
    store.applyEvent(turnCompleted("t-1", "turn-2", 170));

    expect(store.listTurnUsage("t-1").map((row) => row.usageSessionId)).toEqual([
      "session-a",
      "session-b",
    ]);
    const traces = turnTraces(store, "t-1");
    expect(traces[0]?.inputTokens).toBe(1000);
    expect(traces[1]?.inputTokens).toBe(1800);
    expect(traces[1]?.outputTokens).toBe(300);
    expect(traces[1]?.totalTokens).toBe(2100);
    store.close();
  });

  test("normal cumulative progression inside one session is still a step", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.applyEvent(sessionStarted("t-1", 100, "codex", "session-a"));
    store.applyEvent(turnStarted("t-1", "turn-1", 110));
    store.applyEvent(usage("t-1", 120, { input: 1000, output: 200, total: 1200 }, "session-a"));
    store.applyEvent(turnCompleted("t-1", "turn-1", 130));
    store.applyEvent(turnStarted("t-1", "turn-2", 140));
    store.applyEvent(usage("t-1", 150, { input: 2500, output: 500, total: 3000 }, "session-a"));
    store.applyEvent(turnCompleted("t-1", "turn-2", 160));

    const traces = turnTraces(store, "t-1");
    expect(traces[1]?.inputTokens).toBe(1500);
    expect(traces[1]?.outputTokens).toBe(300);
    expect(traces[1]?.totalTokens).toBe(1800);
    store.close();
  });

  test("same-millisecond rows keep insertion order, and a same-ms hand-in cannot split a session", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.applyEvent(sessionStarted("t-1", 100, "codex", "session-a"));
    // Turn ids deliberately sort opposite to arrival order: only a durable
    // write order can reconstruct the counter.
    store.applyEvent(turnStarted("t-1", "z-first", 100));
    store.applyEvent(usage("t-1", 100, { input: 1000, output: 200, total: 1200 }, "session-a"));
    store.applyEvent(turnStarted("t-1", "a-second", 100));
    store.applyEvent(usage("t-1", 100, { input: 1800, output: 400, total: 2200 }, "session-a"));
    // A legacy marker on the exact same millisecond must not override the
    // session id the rows themselves carry.
    store.writeHandIn({ threadId: "t-1", fromProvider: "codex", toProvider: "codex", at: 100 });

    const traces = turnTraces(store, "t-1");
    expect(traces.map((trace) => trace.turnId)).toEqual(["z-first", "a-second"]);
    expect(traces[0]?.inputTokens).toBe(1000);
    expect(traces[1]?.inputTokens).toBe(800);
    expect(traces[1]?.outputTokens).toBe(200);
    store.close();
  });

  test("a fork keeps the source session boundary and starts its own fresh tally", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "src", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.recordUserBlock({ threadId: "src", blockId: "u-1", text: "first", at: 100 });
    store.applyEvent(sessionStarted("src", 105, "codex", "source-a"));
    store.applyEvent(turnStarted("src", "turn-1", 110));
    store.applyEvent(usage("src", 120, { input: 1000, output: 200, total: 1200 }, "source-a"));
    store.applyEvent(turnCompleted("src", "turn-1", 130));

    store.recordUserBlock({ threadId: "src", blockId: "u-2", text: "second", at: 200 });
    // A second provider session in the source, with no hand-in row.
    store.applyEvent(sessionStarted("src", 205, "codex", "source-b"));
    store.applyEvent(turnStarted("src", "turn-2", 210));
    store.applyEvent(usage("src", 220, { input: 1800, output: 300, total: 2100 }, "source-b"));
    store.applyEvent(turnCompleted("src", "turn-2", 230));

    store.recordUserBlock({ threadId: "src", blockId: "u-3", text: "fork here", at: 300 });
    const fork = store.forkThreadAtBlock({
      threadId: "fork",
      sourceThreadId: "src",
      blockId: "u-3",
      editedText: "edited third question",
      editedAt: 310,
    });
    expect(fork.ok).toBe(true);

    // The copied rows keep the source's session ids, so the fork does not
    // become one imaginary cumulative session at the copy boundary.
    expect(store.listTurnUsage("fork").map((row) => row.usageSessionId)).toEqual([
      "source-a",
      "source-b",
    ]);
    const copied = turnTraces(store, "fork");
    expect(copied[0]?.inputTokens).toBe(1000);
    expect(copied[1]?.inputTokens).toBe(1800);
    expect(copied[1]?.outputTokens).toBe(300);

    // The fork's first own turn is a brand-new native session: never a step
    // from the source's copied counter, even though it starts much higher.
    store.applyEvent(sessionStarted("fork", 400, "codex", "fork-a"));
    store.applyEvent(turnStarted("fork", "fork-turn-1", 410));
    store.applyEvent(usage("fork", 420, { input: 5000, output: 700, total: 5700 }, "fork-a"));
    store.applyEvent(turnCompleted("fork", "fork-turn-1", 430));

    const traces = turnTraces(store, "fork");
    expect(traces.map((trace) => trace.usageSessionId)).toEqual([
      "source-a",
      "source-b",
      "fork-a",
    ]);
    expect(traces[2]?.inputTokens).toBe(5000);
    expect(traces[2]?.outputTokens).toBe(700);
    store.close();
  });

  test("a fork of legacy rows records the source hand-in boundary instead of losing it", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "src", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.recordUserBlock({ threadId: "src", blockId: "u-1", text: "first", at: 100 });
    store.applyEvent(turnStarted("src", "turn-1", 110));
    store.applyEvent(usage("src", 120, { input: 1000, output: 200, total: 1200 }));
    store.applyEvent(turnCompleted("src", "turn-1", 130));
    store.recordUserBlock({ threadId: "src", blockId: "u-2", text: "second", at: 200 });
    store.writeHandIn({ threadId: "src", fromProvider: "codex", toProvider: "codex", at: 205 });
    store.applyEvent(turnStarted("src", "turn-2", 210));
    store.applyEvent(usage("src", 220, { input: 1800, output: 300, total: 2100 }));
    store.applyEvent(turnCompleted("src", "turn-2", 230));
    store.recordUserBlock({ threadId: "src", blockId: "u-3", text: "fork here", at: 300 });

    const fork = store.forkThreadAtBlock({
      threadId: "fork",
      sourceThreadId: "src",
      blockId: "u-3",
      editedText: "edited third question",
      editedAt: 310,
    });
    expect(fork.ok).toBe(true);

    // The fork copies no hand-in rows, so each copied legacy row carries the
    // source boundary it belonged to as an explicit fork-local tally id.
    expect(store.listTurnUsage("fork").map((row) => row.usageSessionId)).toEqual([
      "fork-tally:0",
      "fork-tally:1",
    ]);
    const traces = turnTraces(store, "fork");
    expect(traces[0]?.inputTokens).toBe(1000);
    expect(traces[1]?.inputTokens).toBe(1800);
    expect(traces[1]?.totalTokens).toBe(2100);
    store.close();
  });

  test("legacy rows with no session id keep the old hand-in boundary reading", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex", model: "gpt-5" });
    store.applyEvent(turnStarted("t-1", "turn-1", 110));
    store.applyEvent(usage("t-1", 120, { input: 1000, output: 200, total: 1200 }));
    store.applyEvent(turnCompleted("t-1", "turn-1", 130));
    store.writeHandIn({ threadId: "t-1", fromProvider: "codex", toProvider: "codex", at: 140 });
    store.applyEvent(turnStarted("t-1", "turn-2", 150));
    store.applyEvent(usage("t-1", 160, { input: 1800, output: 300, total: 2100 }));
    store.applyEvent(turnCompleted("t-1", "turn-2", 170));

    expect(store.listTurnUsage("t-1").map((row) => row.usageSessionId)).toEqual([null, null]);
    const traces = turnTraces(store, "t-1");
    expect(traces[1]?.inputTokens).toBe(1800);
    expect(traces[1]?.totalTokens).toBe(2100);
    store.close();
  });
});
