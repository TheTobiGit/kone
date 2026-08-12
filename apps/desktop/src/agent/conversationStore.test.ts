import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import { Database } from "bun:sqlite";

import type { ChatAttachment, RuntimeEvent, ThreadLineage } from "./types.js";

// ConversationStore imports node:sqlite (an Electron-runtime built-in this bun
// can't load) — stand it in for bun:sqlite (same exec / prepare / get / run /
// all surface) and point the agent layer's state dir at a throwaway temp dir
// per test. Imported dynamically so the stubs are in place first — the same
// pattern as spawnStore.test.ts.
let testUserDataDir = "";
/** Point the agent layer at a fresh temp state dir (see userDataDir.ts). */
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-store-test-")));

mock.module("node:sqlite", () => ({
  DatabaseSync: Database,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-store-test-")));
  return new ConversationStoreCtor();
}

function dbPath(): string {
  return path.join(testUserDataDir, "conversations.sqlite");
}

function rawDb(): Database {
  return new Database(dbPath());
}

function columnNames(db: Database, table: string): string[] {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

// ── event seeds (same shapes the real adapters emit) ─────────────────────────
function sessionStarted(
  threadId: string,
  at: number,
  refs?: RuntimeEvent["refs"],
): RuntimeEvent {
  return { type: "session.started", threadId, provider: "claudeAgent", at, source: "kone.store", refs };
}

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return {
    type: "turn.started",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    turnId,
  };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return {
    type: "turn.completed",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    turnId,
  };
}

function tokenUsage(
  threadId: string,
  at: number,
  usage: {
    input?: number;
    output?: number;
    total?: number;
    cacheReadTokens?: number;
    cacheCreationTokens?: number;
    reasoningTokens?: number;
  },
  provider: RuntimeEvent["provider"] = "opencode",
): RuntimeEvent {
  return {
    type: "thread.token-usage.updated",
    threadId,
    provider,
    at,
    source: "kone.store",
    usage,
  };
}

function spawnedLineage(parentThreadId: string, rootThreadId: string): ThreadLineage {
  return {
    parentThreadId,
    rootThreadId,
    relationshipToParent: "subagent",
    spawnedAt: Date.now(),
  };
}

// ── v17 legacy schema (the shape the v18 migration upgrades from) ────────────
const V17_THREADS = `
  CREATE TABLE threads (
    thread_id       TEXT PRIMARY KEY,
    project_path    TEXT NOT NULL,
    provider        TEXT NOT NULL,
    model           TEXT,
    conversation_id TEXT,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    branch          TEXT,
    added           INTEGER,
    removed         INTEGER,
    tokens          INTEGER,
    context_used    INTEGER,
    context_window  INTEGER,
    compacts_auto   INTEGER,
    archived        INTEGER,
    title           TEXT,
    base_tree       TEXT,
    source_thread_id TEXT,
    fork_context_json TEXT,
    lineage_json    TEXT,
    request_id      TEXT,
    parent_thread_id TEXT
  );
  CREATE TABLE blocks (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    block_id  TEXT NOT NULL UNIQUE,
    thread_id TEXT NOT NULL,
    role      TEXT NOT NULL,
    turn_id   TEXT,
    text      TEXT,
    state     TEXT,
    error     TEXT,
    at        INTEGER NOT NULL,
    ended_at  INTEGER,
    attachments_json TEXT,
    source    TEXT NOT NULL DEFAULT 'native'
  );
  CREATE TABLE items (
    seq       INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id   TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id   TEXT NOT NULL,
    kind      TEXT NOT NULL,
    status    TEXT NOT NULL,
    text      TEXT NOT NULL,
    name      TEXT,
    detail    TEXT,
    tasks_json TEXT,
    subagent_tool_use_id TEXT,
    UNIQUE (thread_id, turn_id, item_id)
  );
  CREATE TABLE subagents (
    seq INTEGER PRIMARY KEY AUTOINCREMENT,
    tool_use_id TEXT NOT NULL,
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    task_id TEXT,
    parent_item_id TEXT,
    agent_type TEXT,
    description TEXT,
    prompt TEXT,
    model TEXT,
    effort TEXT,
    background INTEGER,
    status TEXT NOT NULL,
    summary TEXT,
    last_tool_name TEXT,
    tokens INTEGER,
    tool_uses INTEGER,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    UNIQUE (thread_id, turn_id, tool_use_id)
  );
  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY,
    thread_id TEXT NOT NULL,
    type TEXT NOT NULL,
    name TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size_bytes INTEGER NOT NULL,
    rel_path TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE gateway_ops (
    thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL,
    request_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    dispatched INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (thread_id, turn_id, request_id)
  );
  CREATE TABLE scratchpads (
    id TEXT PRIMARY KEY,
    project_path TEXT NOT NULL,
    title TEXT,
    body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    sort_index INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE project_boards (
    project_path TEXT PRIMARY KEY,
    layout TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );
`;

describe("v18 migration", () => {
  test("fresh DB opens at the current schema (v21) with the new columns, table and indexes", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);

    const threads = columnNames(raw, "threads");
    for (const col of ["is_pinned", "model_selection_json", "resume_session_at", "last_activity_at"]) {
      expect(threads).toContain(col);
    }
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(tables).toContain("turn_usage");
    const idx = raw
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_threads_request_id'`,
      )
      .get();
    expect(idx).toBeDefined();
    raw.close();
  });

  test("a v17 legacy DB migrates: columns added, request_id deduped (oldest wins), unique index lands", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-migrate-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(V17_THREADS);
    // Two threads sharing one request id — the lax pre-v18 shape that minted
    // duplicate side chats for one idempotency key.
    legacy
      .prepare(
        `INSERT INTO threads (thread_id, project_path, provider, created_at, updated_at, request_id)
         VALUES ('old-1', '/p', 'opencode', 100, 100, 'req-dup'),
                ('new-1', '/p', 'opencode', 200, 200, 'req-dup')`,
      )
      .run();
    legacy.exec(`PRAGMA user_version = 17`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();

    // Idempotency authority: the OLDEST row keeps the key, the newer one loses it.
    expect(store.threadIdForRequestId("req-dup")).toBe("old-1");
    const raw = rawDb();
    const rows = raw
      .prepare(`SELECT thread_id, request_id FROM threads ORDER BY created_at`)
      .all() as Array<{ thread_id: string; request_id: string | null }>;
    expect(rows).toEqual([
      { thread_id: "old-1", request_id: "req-dup" },
      { thread_id: "new-1", request_id: null },
    ]);
    const idx = raw
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_threads_request_id'`,
      )
      .get();
    expect(idx).toBeDefined();
    raw.close();
  });

  test("a v1 DB with rows takes the destructive v2/v5 path and leaves a dated backup", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-backup-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(`
      CREATE TABLE threads (
        thread_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
        model TEXT, conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE blocks (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, block_id TEXT NOT NULL UNIQUE,
        thread_id TEXT NOT NULL, role TEXT NOT NULL, turn_id TEXT, text TEXT,
        state TEXT, error TEXT, at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE items (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, thread_id TEXT NOT NULL,
        turn_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL,
        name TEXT, detail TEXT, UNIQUE (thread_id, turn_id, item_id)
      );
    `);
    legacy
      .prepare(
        `INSERT INTO threads (thread_id, project_path, provider, created_at, updated_at)
         VALUES ('legacy-1', '/p', 'opencode', 1, 1)`,
      )
      .run();
    legacy.exec(`PRAGMA user_version = 1`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    expect(store.listThreads("/p")).toEqual([]);

    const backups = readdirSync(dir).filter((f) => f.startsWith("conversations.sqlite.bak-"));
    expect(backups.length).toBeGreaterThan(0);
  });

  test("a DB from a NEWER build is refused, not rewound", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-newer-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(`PRAGMA user_version = 99`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    // Persistence disabled for this process: reads no-op, writes no-op.
    expect(store.listThreads("/p")).toEqual([]);
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(99);
    raw.close();
  });
});

