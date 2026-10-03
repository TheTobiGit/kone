import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { migrationEntries } from "./conversationMigrations.js";
import { steerContinuationId } from "@kone/protocol/steer-split";
import type { StoredBlock as StoredBlockType } from "./types.js";

// ConversationStore imports node:sqlite, which bun can't load: stand it in
// with bun:sqlite and import the store only once the stub is in place.
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

let dataDir = "";

function freshStore(): ConversationStoreType {
  dataDir = mkdtempSync(path.join(tmpdir(), "kone-queue-hold-test-"));
  setUserDataDir(dataDir);
  const store = new ConversationStoreCtor();
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });
  return store;
}

/** Journal a prompt and queue it, the way a send while busy does. */
function queue(store: ConversationStoreType, queueId: string, at: number): void {
  store.recordUserBlock({ blockId: `ub-${queueId}`, threadId: "t", text: queueId });
  store.enqueueQueuedTurn({ threadId: "t", queueId, userBlockId: `ub-${queueId}`, input: queueId, at });
}

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

describe("a held queued turn", () => {
  test("pauses the queue behind it, stays listed in its place, and resumes once removed", () => {
    const store = freshStore();
    queue(store, "q-1", 100);
    queue(store, "q-2", 200);

    expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q-1");
    expect(store.releaseQueuedTurn("q-1", "failed")).toBe(true);

    // q-2 must not run ahead of the message the user sent before it.
    expect(store.claimNextQueuedTurn("t")).toBeNull();
    expect(store.listQueuedTurns("t").map((r) => [r.queueId, r.state])).toEqual([
      ["q-1", "failed"],
      ["q-2", "queued"],
    ]);
    // Its prompt stays out of the transcript like any unsent row.
    expect(store.loadThread("t")?.blocks.map((b) => b.id)).toEqual([]);

    expect(store.cancelQueuedTurn("q-1")).toBe(true);
    expect(store.claimNextQueuedTurn("t")?.queueId).toBe("q-2");
  });

  test("pauses only what runs after it: a row moved ahead of it still runs", () => {
    const store = freshStore();
    queue(store, "held", 100);
    queue(store, "urgent", 200);
    store.claimNextQueuedTurn("t");
    store.releaseQueuedTurn("held", "failed");

    // Send now on a provider that can't steer moves the row to the front.
    store.reorderQueuedTurns("t", ["urgent"]);
    expect(store.claimNextQueuedTurn("t")?.queueId).toBe("urgent");
  });

  test("dedupes a replay of its prompt instead of queueing a second copy", () => {
    const store = freshStore();
    queue(store, "q-1", 100);
    store.claimNextQueuedTurn("t");
    store.releaseQueuedTurn("q-1", "failed");

    expect(store.enqueueQueuedTurn({ threadId: "t", queueId: "q-again", userBlockId: "ub-q-1", input: "q-1" })).toBe(false);
    expect(store.listQueuedTurns("t").map((r) => r.queueId)).toEqual(["q-1"]);
    // And sending the held original isn't blocked by a copy.
    expect(store.claimQueuedTurn("q-1")?.from).toBe("failed");
  });

  test("migration 19 settles held copies already on disk before indexing them", () => {
    const store = freshStore();
    queue(store, "kept", 100);
    // Build what an older build could leave: a held copy beside the waiting
    // row, and two held copies of another prompt.
    const raw = new Database(path.join(dataDir, "kone.sqlite"));
    raw.exec("DROP INDEX idx_queued_turns_active_user_block");
    const insert = raw.prepare(
      `INSERT INTO queued_turns (queue_id, thread_id, user_block_id, dispatch_mode, state, input, attempt_count, created_at, updated_at)
       VALUES (?, 't', ?, 'queue', ?, 'x', 0, ?, ?)`,
    );
    insert.run("held-beside-waiting", "ub-kept", "failed", 200, 200);
    insert.run("held-first", "ub-other", "failed", 300, 300);
    insert.run("held-second", "ub-other", "failed", 400, 400);
    // SAFETY: migration entries take the DatabaseSync surface, which bun's
    // Database provides for prepare/run/exec.
    migrationEntries.find((m) => m.id === 19)!.run(raw as never);

    expect(store.listQueuedTurns("t").map((r) => [r.queueId, r.state])).toEqual([
      ["kept", "queued"],
      ["held-first", "failed"],
    ]);
    expect(() => insert.run("held-dup", "ub-other", "failed", 500, 500)).toThrow();
    raw.close();
  });

  test("is cancelled with the rest on stop", () => {
    const store = freshStore();
    queue(store, "q-1", 100);
    store.claimNextQueuedTurn("t");
    store.releaseQueuedTurn("q-1", "failed");

    expect(store.cancelQueuedTurnsForThread("t")).toEqual(["q-1"]);
    expect(store.listQueuedTurns("t")).toEqual([]);
  });
});

