import { describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

// ConversationStore imports node:sqlite (an Electron-runtime built-in this bun
// can't load) — stand it in for bun:sqlite, and point the state dir at a
// throwaway temp dir per test. Same pattern as conversationStore.test.ts.
function useUserDataDir(dir: string): string {
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-editfork-test-")));

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

mock.module("./sqlite.js", () => ({
  DatabaseSync: DatabaseSyncShim,
}));

import type { ChatAttachment, RuntimeEvent } from "./types.js";
import type { ConversationStore } from "./ConversationStore.js";
import {
  buildEditForkTitle,
  findEditLineageRoot,
  parseForkVersion,
  type ForkLineageNode,
} from "./editForkTitle.js";

const { ConversationStore: Store } = await import("./ConversationStore.js");

function freshStore(): ConversationStore {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-editfork-test-")));
  // SAFETY: the dynamic import above binds the real ConversationStore class.
  return new (Store as typeof import("./ConversationStore.js").ConversationStore)();
}

// ── seeds ────────────────────────────────────────────────────────────────────

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

function toolItem(
  threadId: string,
  turnId: string,
  itemId: string,
  name: string,
  text: string,
  detail: string,
): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "opencode",
    at: 10,
    source: "kone.store",
    item: { itemId, kind: "tool_call", status: "completed", text, name, detail },
  };
}

function tokenUsage(threadId: string, at: number, usage: { input: number; output: number; total: number }): RuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    usage,
  };
}

/** A three-exchange source thread with tool calls, a subagent run, per-turn
 *  usage and a compaction marker — everything an edit fork must preserve.
 *  Returns the source's user block ids in order. */
function seedSource(store: ConversationStore, threadId = "t-src"): string[] {
  store.ensureThread({ threadId, projectPath: "/p", provider: "opencode", model: "m1" });
  store.setTitle(threadId, "Fix the leak");
  const attachment: ChatAttachment = {
    type: "file",
    id: "att-1",
    name: "leak.ts",
    mimeType: "text/plain",
    sizeBytes: 12,
  };
  store.recordUserBlock({ threadId, text: "first question", at: 100, attachments: [attachment] });
  store.applyEvent(turnStarted(threadId, "turn-1", 110));
  store.applyEvent(toolItem(threadId, "turn-1", "i-read", "Read", "leak.ts", '{"path":"leak.ts"}'));
  store.applyEvent(textItem(threadId, "turn-1", "i-txt", "did the thing"));
  // SAFETY: the literal is the subagent.completed shape the store journals.
  store.applyEvent({
    type: "subagent.completed",
    threadId,
    turnId: "turn-1",
    provider: "opencode",
    at: 120,
    source: "kone.store",
    subagent: {
      toolUseId: "su-1",
      taskId: "task-1",
      parentItemId: "i-read",
      agentType: "explore",
      description: "find the leak",
      prompt: "find it",
      model: "m1",
      status: "completed",
      summary: "found it",
      tokens: 7,
      toolUses: 2,
      startedAt: 115,
      endedAt: 120,
    },
  } as RuntimeEvent);
  store.applyEvent(turnCompleted(threadId, "turn-1", 150));
  store.applyEvent(tokenUsage(threadId, 151, { input: 10, output: 5, total: 15 }));
  // SAFETY: the literal is the compacted boundary shape under test.
  store.applyEvent({
    type: "thread.state.changed",
    threadId,
    provider: "opencode",
    at: 160,
    source: "kone.store",
    state: "compacted",
    beforeTokens: 1000,
    afterTokens: 200,
  } as RuntimeEvent);
  store.recordUserBlock({ threadId, text: "second question", at: 200 });
  store.applyEvent(turnStarted(threadId, "turn-2", 210));
  store.applyEvent(textItem(threadId, "turn-2", "i-2", "second answer"));
  store.applyEvent(turnCompleted(threadId, "turn-2", 250));
  store.applyEvent(tokenUsage(threadId, 251, { input: 4, output: 6, total: 10 }));
  store.recordUserBlock({ threadId, text: "third question", at: 300 });
  const loaded = store.loadThread(threadId);
  expect(loaded).not.toBeNull();
  return loaded!.blocks.filter((b) => b.role === "user").map((b) => b.id);
}

function userTexts(store: ConversationStore, threadId: string): string[] {
  const loaded = store.loadThread(threadId);
  expect(loaded).not.toBeNull();
  return loaded!.blocks.filter((b) => b.role === "user").map((b) => b.text);
}

// ── forkThreadAtBlock ────────────────────────────────────────────────────────