describe("pins, selection and rename", () => {
  test("setPinned + setThreadSelection round-trip through threadMeta", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex" });
    store.setPinned("t-1", true);
    store.setThreadSelection("t-1", {
      model: "gpt-5.6-sol",
      effort: "max",
      serviceTier: "fast",
      contextWindow: "200k",
    });
    const meta = store.threadMeta("t-1");
    expect(meta?.isPinned).toBe(true);
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.selection).toEqual({ effort: "max", serviceTier: "fast", contextWindow: "200k" });

    // Absent fields are left untouched; unpin clears.
    store.setThreadSelection("t-1", { effort: "high" });
    expect(store.threadMeta("t-1")?.selection).toEqual({
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
    });
    store.setPinned("t-1", false);
    expect(store.threadMeta("t-1")?.isPinned).toBe(false);
  });

  test("renameThread changes the title but never reshuffles recency", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "opencode" });
    store.ensureThread({ threadId: "b", projectPath: "/p", provider: "opencode" });
    store.recordUserBlock({ threadId: "a", text: "first", at: 100 });
    store.recordUserBlock({ threadId: "b", text: "second", at: 200 });
    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["b", "a"]);

    // A rename at t=300 must not move "a" ahead of "b" (t=200).
    expect(store.renameThread("a", "Renamed at 300", )).toBe(true);
    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["b", "a"]);
    expect(store.threadMeta("a")?.title).toBe("Renamed at 300");
    expect(store.threadMeta("a")?.lastActivityAt).toBe(100);

    // Real activity does move it.
    store.recordUserBlock({ threadId: "a", text: "third", at: 400 });
    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["a", "b"]);

    // Unchanged title is a no-op (false = nothing broadcast).
    expect(store.renameThread("a", "Renamed at 300")).toBe(false);
  });
});

