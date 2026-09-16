import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import type { RuntimeEvent, RuntimeItem } from "./types.js";

// Write-amplification counters for the item persistence path. Every string
// bound to an item-writing statement is measured through JSON.stringify (a
// uniform upper bound on its encoded bytes — no runtime type narrowing
// needed), so a whole-row rewrite per delta shows up as quadratic growth
// while append-only chunks show up as linear.
let itemWriteBytes = 0;
let updateItemsRuns = 0;
let chunkInserts = 0;

function resetCounters(): void {
  itemWriteBytes = 0;
  updateItemsRuns = 0;
  chunkInserts = 0;
}

/** Values a statement can bind: the drivers accept text, numbers, nulls, and
 *  (for blobs, which this store never binds) byte arrays — booleans ride
 *  along as integers. */
type BoundValue = string | number | bigint | boolean | null;

function argBytes(arg: BoundValue): number {
  return String(arg).length;
}

/** bun:sqlite shim for `node:sqlite` (bun can't load the Electron built-in),
 *  counting the bytes bound to item-writing statements so the tests can
 *  assert the streaming path's write volume. */
class InstrumentedDatabase {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    const writesItems =
      /INSERT INTO items\b/.test(sql) ||
      /UPDATE items\b/.test(sql) ||
      /INSERT INTO item_text_chunks\b/.test(sql) ||
      /DELETE FROM item_text_chunks\b/.test(sql);
    const isUpdateItems = /^\s*UPDATE items\b/.test(sql);
    const isChunkInsert = /INSERT INTO item_text_chunks\b/.test(sql);
    return {
      run: (...args: unknown[]) => {
        if (writesItems) {
          for (const arg of args) itemWriteBytes += argBytes(arg);
        }
        if (isUpdateItems) updateItemsRuns += 1;
        if (isChunkInsert) chunkInserts += 1;
        return stmt.run(...args);
      },
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
    };
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({ DatabaseSync: InstrumentedDatabase }));

// Loaded dynamically so the shim is in place first (same pattern as the other
// store tests).
const { ConversationStore } = await import("./ConversationStore.js");

type Store = InstanceType<typeof ConversationStore>;

let testUserDataDir = "";
function freshStore(): Store {
  testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-chunks-test-"));
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}

/** A new store over the SAME state dir: a mid-stream process restart with
 *  empty in-memory cursors. */
function reopenStore(): Store {
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}

function rawDb(): Database {
  return new Database(path.join(testUserDataDir, "kone.sqlite"));
}

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "opencode", at, source: "kone.store", turnId };
}

function itemEvent(
  type: "item.started" | "item.updated" | "item.completed",
  threadId: string,
  turnId: string,
  item: RuntimeItem,
  at: number,
): RuntimeEvent {
  return { type, threadId, provider: "opencode", at, source: "kone.store", turnId, item };
}

function textItem(itemId: string, text: string, status: RuntimeItem["status"] = "in-progress"): RuntimeItem {
  return { itemId, kind: "assistant_text", status, text };
}

/** Read one item's rendered text back out of the stored thread. */
function streamedText(
  store: Store,
  threadId: string,
  turnId: string,
  itemId: string,
): string {
  const thread = store.loadThread(threadId);
  const blocks = thread?.blocks ?? [];
  for (const block of blocks) {
    if (block.role !== "assistant") continue;
    for (const item of block.items ?? []) {
      if (item.itemId === itemId) return item.text;
    }
  }
  return "<missing>";
}

function chunkRowCount(raw: Database, threadId: string): number {
  // SAFETY: counting chunk rows answers one row with the count column.
  const row = raw
    .prepare(`SELECT COUNT(*) AS n FROM item_text_chunks WHERE thread_id = ?`)
    .get(threadId) as { n: number };
  return row.n;
}