describe("claiming one named row (send now)", () => {
  test("claims a waiting or held row and reports which it was", () => {
    const store = freshStore();
    queue(store, "q-1", 100);
    queue(store, "q-2", 200);
    store.claimNextQueuedTurn("t");
    store.releaseQueuedTurn("q-1", "failed");

    const held = store.claimQueuedTurn("q-1");
    expect(held?.from).toBe("failed");
    expect(held?.row).toMatchObject({ queueId: "q-1", state: "promoting", attemptCount: 2 });
    const waiting = store.claimQueuedTurn("q-2");
    expect(waiting?.from).toBe("queued");

    // Put back exactly as it was when the delivery fails.
    expect(store.releaseQueuedTurn("q-1", held!.from)).toBe(true);
    expect(store.listQueuedTurns("t").find((r) => r.queueId === "q-1")?.state).toBe("failed");
  });

  test("refuses a row that is already claimed, sent or gone", () => {
    const store = freshStore();
    queue(store, "q-1", 100);
    queue(store, "q-2", 200);
    store.claimNextQueuedTurn("t");
    expect(store.claimQueuedTurn("q-1")).toBeNull();
    store.markQueuedTurnPromoted("q-1");
    expect(store.claimQueuedTurn("q-1")).toBeNull();
    store.cancelQueuedTurn("q-2");
    expect(store.claimQueuedTurn("q-2")).toBeNull();
    expect(store.claimQueuedTurn("missing")).toBeNull();
  });

  test("hands back the attachments the row was queued with", () => {
    const store = freshStore();
    const file = { type: "file" as const, id: "att_1", name: "notes.md", mimeType: "text/markdown", sizeBytes: 3 };
    store.recordUserBlock({ blockId: "ub-a", threadId: "t", text: "see file", attachments: [file] });
    store.enqueueQueuedTurn({ threadId: "t", queueId: "q-a", userBlockId: "ub-a", input: "see file", attachments: [file] });

    expect(store.claimQueuedTurn("q-a")?.row.attachments).toEqual([file]);
  });
});