describe("delete/archive subtree cascade with busy guard", () => {
  test("deleteThread cascades to spawned children and every row kind, and refuses while busy", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "parent-1", projectPath: "/p", provider: "opencode" });
    store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("parent-1", "parent-1"),
    });
    // A live child turn → both the guard and deleteThread must refuse.
    store.applyEvent(turnStarted("child-1", "turn-1", 10));
    expect(store.canDeleteThread("parent-1")).toEqual({ ok: false, reason: "busy" });
    expect(store.deleteThread("parent-1")).toEqual({ ok: false, reason: "busy" });
    expect(store.threadExists("parent-1")).toBe(true);

    // Settle the child, seed every row kind, then delete the parent.
    store.applyEvent(turnCompleted("child-1", "turn-1", 20));
    store.reserveGatewayOp({
      threadId: "child-1",
      turnId: "turn-1",
      requestId: "req-1",
      kind: "scratchpad.write",
      fingerprint: "fp",
    });
    store.applyEvent(tokenUsage("child-1", 25, { input: 10, output: 5, total: 15 }));
    const raw = rawDb();
    const usage = raw
      .prepare(`SELECT * FROM turn_usage WHERE thread_id = 'child-1'`)
      .get() as { turn_id: string } | undefined;
    expect(usage?.turn_id).toBe("turn-1");
    raw.close();

    expect(store.deleteThread("parent-1")).toEqual({ ok: true });
    const after = rawDb();
    for (const table of ["threads", "blocks", "items", "subagents", "gateway_ops", "turn_usage", "attachments"]) {
      const n = (
        after
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id IN ('parent-1', 'child-1')`)
          .get() as { n: number }
      ).n;
      expect(n, `${table} should be empty after cascade`).toBe(0);
    }
    after.close();
  });

  test("setArchived archives the subtree and refuses while a child is busy", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "parent-1", projectPath: "/p", provider: "opencode" });
    store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("parent-1", "parent-1"),
    });
    store.applyEvent(turnStarted("child-1", "turn-1", 10));
    expect(store.setArchived("parent-1", true)).toEqual({ ok: false, reason: "busy" });
    store.applyEvent(turnCompleted("child-1", "turn-1", 20));
    expect(store.setArchived("parent-1", true)).toEqual({ ok: true });
    const raw = rawDb();
    const archived = (id: string) =>
      (raw.prepare(`SELECT archived FROM threads WHERE thread_id = ?`).get(id) as {
        archived: number | null;
      }).archived;
    expect(archived("parent-1")).not.toBeNull();
    expect(archived("child-1")).not.toBeNull(); // subtree archived with the parent
    // Restore un-archives the subtree too.
    expect(store.setArchived("parent-1", false)).toEqual({ ok: true });
    expect(archived("parent-1")).toBeNull();
    expect(archived("child-1")).toBeNull();
    raw.close();
  });
});

describe("live capture contracts", () => {
  test("public captureConversationId persists durably with memo", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "codex" });
    store.captureConversationId("t-1", "conv-1");
    expect(store.threadMeta("t-1")?.conversationId).toBe("conv-1");
  });

  test("resumeSessionAt is captured from refs and cleared on a fresh session.started", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "claudeAgent" });
    store.applyEvent(
      sessionStarted("t-1", 1, { conversationId: "conv-1", resumeSessionAt: "msg-uuid-1" }),
    );
    expect(store.threadMeta("t-1")?.resumeSessionAt).toBe("msg-uuid-1");
    expect(store.threadMeta("t-1")?.conversationId).toBe("conv-1");

    // A fresh session (no anchor) clears the stale one.
    store.applyEvent(sessionStarted("t-1", 2, { conversationId: "conv-2" }));
    expect(store.threadMeta("t-1")?.resumeSessionAt).toBeUndefined();
    expect(store.threadMeta("t-1")?.conversationId).toBe("conv-2");
  });

  test("token-usage folds the rollup, context snapshot and per-turn audit row", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "claudeAgent" });
    store.applyEvent(turnStarted("t-1", "turn-1", 10));
    store.applyEvent(
      tokenUsage(
        "t-1",
        15,
        { input: 100, output: 50, total: 150 },
        "claudeAgent",
      ),
    );
    store.applyEvent(
      tokenUsage(
        "t-1",
        20,
        { input: 30, output: 20, total: 50 },
        "claudeAgent",
      ),
    );
    expect(store.threadMeta("t-1")?.tokens).toBe(200); // Claude accumulates per-turn spend.
    const raw = rawDb();
    const usage = raw
      .prepare(`SELECT * FROM turn_usage WHERE thread_id = 't-1' AND turn_id = 'turn-1'`)
      .get() as { input_tokens: number; output_tokens: number; total_tokens: number; at: number };
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(20);
    expect(usage.total_tokens).toBe(50);
    expect(usage.at).toBe(20); // latest event wins
    raw.close();
  });
});

describe("v19 keyset index migration", () => {
  test("fresh DB opens at the current schema with the blocks keyset index", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);
    const idx = raw
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_blocks_keyset'`)
      .get();
    expect(idx).toBeDefined();
    raw.close();
  });

  test("a v17 legacy DB upgrades through v18-v20 to the current schema and gains the index", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-migrate-v19-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(V17_THREADS);
    legacy.exec(`PRAGMA user_version = 17`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);
    const idx = raw
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_blocks_keyset'`)
      .get();
    expect(idx).toBeDefined();
    raw.close();
  });
});