describe("forkThreadAtBlock", () => {
  test("forking at a middle block copies the prefix exactly and journals the edit", () => {
    const store = freshStore();
    const [u1, u2] = seedSource(store);
    const before = JSON.stringify(store.loadThread("t-src"));

    const forked = store.forkThreadAtBlock({
      threadId: "f-1",
      sourceThreadId: "t-src",
      blockId: u2!,
      editedText: "second question, revised",
      requestId: "r-1",
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.title).toBe("Fix the leak (2)");
    expect(forked.copiedBlocks).toBe(2);

    const fork = store.loadThread("f-1");
    expect(fork).not.toBeNull();
    // Prefix preserved exactly: first prompt (with its attachment chips),
    // then the full first assistant turn.
    expect(fork!.blocks.map((b) => b.role)).toEqual(["user", "assistant", "user"]);
    expect(fork!.blocks[0]).toMatchObject({ role: "user", text: "first question", at: 100 });
    const copiedUser = fork!.blocks[0];
    if (copiedUser.role === "user") {
      expect(copiedUser.attachments).toEqual([
        { type: "file", id: "att-1", name: "leak.ts", mimeType: "text/plain", sizeBytes: 12 },
      ]);
    } else {
      throw new Error("expected the first fork block to be the copied user prompt");
    }
    const copiedAssistant = fork!.blocks[1];
    if (copiedAssistant.role !== "assistant") throw new Error("expected an assistant block second");
    const toolCall = copiedAssistant.items.find((i) => i.kind === "tool_call");
    expect(toolCall).toMatchObject({ name: "Read", text: "leak.ts", detail: '{"path":"leak.ts"}' });
    expect(toolCall?.subagent).toMatchObject({ toolUseId: "su-1", summary: "found it", tokens: 7 });
    expect(copiedAssistant.items.find((i) => i.kind === "assistant_text")?.text).toBe("did the thing");
    // The edited replacement closes the fork, carrying the original's
    // attachments and the new text.
    expect(fork!.blocks[2]).toMatchObject({ role: "user", text: "second question, revised" });
    const edited = fork!.blocks[2];
    if (edited.role !== "user" || edited.id !== forked.editedBlockId) {
      throw new Error("expected the fork to close with the journaled edited block");
    }
    // Nothing after the edit point comes along.
    expect(fork!.blocks.some((b) => b.role === "user" && b.text === "third question")).toBe(false);

    // Lineage: a source pointer plus an edit-kind fork context, no parent
    // edge (the fork is a root, not a spawned child).
    const meta = store.threadMeta("f-1");
    expect(meta?.sourceThreadId).toBe("t-src");
    expect(meta?.parentThreadId).toBeUndefined();
    expect(meta?.forkContext).toMatchObject({
      sourceThreadId: "t-src",
      forkPointBlockId: u2,
      bootstrapStatus: "pending",
      forkKind: "edit",
    });
    expect(meta?.provider).toBe("opencode");
    expect(meta?.model).toBe("m1");

    // Usage + markers follow the prefix: turn-1's audit row and the
    // compaction at 160, but nothing from the dropped future.
    expect(store.listCompactions("f-1")).toEqual([
      { threadId: "f-1", at: 160, beforeTokens: 1000, afterTokens: 200 },
    ]);

    // The source thread is left untouched — same blocks, same title, no fork
    // context of its own.
    expect(JSON.stringify(store.loadThread("t-src"))).toBe(before);
    expect(store.threadMeta("t-src")?.title).toBe("Fix the leak");
    expect(store.threadMeta("t-src")?.forkContext).toBeUndefined();
    expect(userTexts(store, "t-src")).toEqual(["first question", "second question", "third question"]);
    expect(u1).toBeTruthy();
  });

  test("an edit fork carries each request's tier, and the edit inherits the replaced message's", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-e", projectPath: "/p", provider: "opencode" });
    store.recordUserBlock({ threadId: "t-e", text: "first", at: 100, effort: "medium" });
    store.recordUserBlock({ threadId: "t-e", text: "second", at: 200, effort: "high" });
    const source = store.loadThread("t-e")!;
    const second = source.blocks.filter((b) => b.role === "user")[1]!;

    const forked = store.forkThreadAtBlock({
      threadId: "f-e",
      sourceThreadId: "t-e",
      blockId: second.id,
      editedText: "second, revised",
      requestId: "r-e",
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;

    const fork = store.loadThread("f-e")!;
    const users = fork.blocks.filter((b) => b.role === "user");
    expect(users.map((b) => (b.role === "user" ? b.effort : undefined))).toEqual([
      "medium",
      "high",
    ]);
  });

  test("forking at the first block yields just the edited message", () => {
    const store = freshStore();
    const [u1] = seedSource(store);
    const forked = store.forkThreadAtBlock({
      threadId: "f-first",
      sourceThreadId: "t-src",
      blockId: u1!,
      editedText: "start over, better",
      requestId: "r-first",
    });
    expect(forked.ok).toBe(true);
    if (!forked.ok) return;
    expect(forked.copiedBlocks).toBe(0);
    expect(forked.title).toBe("Fix the leak (2)");
    const fork = store.loadThread("f-first");
    expect(fork!.blocks.map((b) => (b.role === "user" ? b.text : "[assistant]"))).toEqual([
      "start over, better",
    ]);
    // No history to replay: the bootstrap has nothing to hand over, so the
    // first turn sends the message unchanged.
    expect(store.threadForkContext("f-first")?.bootstrapStatus).toBe("pending");
  });

  test("titles version over the whole lineage, not the immediate parent", () => {
    const store = freshStore();
    const [u1, u2, u3] = seedSource(store);
    const first = store.forkThreadAtBlock({
      threadId: "f-1",
      sourceThreadId: "t-src",
      blockId: u2!,
      editedText: "edit one",
      requestId: "r-1",
    });
    expect(first.ok && first.title).toBe("Fix the leak (2)");
    // A second fork of the same source advances past the first, even though
    // both share the immediate parent.
    const second = store.forkThreadAtBlock({
      threadId: "f-2",
      sourceThreadId: "t-src",
      blockId: u3!,
      editedText: "edit two",
      requestId: "r-2",
    });
    expect(second.ok && second.title).toBe("Fix the leak (3)");
    // And a fork of a fork keeps counting: the family is the whole root tree.
    const nested = store.forkThreadAtBlock({
      threadId: "f-3",
      sourceThreadId: "f-1",
      blockId: ((): string => {
        const loaded = store.loadThread("f-1");
        const lastUser = loaded!.blocks.filter((b) => b.role === "user").pop();
        if (!lastUser || lastUser.role !== "user") throw new Error("nested fork needs a user block");
        return lastUser.id;
      })(),
      editedText: "edit three",
      requestId: "r-3",
    });
    expect(nested.ok && nested.title).toBe("Fix the leak (4)");
    expect(u1).toBeTruthy();
  });

  test("refusals leave the source untouched", () => {
    const store = freshStore();
    const [u1, u2] = seedSource(store);
    const before = JSON.stringify(store.loadThread("t-src"));
    expect(store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "missing", blockId: u1!, editedText: "e", requestId: "r" })).toEqual({
      ok: false,
      reason: "unknown-thread",
    });
    expect(store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "t-src", blockId: "missing", editedText: "e", requestId: "r" })).toEqual({
      ok: false,
      reason: "unknown-block",
    });
    expect(store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "t-src", blockId: u1!, editedText: "   ", requestId: "r" })).toEqual({
      ok: false,
      reason: "empty-edit",
    });
    // An assistant block is not an editable message.
    const assistantId = store.loadThread("t-src")!.blocks[1]!.id;
    expect(store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "t-src", blockId: assistantId, editedText: "e", requestId: "r" })).toEqual({
      ok: false,
      reason: "not-user-block",
    });
    // Replaying the same fork id resolves as already-created.
    const created = store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "t-src", blockId: u2!, editedText: "e", requestId: "r" });
    expect(created.ok).toBe(true);
    expect(store.forkThreadAtBlock({ threadId: "f-x", sourceThreadId: "t-src", blockId: u2!, editedText: "e", requestId: "r" })).toEqual({
      ok: false,
      reason: "thread-exists",
    });
    expect(JSON.stringify(store.loadThread("t-src"))).toBe(before);
  });

  test("a queued-but-unrun prompt refuses instead of becoming answered history", () => {
    const store = freshStore();
    const [u1] = seedSource(store);
    store.enqueueQueuedTurn({
      queueId: "q-1",
      threadId: "t-src",
      userBlockId: u1!,
      input: "first question",
    });
    const before = JSON.stringify(store.loadThread("t-src"));
    expect(
      store.forkThreadAtBlock({ threadId: "f-q", sourceThreadId: "t-src", blockId: u1!, editedText: "e", requestId: "r" }),
    ).toEqual({ ok: false, reason: "queued-turn" });
    expect(JSON.stringify(store.loadThread("t-src"))).toBe(before);
    expect(store.loadThread("f-q")).toBeNull();
  });

  test("the fork pages like any thread (keyset cursor survives the copy)", () => {
    const store = freshStore();
    const [, u2] = seedSource(store);
    const forked = store.forkThreadAtBlock({
      threadId: "f-page",
      sourceThreadId: "t-src",
      blockId: u2!,
      editedText: "second question, revised",
      requestId: "r-page",
    });
    expect(forked.ok).toBe(true);
    // Two user blocks in the fork: page with a one-prompt window and walk.
    const first = store.loadThreadPage("f-page", { limit: 1 });
    expect(first).not.toBeNull();
    expect(first!.blocks.filter((b) => b.role === "user").map((b) => b.text)).toEqual([
      "second question, revised",
    ]);
    expect(first!.hasMore).toBe(true);
    expect(first!.nextCursor).not.toBeNull();
    const second = store.loadThreadPage("f-page", { limit: 1, cursor: first!.nextCursor! });
    expect(second).not.toBeNull();
    expect(second!.blocks.filter((b) => b.role === "user").map((b) => b.text)).toEqual([
      "first question",
    ]);
    expect(second!.hasMore).toBe(false);
  });
});

