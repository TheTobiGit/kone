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

import { acceptProviderThreadTitle, truncateThreadTitle } from "./threadTitle.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-thread-title-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "cursor", at, source: "kone.store", turnId };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.completed", threadId, provider: "cursor", at, source: "kone.store", turnId };
}

function turnAborted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return {
    type: "turn.aborted",
    threadId,
    provider: "cursor",
    at,
    source: "kone.store",
    turnId,
    reason: "interrupted",
  };
}

function textItem(
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "cursor",
    at: 10,
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
}

// The IPC broadcast choke point accepts a provider-proposed title only while
// no turn has settled yet; an accepted proposal is persisted through the
// rename path so the store and the UI agree.
describe("acceptProviderThreadTitle", () => {
  test("a new thread on its word-cap fallback accepts the provider's title", () => {
    // The case the title-text guard got wrong: the thread already sits on the
    // fallback ("hello"), but nothing has answered yet, so the provider named
    // itself from the user's actual first message.
    expect(
      acceptProviderThreadTitle({ hasSettledTurn: false, proposedTitle: "Saying hello" }),
    ).toBe("Saying hello");
  });

  test("drops a bootstrap-derived proposal once a turn has settled", () => {
    // The hand-in repro: the thread was answered before, so the new
    // provider's "first prompt" was the replay bootstrap, not the
    // conversation — its proposal names the bootstrap.
    expect(
      acceptProviderThreadTitle({ hasSettledTurn: true, proposedTitle: "Kone Host Context" }),
    ).toBeNull();
  });

  test("drops re-naming on later turns whatever the stored title is", () => {
    expect(
      acceptProviderThreadTitle({ hasSettledTurn: true, proposedTitle: "Something nicer" }),
    ).toBeNull();
  });

  test("drops a proposal that carries no title", () => {
    expect(acceptProviderThreadTitle({ hasSettledTurn: false, proposedTitle: "" })).toBeNull();
    expect(acceptProviderThreadTitle({ hasSettledTurn: false, proposedTitle: "   " })).toBeNull();
  });

  test("cleans an accepted proposal the way the rename path does", () => {
    const long = `word ${"x".repeat(200)}`;
    expect(acceptProviderThreadTitle({ hasSettledTurn: false, proposedTitle: long })).toBe(
      truncateThreadTitle(long),
    );
    expect(
      acceptProviderThreadTitle({ hasSettledTurn: false, proposedTitle: "  padded title  " }),
    ).toBe("padded title");
  });
});

describe("hasSettledAssistantTurn", () => {
  test("false on a thread with no turns at all", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-empty", projectPath: "/p", provider: "cursor" });
    expect(store.hasSettledAssistantTurn("t-empty")).toBe(false);
  });

  test("false while the first turn is still running", async () => {
    // The running turn's own assistant block already exists here — presence
    // alone cannot tell a first turn from a later one, which is why the guard
    // reads settled state rather than hasNativeAssistantTurn.
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-running", projectPath: "/p", provider: "cursor" });
    store.recordUserBlock({ threadId: "t-running", text: "hello", at: 100 });
    expect(store.hasSettledAssistantTurn("t-running")).toBe(false);
    store.applyEvent(turnStarted("t-running", "turn-1", 110));
    expect(store.hasSettledAssistantTurn("t-running")).toBe(false);
  });

  test("true once the first turn settles", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-done", projectPath: "/p", provider: "cursor" });
    store.recordUserBlock({ threadId: "t-done", text: "hello", at: 100 });
    store.applyEvent(turnStarted("t-done", "turn-1", 110));
    store.applyEvent(turnCompleted("t-done", "turn-1", 150));
    expect(store.hasSettledAssistantTurn("t-done")).toBe(true);
  });

  test("true after an aborted turn too — it still answered", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-aborted", projectPath: "/p", provider: "cursor" });
    store.recordUserBlock({ threadId: "t-aborted", text: "hello", at: 100 });
    store.applyEvent(turnStarted("t-aborted", "turn-1", 110));
    store.applyEvent(turnAborted("t-aborted", "turn-1", 150));
    expect(store.hasSettledAssistantTurn("t-aborted")).toBe(true);
  });

  test("an accepted proposal persists through the rename path", async () => {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-new", projectPath: "/p", provider: "cursor" });
    store.setTitle("t-new", "hello");
    store.recordUserBlock({ threadId: "t-new", text: "hello", at: 100 });
    store.applyEvent(turnStarted("t-new", "turn-1", 110));
    const accepted = acceptProviderThreadTitle({
      hasSettledTurn: store.hasSettledAssistantTurn("t-new"),
      proposedTitle: "Saying hello",
    });
    expect(accepted).toBe("Saying hello");
    if (accepted) store.renameThread("t-new", accepted);
    expect(store.getTitle("t-new")).toBe("Saying hello");
  });
});