describe("thread page cursor", () => {
  test("round-trips and rejects malformed input", async () => {
    const { encodeThreadPageCursor, decodeThreadPageCursor } = await import("./ConversationStore.js");
    const encoded = encodeThreadPageCursor({
      threadId: "t-1",
      beforeAnchorAt: 1234,
      beforeBlockId: "b-9",
    });
    expect(decodeThreadPageCursor(encoded)).toEqual({
      threadId: "t-1",
      beforeAnchorAt: 1234,
      beforeBlockId: "b-9",
    });
    for (const bad of ["", "not-base64!!", "e30=", JSON.stringify({ t: "t-1" }), "null", "42"]) {
      expect(decodeThreadPageCursor(bad)).toBeNull();
    }
    // Empty thread id is malformed too; empty boundary values are not.
    const emptyThread = Buffer.from(JSON.stringify({ t: "", a: 0, i: "" })).toString("base64url");
    expect(decodeThreadPageCursor(emptyThread)).toBeNull();
  });
});

describe("loadThreadPage user-anchored windows", () => {
  function buildExchange(store: ConversationStoreType, threadId: string, n: number): void {
    const at = 100 * n;
    store.recordUserBlock({ threadId, text: `prompt ${n}`, at });
    store.applyEvent(turnStarted(threadId, `turn-${n}`, at + 5));
    store.applyEvent({
      type: "item.completed",
      threadId,
      provider: "opencode",
      at: at + 6,
      source: "kone.store",
      turnId: `turn-${n}`,
      item: { itemId: `tool-${n}`, kind: "tool_call", status: "completed", text: "run", name: "run", detail: `out ${n}` },
    });
    store.applyEvent(turnCompleted(threadId, `turn-${n}`, at + 7));
  }

  test("walks newest-first in user-anchored windows, exactly once, oldest-first rows", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-p", projectPath: "/p", provider: "opencode" });
    for (let n = 1; n <= 5; n++) buildExchange(store, "t-p", n);

    // limit = 2 user blocks per page → 5 exchanges page as 2 + 2 + 1.
    const p1 = store.loadThreadPage("t-p", { limit: 2 })!;
    expect(p1.hasMore).toBe(true);
    expect(p1.nextCursor).not.toBeNull();
    expect(p1.blocks.map((b) => b.at)).toEqual([400, 405, 500, 505]);
    // Each assistant block rides with its tool item.
    const assistantBlocks = p1.blocks.filter(
      (b): b is Extract<(typeof p1.blocks)[number], { role: "assistant" }> => b.role === "assistant",
    );
    expect(assistantBlocks.map((b) => b.items.map((i) => i.detail))).toEqual([
      ["out 4"],
      ["out 5"],
    ]);

    const p2 = store.loadThreadPage("t-p", { limit: 2, cursor: p1.nextCursor! })!;
    expect(p2.hasMore).toBe(true);
    expect(p2.blocks.map((b) => b.at)).toEqual([200, 205, 300, 305]);

    const p3 = store.loadThreadPage("t-p", { limit: 2, cursor: p2.nextCursor! })!;
    expect(p3.hasMore).toBe(false);
    expect(p3.nextCursor).toBeNull();
    expect(p3.blocks.map((b) => b.at)).toEqual([100, 105]);

    // The whole walk covers every block exactly once — the full set in
    // ascending time order (pages themselves come newest-first).
    const all = [...p1.blocks, ...p2.blocks, ...p3.blocks];
    expect(all.length).toBe(10);
    const ats = all.map((b) => b.at);
    expect([...ats].sort((a, b) => a - b)).toEqual([100, 105, 200, 205, 300, 305, 400, 405, 500, 505]);
    const ids = all.map((b) => b.id);
    expect(new Set(ids).size).toBe(10);
  });

  test("a first page bigger than the thread returns everything with hasMore false", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-p", projectPath: "/p", provider: "opencode" });
    buildExchange(store, "t-p", 1);
    const page = store.loadThreadPage("t-p", { limit: 10 })!;
    expect(page.blocks.length).toBe(2);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
  });

  test("same-millisecond blocks tie-break on block id without gaps or duplicates", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-p", projectPath: "/p", provider: "opencode" });
    store.recordUserBlock({ threadId: "t-p", text: "a", at: 100 });
    store.recordUserBlock({ threadId: "t-p", text: "b", at: 100 });
    store.recordUserBlock({ threadId: "t-p", text: "c", at: 200 });
    const p1 = store.loadThreadPage("t-p", { limit: 1 })!;
    const p2 = store.loadThreadPage("t-p", { limit: 1, cursor: p1.nextCursor! })!;
    const p3 = store.loadThreadPage("t-p", { limit: 1, cursor: p2.nextCursor! })!;
    const texts = [...p1.blocks, ...p2.blocks, ...p3.blocks].map((b) =>
      b.role === "user" ? b.text : "",
    );
    expect(texts.sort()).toEqual(["a", "b", "c"]);
    expect(p1.hasMore).toBe(true);
    expect(p3.hasMore).toBe(false);
  });

  test("malformed and foreign-thread cursors degrade to a first-page request", async () => {
    const { encodeThreadPageCursor } = await import("./ConversationStore.js");
    const store = freshStore();
    store.ensureThread({ threadId: "t-p", projectPath: "/p", provider: "opencode" });
    store.recordUserBlock({ threadId: "t-p", text: "only", at: 100 });
    const foreign = encodeThreadPageCursor({ threadId: "other", beforeAnchorAt: 100, beforeBlockId: "x" });
    expect(store.loadThreadPage("t-p", { cursor: foreign })!.blocks.map((b) => b.at)).toEqual([100]);
    expect(store.loadThreadPage("t-p", { cursor: "garbage" })!.blocks.map((b) => b.at)).toEqual([100]);
  });

  test("an empty thread pages as empty without a cursor", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-p", projectPath: "/p", provider: "opencode" });
    const page = store.loadThreadPage("t-p")!;
    expect(page.blocks).toEqual([]);
    expect(page.hasMore).toBe(false);
    expect(page.nextCursor).toBeNull();
    expect(page.meta.threadId).toBe("t-p");
  });
});