// ── pure lineage helpers ─────────────────────────────────────────────────────

function node(
  id: string,
  overrides?: Partial<{ projectPath: string; title: string | null; sourceThreadId: string | null }>,
): ForkLineageNode {
  return {
    id,
    projectPath: overrides?.projectPath ?? "/p",
    title: overrides?.title ?? null,
    sourceThreadId: overrides?.sourceThreadId ?? null,
  };
}

describe("findEditLineageRoot", () => {
  test("walks parent pointers to the root", () => {
    const root = node("root", { title: "T" });
    const mid = node("mid", { sourceThreadId: "root" });
    const leaf = node("leaf", { sourceThreadId: "mid" });
    const map = new Map([["root", root], ["mid", mid], ["leaf", leaf]]);
    expect(findEditLineageRoot(leaf, map)).toEqual({ root, complete: true });
  });

  test("a pointer cycle terminates instead of hanging", () => {
    const a = node("a", { sourceThreadId: "b" });
    const b = node("b", { sourceThreadId: "a" });
    const map = new Map([["a", a], ["b", b]]);
    const resolved = findEditLineageRoot(a, map);
    expect(resolved.complete).toBe(false);
    expect(["a", "b"]).toContain(resolved.root.id);
  });

  test("a self-loop terminates", () => {
    const a = node("a", { sourceThreadId: "a" });
    expect(findEditLineageRoot(a, new Map([["a", a]])).complete).toBe(false);
  });

  test("a missing or cross-project parent stops the walk as incomplete", () => {
    const orphan = node("orphan", { sourceThreadId: "ghost" });
    expect(findEditLineageRoot(orphan, new Map()).complete).toBe(false);
    const foreign = node("foreign", { projectPath: "/other" });
    const child = node("child", { sourceThreadId: "foreign" });
    const resolved = findEditLineageRoot(child, new Map([["child", child], ["foreign", foreign]]));
    expect(resolved.complete).toBe(false);
    expect(resolved.root.id).toBe("child");
  });
});