describe("ConversationStore append-only item text", () => {
  test("migration v6 creates the chunks table and the text_json column", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "thread-migrate", projectPath: "/proj", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: sqlite_master rows carry the object's name in `name`.
    const tables = (
      raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
        name: string;
      }>
    ).map((r) => r.name);
    expect(tables).toContain("item_text_chunks");
    // SAFETY: PRAGMA table_info answers one row per column, each carrying its name.
    const itemCols = (
      raw.prepare(`PRAGMA table_info(items)`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(itemCols).toContain("text_json");
    // SAFETY: PRAGMA table_info answers one row per column, each carrying its name.
    const chunkCols = (
      raw.prepare(`PRAGMA table_info(item_text_chunks)`).all() as Array<{ name: string }>
    ).map((r) => r.name);
    expect(chunkCols).toEqual(["thread_id", "turn_id", "item_id", "seq", "text_json", "char_len"]);
    // SAFETY: schema_migrations rows carry the rung id in `migration_id`.
    const rungs = (
      raw.prepare(`SELECT migration_id FROM schema_migrations ORDER BY migration_id`).all() as Array<{
        migration_id: number;
      }>
    ).map((r) => r.migration_id);
    expect(rungs).toContain(6);
    raw.close();
  });

  test("streaming deltas read back byte-identical mid-stream and after completion", () => {
    const store = freshStore();
    const threadId = "thread-stream";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.recordUserBlock({ threadId, text: "go", at: 1 });
    store.applyEvent(turnStarted(threadId, turnId, 2));

    const full = "Hello, this is a streamed reply with unicode: héllo wörld — and emoji 🎉.\nSecond line here.";
    const snapshots: string[] = [];
    for (let end = 7; end <= full.length; end += 7) snapshots.push(full.slice(0, end));
    snapshots.push(full);

    store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", snapshots[0]!), 3));
    for (let i = 1; i < snapshots.length; i++) {
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", snapshots[i]!), 3 + i));
      // Every delta must already read as the latest snapshot.
      expect(streamedText(store, threadId, turnId, "i-1")).toBe(snapshots[i]);
    }
    // The windowed page and the latest-text shortcut agree mid-stream.
    const page = store.loadThreadPage(threadId);
    const pageItem = page?.blocks
      .flatMap((b) => (b.role === "assistant" ? (b.items ?? []) : []))
      .find((item) => item.itemId === "i-1");
    expect(pageItem?.text).toBe(full);
    expect(store.latestAssistantText(threadId)).toBe(full);
    // The list snippet sees the partial text too, not a stale base.
    const listed = store.listThreads("/proj");
    expect(listed[0]?.snippet).toContain("Hello, this is a streamed reply");

    store.applyEvent(itemEvent("item.completed", threadId, turnId, textItem("i-1", full, "completed"), 500));
    expect(streamedText(store, threadId, turnId, "i-1")).toBe(full);
    expect(store.loadThreadPage(threadId)?.blocks
      .flatMap((b) => (b.role === "assistant" ? (b.items ?? []) : []))
      .find((item) => item.itemId === "i-1")?.text).toBe(full);

    const raw = rawDb();
    // Collapse: no chunk rows remain and the settled row holds the final text.
    expect(chunkRowCount(raw, threadId)).toBe(0);
    // SAFETY: the SELECT targets the single row written above; text/text_json are its columns.
    const row = raw
      .prepare(`SELECT text, text_json FROM items WHERE thread_id = ? AND turn_id = ? AND item_id = ?`)
      .get(threadId, turnId, "i-1") as { text: string; text_json: string | null };
    expect(row.text).toBe(full);
    expect(row.text_json).toBeNull();
    raw.close();
  });

  test("a mid-stream restart recovers the append offset and stays byte-identical", () => {
    let store = freshStore();
    const threadId = "thread-restart";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.applyEvent(turnStarted(threadId, turnId, 2));

    const full = "x".repeat(500) + "middle — 🎉 —" + "y".repeat(500);
    const cut = 420;
    store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", full.slice(0, 50)), 3));
    for (let end = 100; end <= cut; end += 50) {
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", full.slice(0, end)), end));
    }
    store.close();

    // Fresh process: no cursors, chunks on disk.
    store = reopenStore();
    const raw = rawDb();
    // SAFETY: the chunk aggregate answers one row with count/max columns.
    const agg = raw
      .prepare(`SELECT COUNT(*) AS n, MAX(seq) AS m FROM item_text_chunks WHERE thread_id = ?`)
      .get(threadId) as { n: number; m: number };
    expect(agg.n).toBeGreaterThan(0);
    // Sequence numbers are dense from zero — the restart must continue them.
    expect(agg.m).toBe(agg.n - 1);
    raw.close();

    for (let end = cut + 50; end <= full.length; end += 50) {
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", full.slice(0, end)), end));
    }
    store.applyEvent(itemEvent("item.completed", threadId, turnId, textItem("i-1", full, "completed"), 9999));
    expect(streamedText(store, threadId, turnId, "i-1")).toBe(full);
    expect(store.latestAssistantText(threadId)).toBe(full);

    const raw2 = rawDb();
    expect(chunkRowCount(raw2, threadId)).toBe(0);
    // SAFETY: the SELECT targets the single row written above; text is its column.
    const row = raw2
      .prepare(`SELECT text FROM items WHERE thread_id = ? AND turn_id = ? AND item_id = ?`)
      .get(threadId, turnId, "i-1") as { text: string };
    expect(row.text).toBe(full);
    raw2.close();
  });

  test("an interrupted (never-completed) item keeps its streamed text", () => {
    let store = freshStore();
    const threadId = "thread-interrupted";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.applyEvent(turnStarted(threadId, turnId, 2));
    const full = "partial reply that never settled";
    store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", full.slice(0, 7)), 3));
    for (let end = 14; end < full.length; end += 7) {
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", full.slice(0, end)), end));
    }
    store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", full), full.length));
    store.close();

    // Restart seals the orphaned turn (items go 'failed') but must not lose text.
    store = reopenStore();
    expect(streamedText(store, threadId, turnId, "i-1")).toBe(full);
    const pageItem = store
      .loadThreadPage(threadId)
      ?.blocks.flatMap((b) => (b.role === "assistant" ? (b.items ?? []) : []))
      .find((item) => item.itemId === "i-1");
    expect(pageItem?.text).toBe(full);
    expect(store.latestAssistantText(threadId)).toBe(full);

    // The chunks are still there — nothing collapsed a turn that never settled.
    const raw = rawDb();
    expect(chunkRowCount(raw, threadId)).toBeGreaterThan(0);
    raw.close();
  });

  test("NUL bytes and unpaired surrogates round-trip through chunks and the settled row", () => {
    for (const full of ["before\0after", "lone surrogate \ud800 here", "both \0 and \udc00 mixed"]) {
      const store = freshStore();
      const threadId = "thread-encode";
      const turnId = "turn-1";
      store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
      store.applyEvent(turnStarted(threadId, turnId, 2));
      const mid = Math.floor(full.length / 2);
      store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", full.slice(0, mid)), 3));
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", full), 4));
      expect(streamedText(store, threadId, turnId, "i-1")).toBe(full);
      store.applyEvent(itemEvent("item.completed", threadId, turnId, textItem("i-1", full, "completed"), 5));
      expect(streamedText(store, threadId, turnId, "i-1")).toBe(full);

      const raw = rawDb();
      // SAFETY: the SELECT targets the single row written above; text/text_json are its columns.
      const row = raw
        .prepare(`SELECT text, text_json FROM items WHERE thread_id = ? AND turn_id = ? AND item_id = ?`)
        .get(threadId, turnId, "i-1") as { text: string; text_json: string | null };
      // The unsafe bytes are encoded, never stored raw: the raw column carries
      // no NUL (which would truncate the read) and the fallback is set.
      expect(row.text.includes("\0")).toBe(false);
      expect(row.text_json).not.toBeNull();
      raw.close();

      // And the encoding survives a restart too.
      const reopened = reopenStore();
      expect(streamedText(reopened, threadId, turnId, "i-1")).toBe(full);
      reopened.close();
      store.close();
    }
  });

  test("streaming 400 deltas writes linear bytes, not a quadratic rewrite", () => {
    const store = freshStore();
    const threadId = "thread-amp";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.applyEvent(turnStarted(threadId, turnId, 1));
    resetCounters();

    const deltas = 400;
    const step = 25;
    let snapshot = "";
    store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", snapshot), 2));
    for (let i = 0; i < deltas; i++) {
      snapshot += "a".repeat(step);
      store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", snapshot), 3 + i));
    }
    store.applyEvent(itemEvent("item.completed", threadId, turnId, textItem("i-1", snapshot, "completed"), 9999));

    const finalBytes = snapshot.length; // 10_000
    // The old whole-row rewrite would bind ~sum(25*i) ≈ 2,000,000 chars here.
    // Append-only chunks plus one collapse must stay near the ~10k payload.
    expect(finalBytes).toBe(deltas * step);
    expect(itemWriteBytes).toBeLessThan(150_000);
    expect(chunkInserts).toBe(deltas);
    expect(streamedText(store, threadId, turnId, "i-1")).toBe(snapshot);
  });

  test("unchanged non-text columns write nothing; changed ones write once", () => {
    const store = freshStore();
    const threadId = "thread-changed";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.applyEvent(turnStarted(threadId, turnId, 1));
    resetCounters();

    store.applyEvent(
      itemEvent("item.started", threadId, turnId, { itemId: "i-1", kind: "tool_call", status: "in-progress", text: "run", name: "bash", detail: "d0" }, 2),
    );
    const updatesAfterStarted = updateItemsRuns;
    // Ten deltas that change nothing but text: no UPDATE items at all.
    for (let i = 0; i < 10; i++) {
      store.applyEvent(
        itemEvent("item.updated", threadId, turnId, { itemId: "i-1", kind: "tool_call", status: "in-progress", text: `run ${i}`, name: "bash", detail: "d0" }, 3 + i),
      );
    }
    expect(updateItemsRuns).toBe(updatesAfterStarted);
    // One event that changes only `detail`: exactly one UPDATE.
    store.applyEvent(
      itemEvent("item.updated", threadId, turnId, { itemId: "i-1", kind: "tool_call", status: "in-progress", text: "run 9", name: "bash", detail: "d1" }, 20),
    );
    expect(updateItemsRuns).toBe(updatesAfterStarted + 1);
    const raw = rawDb();
    // SAFETY: the SELECT targets the single row written above; detail is its column.
    const row = raw
      .prepare(`SELECT detail FROM items WHERE thread_id = ? AND turn_id = ? AND item_id = ?`)
      .get(threadId, turnId, "i-1") as { detail: string };
    expect(row.detail).toBe("d1");
    raw.close();
  });

  test("a shortened snapshot folds once into the base and keeps reading", () => {
    const store = freshStore();
    const threadId = "thread-shrink";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });
    store.applyEvent(turnStarted(threadId, turnId, 1));
    store.applyEvent(itemEvent("item.started", threadId, turnId, textItem("i-1", "hello world"), 2));
    store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", "hello world!!!"), 3));
    // The producer revises rather than appends: the base is replaced once.
    store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", "hi"), 4));
    expect(streamedText(store, threadId, turnId, "i-1")).toBe("hi");
    store.applyEvent(itemEvent("item.updated", threadId, turnId, textItem("i-1", "hi there"), 5));
    expect(streamedText(store, threadId, turnId, "i-1")).toBe("hi there");
    store.applyEvent(itemEvent("item.completed", threadId, turnId, textItem("i-1", "hi there", "completed"), 6));
    expect(streamedText(store, threadId, turnId, "i-1")).toBe("hi there");
    const raw = rawDb();
    expect(chunkRowCount(raw, threadId)).toBe(0);
    raw.close();
  });
});