describe("IPC wire projection (tool-call payload slimming)", () => {
  test("long tool_call details are capped for the wire, short ones pass through untouched", async () => {
    const { projectRuntimeItemForIpc, projectRuntimeEventForIpc, TOOL_DETAIL_WIRE_CAP } =
      await import("./ConversationStore.js");
    const long = "x".repeat(TOOL_DETAIL_WIRE_CAP + 5000);
    const item = { itemId: "i-1", kind: "tool_call" as const, status: "completed" as const, text: "run", detail: long };
    const projected = projectRuntimeItemForIpc(item);
    expect(projected.detail!.length).toBeLessThan(TOOL_DETAIL_WIRE_CAP + 200);
    expect(projected.detail!.startsWith("x".repeat(TOOL_DETAIL_WIRE_CAP))).toBe(true);

    const short = { itemId: "i-2", kind: "tool_call" as const, status: "completed" as const, text: "run", detail: "tiny" };
    expect(projectRuntimeItemForIpc(short)).toBe(short);

    // Text kinds are never slimmed — the streamed reply must arrive verbatim.
    const textItem = { itemId: "i-3", kind: "assistant_text" as const, status: "in-progress" as const, text: long };
    expect(projectRuntimeItemForIpc(textItem)).toBe(textItem);

    const event = {
      type: "item.completed" as const,
      threadId: "t-1",
      provider: "opencode" as const,
      at: 1,
      source: "kone.store" as const,
      turnId: "turn-1",
      item,
    };
    const projectedEvent = projectRuntimeEventForIpc(event);
    expect(projectedEvent).not.toBe(event);
    expect((projectedEvent as { item: typeof item }).item.detail!.length).toBeLessThan(
      TOOL_DETAIL_WIRE_CAP + 200,
    );
    // Non-item events cross untouched (same object).
    const other = { type: "turn.completed" as const, threadId: "t-1", provider: "opencode" as const, at: 1, source: "kone.store" as const, turnId: "turn-1" };
    expect(projectRuntimeEventForIpc(other)).toBe(other);
  });

  test("the store keeps the full payload; only the wire copy is capped", async () => {
    const { projectStoredThreadForIpc } = await import("./ConversationStore.js");
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    store.applyEvent(turnStarted("t-1", "turn-1", 10));
    const long = "y".repeat(20_000);
    store.applyEvent({
      type: "item.completed",
      threadId: "t-1",
      provider: "opencode",
      at: 11,
      source: "kone.store",
      turnId: "turn-1",
      item: { itemId: "i-1", kind: "tool_call", status: "completed", text: "run", detail: long },
    });
    const stored = store.loadThread("t-1")!;
    const storedItem = (stored.blocks[0] as { items: Array<{ detail?: string }> }).items[0]!;
    expect(storedItem.detail).toBe(long);
    const projected = projectStoredThreadForIpc(stored);
    const projectedItem = (projected.blocks[0] as { items: Array<{ detail?: string }> }).items[0]!;
    expect(projectedItem.detail!.length).toBeLessThan(10_000);
    expect(projectedItem.detail!.endsWith("local history)")).toBe(true);
  });

  test("nested subagent run items are projected too", async () => {
    const { projectRuntimeItemForIpc, TOOL_DETAIL_WIRE_CAP } = await import("./ConversationStore.js");
    const long = "z".repeat(TOOL_DETAIL_WIRE_CAP + 100);
    const parent = {
      itemId: "p-1",
      kind: "tool_call" as const,
      status: "completed" as const,
      text: "spawn",
      detail: "short",
      subagent: {
        toolUseId: "tu-1",
        status: "completed" as const,
        startedAt: 1,
        items: [
          {
            itemId: "c-1",
            kind: "tool_call" as const,
            status: "completed" as const,
            text: "child run",
            detail: long,
          },
        ],
      },
    };
    const projected = projectRuntimeItemForIpc(parent);
    expect(projected.subagent!.items[0]!.detail!.length).toBeLessThan(TOOL_DETAIL_WIRE_CAP + 100);
    expect(projected.subagent!.items[0]!.detail!.endsWith("local history)")).toBe(true);
    // Parent detail unchanged → the parent's own body crosses untouched.
    expect(projected.detail).toBe("short");
  });

  test("item updates fold into one store row — superseded updates never accumulate", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    store.applyEvent(turnStarted("t-1", "turn-1", 10));
    const base = {
      threadId: "t-1",
      provider: "opencode" as const,
      source: "kone.store" as const,
      turnId: "turn-1",
    };
    store.applyEvent({
      ...base,
      type: "item.started",
      at: 11,
      item: { itemId: "i-1", kind: "tool_call", status: "in-progress", text: "run", detail: "" },
    });
    for (let n = 1; n <= 3; n++) {
      store.applyEvent({
        ...base,
        type: "item.updated",
        at: 11 + n,
        item: { itemId: "i-1", kind: "tool_call", status: "in-progress", text: "run", detail: `delta ${n}` },
      });
    }
    store.applyEvent({
      ...base,
      type: "item.completed",
      at: 20,
      item: { itemId: "i-1", kind: "tool_call", status: "completed", text: "run", detail: "final" },
    });
    const raw = rawDb();
    const rows = raw
      .prepare(`SELECT * FROM items WHERE thread_id = 't-1' AND turn_id = 'turn-1' AND item_id = 'i-1'`)
      .all() as Array<{ status: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.detail).toBe("final");
    raw.close();
  });
});