describe("fork titles", () => {
  test("parseForkVersion only honors well-formed numeric suffixes", () => {
    expect(parseForkVersion("Fix the leak")).toEqual({ baseTitle: "Fix the leak", version: 1 });
    expect(parseForkVersion("Fix the leak (2)")).toEqual({ baseTitle: "Fix the leak", version: 2 });
    expect(parseForkVersion("Fix the leak (12)")).toEqual({ baseTitle: "Fix the leak", version: 12 });
    expect(parseForkVersion("Fix the leak (1)")).toEqual({ baseTitle: "Fix the leak (1)", version: 1 });
    expect(parseForkVersion("Fix the leak (x)")).toEqual({ baseTitle: "Fix the leak (x)", version: 1 });
    expect(parseForkVersion("notes (draft)")).toEqual({ baseTitle: "notes (draft)", version: 1 });
  });

  test("buildEditForkTitle versions over the whole family", () => {
    expect(buildEditForkTitle("Fix the leak", ["Fix the leak"])).toBe("Fix the leak (2)");
    expect(buildEditForkTitle("Fix the leak", ["Fix the leak", "Fix the leak (2)"])).toBe(
      "Fix the leak (3)",
    );
    // A deleted "(2)" is not reused: the highest seen version still advances.
    expect(buildEditForkTitle("Fix the leak", ["Fix the leak", "Fix the leak (5)"])).toBe(
      "Fix the leak (6)",
    );
    // Renamed siblings still advance the count floor.
    expect(buildEditForkTitle("Fix the leak", ["Fix the leak", "something else"])).toBe(
      "Fix the leak (3)",
    );
    // A versioned source keeps its base: forking "(2)" yields "(3)".
    expect(buildEditForkTitle("Fix the leak (2)", ["Fix the leak", "Fix the leak (2)"])).toBe(
      "Fix the leak (3)",
    );
  });
});