describe("provider titles on forked threads", () => {
  /** A source thread with two settled exchanges and caller-chosen user block ids. */
  async function seedSource() {
    const { getConversationStore } = await import("./ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-src", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.setTitle("t-src", "Fix the leak");
    store.recordUserBlock({ blockId: "u-1", threadId: "t-src", text: "first question", at: 100 });
    store.applyEvent(turnStarted("t-src", "turn-1", 110));
    store.applyEvent(textItem("t-src", "turn-1", "i-1", "first answer"));
    store.applyEvent(turnCompleted("t-src", "turn-1", 150));
    store.recordUserBlock({ blockId: "u-2", threadId: "t-src", text: "second question", at: 200 });
    store.applyEvent(turnStarted("t-src", "turn-2", 210));
    store.applyEvent(textItem("t-src", "turn-2", "i-2", "second answer"));
    store.applyEvent(turnCompleted("t-src", "turn-2", 250));
    return store;
  }

  test("a handoff thread rejects the bootstrap-derived title on its first turn", async () => {
    const store = await seedSource();
    const { createHandoffThread } = await import("./handoff.js");
    const result = createHandoffThread({
      requestId: "r-h1",
      threadId: "h-1",
      sourceThreadId: "t-src",
      target: { provider: "cursor" },
    });
    expect(result.status).toBe("created");
    // The whole transcript is imported history, settled by construction.
    expect(store.hasSettledAssistantTurn("h-1")).toBe(true);
    // The handoff's first turn runs the bootstrap replay; the provider names
    // itself from that replay, so its proposal must not land.
    store.recordUserBlock({ threadId: "h-1", text: "carry on", at: 300 });
    store.applyEvent(turnStarted("h-1", "turn-h1", 310));
    expect(
      acceptProviderThreadTitle({
        hasSettledTurn: store.hasSettledAssistantTurn("h-1"),
        proposedTitle: "Kone Host Context",
      }),
    ).toBeNull();
    expect(store.getTitle("h-1")).toBe("Fix the leak");
  });

  test("a branch thread rejects the bootstrap-derived title on its first turn", async () => {
    const store = await seedSource();
    const { createHandoffThread } = await import("./handoff.js");
    const result = createHandoffThread({
      requestId: "r-b1",
      threadId: "b-1",
      sourceThreadId: "t-src",
      throughBlockId: "u-2",
      target: { provider: "cursor" },
    });
    expect(result.status).toBe("created");
    expect(store.threadMeta("b-1")?.forkContext).toMatchObject({ forkKind: "branch" });
    // The import is cut at the second question but still carries the first
    // exchange's settled answer, which is what counts.
    expect(store.hasSettledAssistantTurn("b-1")).toBe(true);
    store.recordUserBlock({ threadId: "b-1", text: "take it from here", at: 300 });
    store.applyEvent(turnStarted("b-1", "turn-b1", 310));
    expect(
      acceptProviderThreadTitle({
        hasSettledTurn: store.hasSettledAssistantTurn("b-1"),
        proposedTitle: "Kone Host Context",
      }),
    ).toBeNull();
  });
});