// ── v20 durable turn queue ────────────────────────────────────────────────────

describe("v20 queued turns migration", () => {
  test("fresh DB opens at the current schema with the queued_turns table, thread index and active partial unique index", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(tables).toContain("queued_turns");
    for (const idx of ["idx_queued_turns_thread_state", "idx_queued_turns_active_user_block"]) {
      const found = raw
        .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
        .get(idx);
      expect(found, `index ${idx} should exist`).toBeDefined();
    }
    const cols = columnNames(raw, "queued_turns");
    for (const col of [
      "queue_id", "thread_id", "user_block_id", "dispatch_mode", "state", "input",
      "attachments_json", "model", "mode", "effort", "service_tier", "context_window",
      "attempt_count", "created_at", "updated_at", "promoted_at",
    ]) {
      expect(cols).toContain(col);
    }
    raw.close();
  });

  test("a v17 legacy DB upgrades through v20 to the current schema and re-opening the ladder is idempotent", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-migrate-v20-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(V17_THREADS);
    legacy.exec(`PRAGMA user_version = 17`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(21);
    // A re-open (a second process) runs the ladder again — every step must be
    // a no-op and the version must hold.
    const reopen = new ConversationStoreCtor();
    reopen.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const version2 = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version2.user_version).toBe(21);
    raw.close();
  });

  test("a claim stranded in 'promoting' by a crash is released to 'queued' at boot", () => {
    const store = freshStore();
    store.enqueueQueuedTurn({ queueId: "q-1", threadId: "t-1", userBlockId: "ub-1", input: "hi", at: 1 });
    const raw = rawDb();
    // Simulate a process killed between claim and promote/release.
    raw
      .prepare(
        `UPDATE queued_turns SET state = 'promoting', attempt_count = attempt_count + 1, updated_at = 2
          WHERE queue_id = 'q-1'`,
      )
      .run();
    raw.close();
    // A fresh store instance is the "next boot": the orphaned claim must be
    // claimable again, not stuck in 'promoting' forever.
    const rebooted = new ConversationStoreCtor();
    const claimed = rebooted.claimNextQueuedTurn("t-1");
    expect(claimed?.queueId).toBe("q-1");
    expect(claimed?.attemptCount).toBe(2); // the retry ledger survived the reboot
  });
});