describe("steered user blocks", () => {
  test("are marked on reload, and only user blocks take the mark", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-plain", threadId: "t", text: "start" });
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "also this" });
    store.markUserBlockSteered("t", "ub-steer");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(blocks.map((b) => [b.id, b.role === "user" ? b.steered : undefined])).toEqual([
      ["ub-plain", undefined],
      ["ub-steer", true],
    ]);
  });
  /** A turn under way: its assistant block, then items as the provider
   *  streams them, the way the event journal writes them. */
  function startTurn(store: ConversationStoreType, turnId: string, at: number): void {
    store.applyEvent({ type: "turn.started", threadId: "t", provider: "codex", turnId, at });
  }
  function item(store: ConversationStoreType, turnId: string, itemId: string, text: string): void {
    store.applyEvent({
      type: "item.completed",
      threadId: "t",
      provider: "codex",
      turnId,
      item: { itemId, kind: "assistant_text", status: "completed", text },
      at: 0,
    });
  }
  function readingOrder(blocks: StoredBlockType[]): string[] {
    return blocks.map((b) =>
      b.role === "user" ? `user: ${b.text}` : `assistant: ${b.items.map((i) => i.itemId).join(",")}`,
    );
  }

  test("split the reply on reload where the provider took them in", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1");
    item(store, "turn-1", "i-2", "| path |");
    store.applyEvent({ type: "turn.completed", threadId: "t", provider: "codex", turnId: "turn-1", at: 400 });

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual([
      "user: what is this?",
      "assistant: i-1",
      "user: in a table",
      "assistant: i-2",
    ]);
    const [, first, , rest] = blocks;
    expect(first?.role === "assistant" && [first.state, first.endedAt]).toEqual(["completed", 200]);
    expect(rest?.role === "assistant" && [rest.id, rest.continues, rest.endedAt]).toEqual([
      steerContinuationId("turn-1", "ub-steer"),
      first?.id,
      400,
    ]);
  });

  test("read above the reply when taken in before it said anything", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1");
    item(store, "turn-1", "i-1", "| path |");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual(["user: what is this?", "user: in a table", "assistant: i-1"]);
  });

  test("read above a running reply that has said nothing yet", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1", 210);

    // A renderer reload reads through the live store, the turn still running.
    const blocks = store.loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual(["user: what is this?", "user: in a table", "assistant: "]);
  });

  test("leave the reply whole when nothing came after them", () => {
    const store = freshStore();
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Done");
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual(["assistant: i-1", "user: in a table"]);
  });

  test("keep an empty piece below them while the turn is still running", () => {
    const store = freshStore();
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1", 210);

    // A renderer reload reads through the live store, the turn still running.
    const blocks = store.loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual(["assistant: i-1", "user: in a table", "assistant: "]);
    const rest = blocks[2];
    expect(rest?.role === "assistant" && [rest.id, rest.state]).toEqual([
      steerContinuationId("turn-1", "ub-steer"),
      "running",
    ]);
  });

  test("settle the piece above at the moment the provider took them in, not the send", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    // Queued at 50, delivered with Send now at 300.
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 50 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1", 300);
    item(store, "turn-1", "i-2", "| path |");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    const [, first, , rest] = blocks;
    expect(first?.role === "assistant" && first.endedAt).toBe(300);
    expect(rest?.at).toBe(300);
  });

  test("taken in one after another at the same point, both read before what followed", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    store.recordUserBlock({ blockId: "ub-s1", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-s1", "turn-1", 200);
    store.recordUserBlock({ blockId: "ub-s2", threadId: "t", text: "and short", at: 210 });
    store.markUserBlockSteered("t", "ub-s2", "turn-1", 210);
    item(store, "turn-1", "i-2", "| path |");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual([
      "user: what is this?",
      "assistant: i-1",
      "user: in a table",
      "user: and short",
      "assistant: i-2",
    ]);
  });

  test("delivered agent messages split the reply where each delivery landed, keeping who said them", () => {
    const store = freshStore();
    const ada = { kind: "agent" as const, threadId: "t-ada", name: "Ada", relationship: "contractor" as const };
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "build the login", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Contracting Ada");
    // One delivery carrying two messages, steered in together.
    store.recordUserBlock({ blockId: "ub-m1", threadId: "t", text: "Is OAuth in scope?", at: 200, sender: ada });
    store.recordUserBlock({ blockId: "ub-m2", threadId: "t", text: "And SSO?", at: 201, sender: ada });
    store.markUserBlockSteered("t", "ub-m1", "turn-1", 205);
    store.markUserBlockSteered("t", "ub-m2", "turn-1", 205);
    item(store, "turn-1", "i-2", "Answering Ada");
    // A second delivery later in the same turn.
    store.recordUserBlock({ blockId: "ub-m3", threadId: "t", text: "Done.", at: 300, sender: ada });
    store.markUserBlockSteered("t", "ub-m3", "turn-1", 305);
    item(store, "turn-1", "i-3", "Ada is done");

    const blocks = new ConversationStoreCtor().loadThread("t")?.blocks ?? [];
    expect(readingOrder(blocks)).toEqual([
      "user: build the login",
      "assistant: i-1",
      "user: Is OAuth in scope?",
      "user: And SSO?",
      "assistant: i-2",
      "user: Done.",
      "assistant: i-3",
    ]);
    expect(blocks.filter((b) => b.role === "user" && b.sender).map((b) => b.role === "user" && b.sender?.kind)).toEqual([
      "agent",
      "agent",
      "agent",
    ]);
  });

  test("keep a split turn on one page", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-0", threadId: "t", text: "earlier", at: 50 });
    startTurn(store, "turn-0", 60);
    item(store, "turn-0", "i-0", "Hi");
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    store.recordUserBlock({ blockId: "ub-steer", threadId: "t", text: "in a table", at: 200 });
    store.markUserBlockSteered("t", "ub-steer", "turn-1", 200);
    item(store, "turn-1", "i-2", "| path |");

    const reader = new ConversationStoreCtor();
    const newest = reader.loadThreadPage("t", { limit: 1 });
    expect(readingOrder(newest?.blocks ?? [])).toEqual([
      "user: what is this?",
      "assistant: i-1",
      "user: in a table",
      "assistant: i-2",
    ]);
    const older = reader.loadThreadPage("t", { limit: 1, cursor: newest?.nextCursor ?? undefined });
    expect(readingOrder(older?.blocks ?? [])).toEqual(["user: earlier", "assistant: i-0"]);
  });

  test("keep a split turn on one page past the raw row ceiling", () => {
    const store = freshStore();
    store.recordUserBlock({ blockId: "ub-0", threadId: "t", text: "earlier", at: 50 });
    startTurn(store, "turn-0", 60);
    item(store, "turn-0", "i-0", "Hi");
    store.recordUserBlock({ blockId: "ub-ask", threadId: "t", text: "what is this?", at: 100 });
    startTurn(store, "turn-1", 110);
    item(store, "turn-1", "i-1", "Let me look");
    for (let n = 1; n <= 4; n++) {
      store.recordUserBlock({ blockId: `ub-s${n}`, threadId: "t", text: `steer ${n}`, at: 200 + n });
      store.markUserBlockSteered("t", `ub-s${n}`, "turn-1", 200 + n);
      item(store, "turn-1", `i-s${n}`, `after ${n}`);
    }

    const reader = new ConversationStoreCtor();
    const newest = reader.loadThreadPage("t", { limit: 1, maxRaw: 2 });
    expect(readingOrder(newest?.blocks ?? [])).toEqual([
      "assistant: i-1",
      "user: steer 1",
      "assistant: i-s1",
      "user: steer 2",
      "assistant: i-s2",
      "user: steer 3",
      "assistant: i-s3",
      "user: steer 4",
      "assistant: i-s4",
    ]);
    const older = reader.loadThreadPage("t", { limit: 1, cursor: newest?.nextCursor ?? undefined });
    expect(readingOrder(older?.blocks ?? [])).toEqual(["user: what is this?"]);
  });
});