describe("durable turn queue", () => {
  function enq(
    store: ConversationStoreType,
    queueId: string,
    threadId: string,
    userBlockId: string,
    input: string,
    at: number,
    opts: { dispatchMode?: "queue" | "steer"; attachments?: ChatAttachment[]; model?: string } = {},
  ): boolean {
    return store.enqueueQueuedTurn({ queueId, threadId, userBlockId, input, at, ...opts });
  }

  test("enqueue is idempotent per (thread_id, user_block_id): a replayed enqueue is a no-op", () => {
    const store = freshStore();
    expect(enq(store, "q-1", "t-1", "ub-1", "first", 1)).toBe(true);
    // Replay of the SAME prompt (same user block) — the partial unique index
    // over the active states makes it a no-op.
    expect(enq(store, "q-dup", "t-1", "ub-1", "first again", 2)).toBe(false);
    // A different prompt still enqueues.
    expect(enq(store, "q-2", "t-1", "ub-2", "second", 3)).toBe(true);
    const raw = rawDb();
    const rows = raw
      .prepare(`SELECT queue_id, input FROM queued_turns WHERE thread_id = 't-1' ORDER BY created_at`)
      .all() as Array<{ queue_id: string; input: string }>;
    expect(rows).toEqual([
      { queue_id: "q-1", input: "first" },
      { queue_id: "q-2", input: "second" },
    ]);
    raw.close();
  });

  test("a settled row does not block re-enqueue of the same user block", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "first", 1);
    store.claimNextQueuedTurn("t-1");
    store.markQueuedTurnPromoted("q-1");
    // The partial index only covers ACTIVE rows — a genuinely new turn carrying
    // the same user block enqueues once the old one has settled.
    expect(enq(store, "q-2", "t-1", "ub-1", "second", 2)).toBe(true);
  });

  test("claimNext orders steer-first (newest steer first) then FIFO, bumps attempt_count and flips to promoting", () => {
    const store = freshStore();
    enq(store, "q-queue-1", "t-1", "ub-1", "plain 1", 1);
    enq(store, "q-steer-1", "t-1", "ub-2", "steer 1", 2, { dispatchMode: "steer" });
    enq(store, "q-queue-2", "t-1", "ub-3", "plain 2", 3);
    enq(store, "q-steer-2", "t-1", "ub-4", "steer 2", 4, { dispatchMode: "steer" });

    // Newest steer first.
    let claimed = store.claimNextQueuedTurn("t-1");
    expect(claimed?.queueId).toBe("q-steer-2");
    expect(claimed?.state).toBe("promoting");
    expect(claimed?.attemptCount).toBe(1);
    // Then the older steer, then plain FIFO.
    claimed = store.claimNextQueuedTurn("t-1");
    expect(claimed?.queueId).toBe("q-steer-1");
    claimed = store.claimNextQueuedTurn("t-1");
    expect(claimed?.queueId).toBe("q-queue-1");
    claimed = store.claimNextQueuedTurn("t-1");
    expect(claimed?.queueId).toBe("q-queue-2");
    // Nothing left — claiming again is a no-op.
    expect(store.claimNextQueuedTurn("t-1")).toBeNull();
  });

  test("claimNext only claims the calling thread's rows", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-2", "ub-2", "two", 2);
    expect(store.claimNextQueuedTurn("t-1")?.queueId).toBe("q-1");
    expect(store.claimNextQueuedTurn("t-1")).toBeNull();
    expect(store.claimNextQueuedTurn("t-2")?.queueId).toBe("q-2");
  });

  test("attachments and replay knobs ride the row through claim", () => {
    const store = freshStore();
    const att: ChatAttachment = {
      type: "image",
      id: "a-1",
      name: "shot.png",
      mimeType: "image/png",
      sizeBytes: 42,
    };
    store.enqueueQueuedTurn({
      queueId: "q-1",
      threadId: "t-1",
      userBlockId: "ub-1",
      input: "",
      at: 1,
      attachments: [att],
      model: "gpt-x",
      mode: "chat",
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
    });
    const claimed = store.claimNextQueuedTurn("t-1");
    expect(claimed?.attachments).toEqual([att]);
    expect(claimed?.model).toBe("gpt-x");
    expect(claimed?.mode).toBe("chat");
    expect(claimed?.effort).toBe("high");
    expect(claimed?.serviceTier).toBe("fast");
    expect(claimed?.contextWindow).toBe("200k");
  });

  test("markQueuedTurnPromoted settles a claim and fails loudly on a lost claim", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-1", "ub-2", "two", 2);
    store.claimNextQueuedTurn("t-1"); // claims q-1
    expect(store.markQueuedTurnPromoted("q-1")).toBe(true);
    // Double-promote is a lost claim (row no longer 'promoting').
    expect(store.markQueuedTurnPromoted("q-1")).toBe(false);
    // Promoting a row nobody claimed fails loudly too.
    expect(store.markQueuedTurnPromoted("q-2")).toBe(false);
    const raw = rawDb();
    const row = raw
      .prepare(`SELECT state, promoted_at FROM queued_turns WHERE queue_id = 'q-1'`)
      .get() as { state: string; promoted_at: number | null };
    expect(row.state).toBe("promoted");
    expect(row.promoted_at).not.toBeNull();
    raw.close();
  });

  test("releaseQueuedTurn returns a failed claim to the queue; non-promoting rows can't release", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-1", "ub-2", "two", 2);
    store.claimNextQueuedTurn("t-1"); // claims q-1
    expect(store.releaseQueuedTurn("q-1")).toBe(true);
    // Reclaimed — the attempt count is the retry ledger and must survive.
    expect(store.claimNextQueuedTurn("t-1")?.attemptCount).toBe(2);
    // A row nobody claimed (still 'queued') is not releaseable.
    expect(store.releaseQueuedTurn("q-2")).toBe(false);
  });

  test("cancelQueuedTurnsForThread flips BOTH queued and promoting and returns the ids", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-1", "ub-2", "two", 2);
    enq(store, "q-3", "t-1", "ub-3", "three", 3);
    store.claimNextQueuedTurn("t-1"); // q-1 → promoting; q-2/q-3 stay queued
    const cancelled = store.cancelQueuedTurnsForThread("t-1");
    expect(cancelled.sort()).toEqual(["q-1", "q-2", "q-3"]);
    // The drain's late release must not resurrect a cancelled claim (a10e96595).
    expect(store.releaseQueuedTurn("q-1")).toBe(false);
    expect(store.listQueuedTurns("t-1")).toEqual([]);
    const raw = rawDb();
    const states = raw
      .prepare(`SELECT state FROM queued_turns WHERE thread_id = 't-1' ORDER BY queue_id`)
      .all() as Array<{ state: string }>;
    expect(states.every((r) => r.state === "cancelled")).toBe(true);
    raw.close();
  });

  test("cancelQueuedTurn flips a single active row and ignores settled rows", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-1", "ub-2", "two", 2);
    expect(store.cancelQueuedTurn("q-1")).toBe(true);
    // Already cancelled — nothing left to flip.
    expect(store.cancelQueuedTurn("q-1")).toBe(false);
    // A promoted row is history, not cancellable.
    store.claimNextQueuedTurn("t-1");
    store.markQueuedTurnPromoted("q-2");
    expect(store.cancelQueuedTurn("q-2")).toBe(false);
    const raw = rawDb();
    const states = raw
      .prepare(`SELECT state FROM queued_turns ORDER BY queue_id`)
      .all() as Array<{ state: string }>;
    expect(states).toEqual([{ state: "cancelled" }, { state: "promoted" }]);
    raw.close();
  });

  test("listQueuedTurns returns active rows only, steers first then FIFO, in claim order", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    enq(store, "q-2", "t-1", "ub-2", "two", 2, { dispatchMode: "steer" });
    enq(store, "q-3", "t-1", "ub-3", "three", 3);
    enq(store, "q-4", "t-1", "ub-4", "four", 4, { dispatchMode: "steer" });
    // Settle q-1 (promote) and q-4 (cancel): they must drop out of the list.
    store.claimNextQueuedTurn("t-1"); // q-4 (newest steer)
    store.markQueuedTurnPromoted("q-4");
    store.cancelQueuedTurn("q-1");
    const active = store.listQueuedTurns("t-1");
    expect(active.map((r) => r.queueId)).toEqual(["q-2", "q-3"]);
    expect(active[0]?.dispatchMode).toBe("steer");
    // The visible order is the claim order.
    expect(store.claimNextQueuedTurn("t-1")?.queueId).toBe("q-2");
    expect(store.claimNextQueuedTurn("t-1")?.queueId).toBe("q-3");
  });

  test("deleteThread removes queued turns for the whole subtree in its transaction", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "parent-1", projectPath: "/p", provider: "opencode" });
    store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("parent-1", "parent-1"),
    });
    enq(store, "q-1", "parent-1", "ub-1", "one", 1);
    enq(store, "q-2", "child-1", "ub-2", "two", 2);
    enq(store, "q-3", "other-1", "ub-3", "three", 3);
    expect(store.deleteThread("parent-1")).toEqual({ ok: true });
    const raw = rawDb();
    const rows = raw
      .prepare(`SELECT queue_id FROM queued_turns ORDER BY queue_id`)
      .all() as Array<{ queue_id: string }>;
    expect(rows).toEqual([{ queue_id: "q-3" }]); // the subtree's rows died with it
    raw.close();
  });

  test("setArchived leaves queued turns intact (archive is a reversible hide, not a stop)", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    expect(store.setArchived("t-1", true)).toEqual({ ok: true });
    expect(store.listQueuedTurns("t-1").map((r) => r.queueId)).toEqual(["q-1"]);
    expect(store.setArchived("t-1", false)).toEqual({ ok: true });
    expect(store.listQueuedTurns("t-1").map((r) => r.queueId)).toEqual(["q-1"]);
  });
});
