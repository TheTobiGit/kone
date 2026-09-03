import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import { MigrationLineageError, SCHEMA_VERSION, backupBeforeStep, migrate } from "./conversationMigrations.js";

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

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-store-test-")));
  return new ConversationStoreCtor();
}

function dbPath(): string {
  return path.join(testUserDataDir, "kone.sqlite");
}

function rawDb(): Database {
  return new Database(dbPath());
}

function columnNames(db: Database, table: string): string[] {
  // SAFETY: PRAGMA table_info answers one row per column, each carrying its name.
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

function item(
  threadId: string,
  turnId: string,
  itemId: string,
  kind: "assistant_text" | "reasoning_text" | "plan_text" | "tool_call",
  text: string,
): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "opencode",
    at: 10,
    source: "kone.store",
    item: {
      itemId,
      kind,
      status: "completed",
      text,
    },
  };
}

function tableNames(db: Database): string[] {
  return (
    // SAFETY: sqlite_master rows carry the object's name in `name`.
    db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
}

describe("v1 baseline migration and schema", () => {
  test("fresh DB opens at SCHEMA_VERSION = 1 with all baseline tables, columns, and indexes", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: SQLite answers this PRAGMA with one row whose only column is user_version.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    expect(version.user_version).toBe(1);

    const threads = columnNames(raw, "threads");
    for (const col of [
      "pinned_at",
      "archived_at",
      "last_activity_at",
      "model_selection_json",
      "resume_session_at",
      "parent_thread_id",
      "relationship_to_parent",
    ]) {
      expect(threads).toContain(col);
    }
    expect(threads).not.toContain("updated_at");
    expect(threads).not.toContain("lineage_json");
    expect(threads).not.toContain("is_pinned");

    const tables = tableNames(raw);
    for (const table of [
      "threads",
      "items",
      "blocks",
      "attachments",
      "subagents",
      "turn_usage",
      "queued_turns",
      "scratchpads",
      "gateway_ops",
      "agents",
      "project_agents",
      "thread_agents",
      "subagent_presets",
      "app_state",
      "schema_migrations",
    ]) {
      expect(tables).toContain(table);
    }

    // SAFETY: schema_migrations stores migration_id, name, and applied_at.
    const migrations = raw
      .prepare(`SELECT migration_id, name FROM schema_migrations ORDER BY migration_id`)
      .all() as Array<{ migration_id: number; name: string }>;
    expect(migrations).toEqual([{ migration_id: 1, name: "Baseline" }]);

    const idx = raw
      .prepare(
        `SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_threads_request_id'`,
      )
      .get();
    expect(idx).toBeDefined();
    raw.close();
  });

  test("PRAGMA foreign_keys = ON enforces cascade deletes and parent existence", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "p-1", projectPath: "/p", provider: "opencode" });
    store.writeSpawnedThread({
      threadId: "c-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("p-1", "p-1"),
    });

    store.applyEvent(turnStarted("p-1", "turn-1", 100));
    store.applyEvent(item("p-1", "turn-1", "i-1", "assistant_text", "hello"));
    store.applyEvent(tokenUsage("p-1", 100, { input: 10, output: 20 }));
    store.enqueueQueuedTurn({
      threadId: "p-1",
      queueId: "q-1",
      userBlockId: "ub-1",
      input: "test",
      at: 100,
    });
    store.reserveGatewayOp({
      threadId: "p-1",
      turnId: "turn-1",
      requestId: "req-1",
      kind: "spawn.thread",
      fingerprint: "fp",
    });

    store.applyEvent(turnCompleted("p-1", "turn-1", 150));

    // Deleting the parent thread cascades to child thread and all child tables.
    expect(store.deleteThread("p-1")).toEqual({ ok: true });

    const raw = rawDb();
    // SAFETY: counting rows answers one row with count column.
    const countThreads = raw.prepare(`SELECT COUNT(*) as n FROM threads`).get() as { n: number };
    expect(countThreads.n).toBe(0);

    // SAFETY: counting rows answers one row with count column.
    const countBlocks = raw.prepare(`SELECT COUNT(*) as n FROM blocks`).get() as { n: number };
    expect(countBlocks.n).toBe(0);

    // SAFETY: counting rows answers one row with count column.
    const countItems = raw.prepare(`SELECT COUNT(*) as n FROM items`).get() as { n: number };
    expect(countItems.n).toBe(0);

    // SAFETY: counting rows answers one row with count column.
    const countUsage = raw.prepare(`SELECT COUNT(*) as n FROM turn_usage`).get() as { n: number };
    expect(countUsage.n).toBe(0);

    // SAFETY: counting rows answers one row with count column.
    const countQueued = raw.prepare(`SELECT COUNT(*) as n FROM queued_turns`).get() as { n: number };
    expect(countQueued.n).toBe(0);

    // SAFETY: counting rows answers one row with count column.
    const countOps = raw.prepare(`SELECT COUNT(*) as n FROM gateway_ops`).get() as { n: number };
    expect(countOps.n).toBe(0);

    raw.close();
  });

  test("Foreign key rejects dangling parent_thread_id", () => {
    freshStore();
    const raw = rawDb();
    raw.exec("PRAGMA foreign_keys = ON;");
    expect(() => {
      raw
        .prepare(
          `INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at, parent_thread_id)
           VALUES ('dangling-child', '/p', 'opencode', 1, 1, 'non-existent-parent')`,
        )
        .run();
    }).toThrow();
    raw.close();
  });

  test("MigrationLineageError is thrown if recorded migration names diverge from manifest", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-lineage-"));
    const file = path.join(dir, "kone.sqlite");
    const raw = new Database(file);
    raw.exec(`
      CREATE TABLE schema_migrations (
        migration_id INTEGER PRIMARY KEY,
        name         TEXT NOT NULL,
        applied_at   INTEGER NOT NULL
      );
      INSERT INTO schema_migrations (migration_id, name, applied_at)
        VALUES (1, 'DivergentBaseline', 12345);
      PRAGMA user_version = 1;
    `);

    expect(() => {
      migrate(raw, file);
    }).toThrow(MigrationLineageError);
    raw.close();
  });

  test("migrate supports toMigrationInclusive option", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-inclusive-"));
    const file = path.join(dir, "kone.sqlite");
    const raw = new Database(file);

    migrate(raw, file, { toMigrationInclusive: 0 });

    // SAFETY: PRAGMA user_version projects one column.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(0);
    expect(tableNames(raw)).toContain("schema_migrations");
    expect(tableNames(raw)).not.toContain("threads");
    raw.close();
  });

  test("a DB from a NEWER build is refused, not rewound", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-newer-"));
    const legacy = new Database(path.join(dir, "kone.sqlite"));
    legacy.exec(`PRAGMA user_version = 99`);
    legacy.close();

    useUserDataDir(dir);
    const store = new ConversationStoreCtor();
    // Persistence disabled for this process: reads no-op, writes no-op.
    expect(store.listThreads("/p")).toEqual([]);
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: SQLite answers this PRAGMA with one row whose only column is user_version.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(99);
    raw.close();
  });

  test("an unusable DB is opened once, not once per call", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-latch-"));
    const legacy = new Database(path.join(dir, "kone.sqlite"));
    legacy.exec(`PRAGMA user_version = 99`);
    legacy.close();

    useUserDataDir(dir);
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(String(args[0]));
    try {
      const store = new ConversationStoreCtor();
      // Every one of these routes through handle(). Without a latch each would
      // reopen the file and re-run the whole migration ladder.
      store.listThreads("/p");
      store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
      store.threadMeta("t-1");
      store.listThreads("/p");
      store.setPinned("t-1", true);

      const opens = logged.filter((line) => line.includes("could not open database"));
      expect(opens.length).toBe(1);
    } finally {
      console.error = realError;
    }
  });

  /** A ConversationStore's private open-retry bookkeeping — the unusable flag
   *  and retry cooldown — reached for white-box assertions. */
  type StoreInternals = { unusable: boolean; retryOpenAfter: number };
  // SAFETY: white-box seam — s really is the store instance; only private flags are read.
  const storeInternals = (s: InstanceType<typeof ConversationStoreCtor>): StoreInternals =>
    s as StoreInternals;

  test("a failure that isn't the schema stays retryable after its cooldown", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-transient-"));
    // A file that isn't a database at all: opening it throws, but replacing it
    // later must not require restarting the app.
    writeFileSync(path.join(dir, "kone.sqlite"), "not a database");

    useUserDataDir(dir);
    const logged: string[] = [];
    const realError = console.error;
    console.error = (...args: unknown[]) => void logged.push(String(args[0]));
    try {
      const store = new ConversationStoreCtor();
      store.listThreads("/p");
      store.listThreads("/p");
      // Still rate-limited to one attempt, but by a cooldown rather than for good.
      expect(logged.filter((l) => l.includes("could not open database")).length).toBe(1);
      expect(storeInternals(store).unusable).toBe(false);
      expect(storeInternals(store).retryOpenAfter).toBeGreaterThan(Date.now());

      // Once the file is a real database and the cooldown has passed, the store
      // recovers on its own.
      rmSync(path.join(dir, "kone.sqlite"));
      storeInternals(store).retryOpenAfter = 0;
      store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
      expect(store.threadMeta("t-1")?.provider).toBe("opencode");
      expect(logged.filter((l) => l.includes("could not open database")).length).toBe(1);
    } finally {
      console.error = realError;
    }
  });

  test("backups before migration steps are pruned to 3", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-store-prune-"));
    const stale = [1000, 2000, 3000, 4000, 5000].map((at) => `kone.sqlite.bak-${at}`);
    for (const name of stale) writeFileSync(path.join(dir, name), "old");
    writeFileSync(path.join(dir, "kone.sqlite.bak-manual"), "keep me");

    const file = path.join(dir, "kone.sqlite");
    const raw = new Database(file);
    backupBeforeStep(raw, file);
    raw.close();

    const dated = readdirSync(dir)
      .filter((f) => /^kone\.sqlite\.bak-\d+$/.test(f))
      .sort();
    // Capped to retention = 3.
    expect(dated.length).toBeLessThanOrEqual(3);
    expect(readdirSync(dir)).toContain("kone.sqlite.bak-manual");
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
      mode: "full-access",
    });
    const meta = store.threadMeta("t-1");
    expect(meta?.isPinned).toBe(true);
    expect(meta?.model).toBe("gpt-5.6-sol");
    expect(meta?.selection).toEqual({
      effort: "max",
      serviceTier: "fast",
      contextWindow: "200k",
      mode: "full-access",
    });

    // Absent fields are left untouched; unpin clears.
    store.setThreadSelection("t-1", { effort: "high" });
    expect(store.threadMeta("t-1")?.selection).toEqual({
      effort: "high",
      serviceTier: "fast",
      contextWindow: "200k",
      mode: "full-access",
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

describe("listThreads archive views", () => {
  test("the live list and the archive are disjoint views of the same table", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "live", projectPath: "/p", provider: "codex" });
    store.ensureThread({ threadId: "put-away", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "live", text: "first", at: 100 });
    store.recordUserBlock({ threadId: "put-away", text: "second", at: 200 });
    store.setArchived("put-away", true);

    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["live"]);
    expect(store.listThreads("/p", { archived: true }).map((t) => t.threadId)).toEqual(["put-away"]);
    // The default and an explicit `false` are the same request.
    expect(store.listThreads("/p", { archived: false }).map((t) => t.threadId)).toEqual(["live"]);
  });

  test("un-archiving moves a thread back across the two views", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "hello", at: 100 });

    store.setArchived("a", true);
    expect(store.listThreads("/p")).toEqual([]);
    expect(store.listThreads("/p", { archived: true }).map((t) => t.threadId)).toEqual(["a"]);

    store.setArchived("a", false);
    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["a"]);
    expect(store.listThreads("/p", { archived: true })).toEqual([]);
  });

  test("the archive still requires a real user turn", () => {
    const store = freshStore();
    // Started but never spoken to. Archiving it must not smuggle it into a list
    // the live view would have refused to show.
    store.ensureThread({ threadId: "empty", projectPath: "/p", provider: "codex" });
    store.setArchived("empty", true);

    expect(store.listThreads("/p", { archived: true })).toEqual([]);
  });

  test("listThreads returns the latest snippet from the agent response", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-snip", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "t-snip", text: "What is the capital of France?", at: 100 });

    // Initial user block only -> no agent response yet
    let threads = store.listThreads("/p");
    expect(threads[0]?.snippet).toBeUndefined();

    // Assistant response arrives -> latest assistant text becomes the snippet
    store.applyEvent({
      type: "turn.started",
      threadId: "t-snip",
      turnId: "turn-1",
      at: 200,
    });
    store.applyEvent({
      type: "item.completed",
      threadId: "t-snip",
      turnId: "turn-1",
      at: 210,
      item: {
        itemId: "item-1",
        kind: "assistant_text",
        status: "completed",
        text: "The capital of France is Paris.\nIt is known for its art and culture.",
      },
    });
    threads = store.listThreads("/p");
    expect(threads[0]?.snippet).toBe("The capital of France is Paris.");
  });
});

describe("setDone", () => {
  test("marking a thread done stamps it; un-marking clears the stamp", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "hello", at: 100 });

    expect(store.threadMeta("a")?.doneAt).toBeNull();

    const before = Date.now();
    store.setDone("a", true);
    const stamp = store.threadMeta("a")?.doneAt;
    expect(stamp).not.toBeNull();
    expect(stamp!).toBeGreaterThanOrEqual(before);

    // Un-marking writes epoch zero, not NULL. "You never said" and "you said
    // not done" are different answers, and only the first one may later be
    // overruled by the thread going quiet for long enough.
    store.setDone("a", false);
    expect(store.threadMeta("a")?.doneAt).toBe(0);
  });

  test("done leaves the thread in the live list and out of the archive", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "hello", at: 100 });
    store.setDone("a", true);

    // Done is not archive. The thread stays exactly where it was; only the
    // stamp on it changed, and it is the reader that decides what to do with
    // one.
    expect(store.listThreads("/p").map((t) => t.threadId)).toEqual(["a"]);
    expect(store.listThreads("/p", { archived: true })).toEqual([]);
  });

  test("a turn after the mark leaves the thread asking again", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "hello", at: 100 });
    store.setDone("a", true);

    const marked = store.threadMeta("a")!;
    expect(marked.doneAt!).toBeGreaterThanOrEqual(marked.lastActivityAt!);

    store.recordUserBlock({ threadId: "a", text: "and another thing", at: Date.now() + 1000 });

    // Nothing cleared the stamp — the thread simply stopped satisfying the
    // predicate, which is the whole reason it is a timestamp and not a flag.
    const spoken = store.threadMeta("a")!;
    expect(spoken.doneAt).not.toBeNull();
    expect(spoken.doneAt!).toBeLessThan(spoken.lastActivityAt!);
  });

  test("marking an unknown thread does nothing and does not throw", () => {
    const store = freshStore();
    expect(() => store.setDone("never-existed", true)).not.toThrow();
    expect(store.threadMeta("never-existed")).toBeNull();
  });
});

describe("setVisited", () => {
  // Creating a thread stamps a visit of its own — you are looking at what you
  // just made — so these count forward from that rather than from arbitrary
  // small numbers, which the forward-only rule would now refuse.
  test("a thread is born visited, so it does not read as unread before anyone opens it", () => {
    const store = freshStore();
    const before = Date.now();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });

    const born = store.threadMeta("a")!;
    expect(born.lastVisitedAt!).toBeGreaterThanOrEqual(before);
    expect(born.lastVisitedAt!).toBeGreaterThanOrEqual(born.lastActivityAt!);
  });

  test("a visit stamps the thread; a later visit moves the stamp forward", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    const born = store.threadMeta("a")!.lastVisitedAt!;
    store.recordUserBlock({ threadId: "a", text: "hello", at: born + 100 });

    store.setVisited("a", born + 500);
    expect(store.threadMeta("a")?.lastVisitedAt).toBe(born + 500);

    store.setVisited("a", born + 900);
    expect(store.threadMeta("a")?.lastVisitedAt).toBe(born + 900);
  });

  test("an older visit is ignored — two surfaces showing one thread cannot undo each other", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    const born = store.threadMeta("a")!.lastVisitedAt!;
    store.recordUserBlock({ threadId: "a", text: "hello", at: born + 100 });

    store.setVisited("a", born + 900);
    store.setVisited("a", born + 500);
    expect(store.threadMeta("a")?.lastVisitedAt).toBe(born + 900);
  });

  test("force writes backwards — the only way to say unread again", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    const born = store.threadMeta("a")!.lastVisitedAt!;
    store.recordUserBlock({ threadId: "a", text: "hello", at: born + 100 });

    store.setVisited("a", born + 900);
    store.setVisited("a", born + 500, true);
    expect(store.threadMeta("a")?.lastVisitedAt).toBe(born + 500);
  });

  test("a turn after the visit is what makes a thread unread", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "hello", at: 100 });
    store.setVisited("a", Date.now());

    const seen = store.threadMeta("a")!;
    expect(seen.lastVisitedAt!).toBeGreaterThanOrEqual(seen.lastActivityAt!);

    store.recordUserBlock({ threadId: "a", text: "and another thing", at: Date.now() + 1000 });

    // Nothing wrote to the visit stamp — the thread simply stopped satisfying
    // the predicate, which is why unread is a comparison and not a flag.
    const spoken = store.threadMeta("a")!;
    expect(spoken.lastVisitedAt!).toBeLessThan(spoken.lastActivityAt!);
  });

  test("visiting an unknown thread does nothing and does not throw", () => {
    const store = freshStore();
    expect(() => store.setVisited("never-existed", 500)).not.toThrow();
    expect(store.threadMeta("never-existed")).toBeNull();
  });
});

describe("latestThreadMeta", () => {
  test("picks the most recently active thread for a project, metadata only", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.ensureThread({ threadId: "b", projectPath: "/p", provider: "codex" });
    store.ensureThread({ threadId: "other-project", projectPath: "/q", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "first", at: 100 });
    store.recordUserBlock({ threadId: "b", text: "second", at: 200 });

    const meta = store.latestThreadMeta("/p");
    expect(meta?.threadId).toBe("b");
    expect(meta?.projectPath).toBe("/p");
    // Metadata only — no transcript field, unlike `loadThread`'s StoredThread.
    expect(meta && "blocks" in meta).toBe(false);

    expect(store.latestThreadMeta("/q")?.threadId).toBe("other-project");
    expect(store.latestThreadMeta("/does-not-exist")).toBeNull();
  });

  test("ignores archived threads", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "a", projectPath: "/p", provider: "codex" });
    store.ensureThread({ threadId: "b", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "a", text: "first", at: 100 });
    store.recordUserBlock({ threadId: "b", text: "second", at: 200 });
    store.setArchived("b", true);

    expect(store.latestThreadMeta("/p")?.threadId).toBe("a");
  });
});

describe("staleThreadIds (retention candidates)", () => {
  const DAY = 24 * 60 * 60 * 1000;

  test("selects stale, live, unpinned roots; done threads only when not undone-only", () => {
    const store = freshStore();
    const old = () => Date.now() - 4 * DAY;
    // Block writes stamp the transcript, not the thread's recency columns — the
    // retention cutoffs read last_activity_at and last_visited_at, so both are
    // written directly. Both, because a thread is only stale when every signal
    // it carries is past the cutoff, and creating one stamps a visit.
    function backdate(threadId: string, at: number): void {
      const raw = rawDb();
      raw
        .prepare(`UPDATE threads SET last_activity_at = ?, last_visited_at = ? WHERE thread_id = ?`)
        .run(at, at, threadId);
      raw.close();
    }
    // Old and never marked → the done pass's prime candidate.
    store.ensureThread({ threadId: "old", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old", text: "hi", at: old() });
    backdate("old", old());
    // Recent activity → stale to no pass.
    store.ensureThread({ threadId: "fresh", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "fresh", text: "hi", at: Date.now() });
    // Old but already done (the stamp outdates nothing — done_at > activity).
    store.ensureThread({ threadId: "old-done", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-done", text: "hi", at: old() });
    backdate("old-done", old());
    store.setDone("old-done", true);
    // Old with done_at = 0: the user said "not finished", which outranks age.
    store.ensureThread({ threadId: "old-kept", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-kept", text: "hi", at: old() });
    backdate("old-kept", old());
    store.setDone("old-kept", false);
    // Old and pinned — a pin is a keep-me.
    store.ensureThread({ threadId: "old-pinned", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-pinned", text: "hi", at: old() });
    backdate("old-pinned", old());
    store.setPinned("old-pinned", true);
    // Old with queued work — the sweep must not cancel what the user asked for.
    store.ensureThread({ threadId: "old-queued", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-queued", text: "hi", at: old() });
    backdate("old-queued", old());
    store.enqueueQueuedTurn({
      queueId: "q-stale",
      threadId: "old-queued",
      userBlockId: "ub-stale",
      input: "later",
      at: Date.now(),
    });
    // Old with a spawned child mid-turn — the sweep tidies nothing live.
    store.ensureThread({ threadId: "old-busy", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-busy", text: "hi", at: old() });
    backdate("old-busy", old());
    store.writeSpawnedThread({
      threadId: "old-busy-child",
      projectPath: "/p",
      provider: "codex",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("old-busy", "old-busy"),
    });
    store.applyEvent(turnStarted("old-busy-child", "turn-stale", 10));

    // Old work, but someone reads it every few days: a reference thread nobody
    // replies in and nobody pins. Activity alone would archive it out from
    // under them — the visit is the human half of "has anyone touched this".
    store.ensureThread({ threadId: "old-read", projectPath: "/p", provider: "codex" });
    store.recordUserBlock({ threadId: "old-read", text: "hi", at: old() });
    backdate("old-read", old());
    store.setVisited("old-read", Date.now(), true);

    // The done pass sees exactly the old, undone, quiet, still thread.
    expect(store.staleThreadIds({ unusedMs: 3 * DAY, limit: 25, undone: true })).toEqual([
      "old",
    ]);
    // The archive pass also takes threads already marked done — done is not a
    // terminal state, seven days of silence after it still puts a thread away.
    // Pinned, queued, and busy threads are excluded from both passes.
    expect(
      store
        .staleThreadIds({ unusedMs: 3 * DAY, limit: 25 })
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual(["old", "old-done", "old-kept"]);
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
    // SAFETY: the write above landed one row; only turn_id is read off it.
    const usage = raw
      .prepare(`SELECT * FROM turn_usage WHERE thread_id = 'child-1'`)
      .get() as { turn_id: string } | undefined;
    expect(usage?.turn_id).toBe("turn-1");
    raw.close();

    expect(store.deleteThread("parent-1")).toEqual({ ok: true });
    const after = rawDb();
    for (const table of ["threads", "blocks", "items", "subagents", "gateway_ops", "turn_usage", "attachments"]) {
      // SAFETY: COUNT(*) always comes back under the alias n.
      const n = (
        after
          .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE thread_id IN ('parent-1', 'child-1')`)
          .get() as { n: number }
      ).n;
      expect(n, `${table} should be empty after cascade`).toBe(0);
    }
    after.close();
  });

  test("listSubtreeAttachments includes spawned descendants, not siblings", () => {
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
    store.writeSpawnedThread({
      threadId: "grand-1",
      projectPath: "/p",
      provider: "opencode",
      createdAt: 20,
      title: "Grandchild",
      lineage: spawnedLineage("child-1", "parent-1"),
    });
    store.ensureThread({ threadId: "sibling-1", projectPath: "/p", provider: "opencode" });

    const att = (
      id: string,
      threadId: string,
    ): Parameters<ConversationStoreType["registerAttachment"]>[0] => ({
      id,
      threadId,
      type: "file",
      name: `${id}.txt`,
      mimeType: "text/plain",
      sizeBytes: 1,
      relPath: `${id}.txt`,
      createdAt: 1,
    });
    store.registerAttachment(att("att_p", "parent-1"));
    store.registerAttachment(att("att_c", "child-1"));
    store.registerAttachment(att("att_g", "grand-1"));
    store.registerAttachment(att("att_s", "sibling-1"));

    expect(
      store.listSubtreeAttachments("parent-1").map((row) => row.id).sort(),
    ).toEqual(["att_c", "att_g", "att_p"]);
    expect(store.listThreadAttachments("parent-1").map((row) => row.id)).toEqual(["att_p"]);
    expect(store.listSubtreeAttachments("sibling-1").map((row) => row.id)).toEqual(["att_s"]);
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
    expect(store.setArchived("parent-1", true)).toEqual({
      ok: false,
      reason: "busy",
    });
    store.applyEvent(turnCompleted("child-1", "turn-1", 20));
    // Success names every thread the stamp landed on, ancestor-first — the
    // caller announces the change per thread from this list.
    expect(store.setArchived("parent-1", true)).toEqual({
      ok: true,
      threadIds: ["parent-1", "child-1"],
    });
    const raw = rawDb();
    // SAFETY: the SELECT projects exactly the archived_at column.
    const archived = (id: string) =>
      (raw.prepare(`SELECT archived_at FROM threads WHERE thread_id = ?`).get(id) as {
        archived_at: number | null;
      }).archived_at;
    expect(archived("parent-1")).not.toBeNull();
    expect(archived("child-1")).not.toBeNull(); // subtree archived with the parent
    // Restore un-archives the subtree too.
    expect(store.setArchived("parent-1", false)).toEqual({
      ok: true,
      threadIds: ["parent-1", "child-1"],
    });
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
    // SAFETY: the event written above lands exactly these columns.
    const usage = raw
      .prepare(`SELECT * FROM turn_usage WHERE thread_id = 't-1' AND turn_id = 'turn-1'`)
      .get() as { input_tokens: number; output_tokens: number; total_tokens: number; at: number };
    expect(usage.input_tokens).toBe(30);
    expect(usage.output_tokens).toBe(20);
    expect(usage.total_tokens).toBe(50);
    expect(usage.at).toBe(20); // latest event wins
    raw.close();
  });

  test("an explicit compactsAutomatically: false survives the store round-trip", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    // SAFETY: the literal carries every field read back; only compactsAutomatically matters.
    store.applyEvent({
      type: "thread.token-usage.updated",
      threadId: "t-1",
      provider: "opencode",
      at: 15,
      source: "kone.store",
      usage: { contextWindow: 200000, contextUsed: 120000, compactsAutomatically: false },
    } as RuntimeEvent);

    // The write path keeps a tri-state (null = unknown, 0 = false, 1 = true);
    // the read path must preserve an explicit false rather than collapsing it
    // into "unknown" (undefined).
    expect(store.threadMeta("t-1")?.compactsAutomatically).toBe(false);
  });

  test("an explicit compactsAutomatically: true survives the store round-trip", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    // SAFETY: the literal carries every field read back; only compactsAutomatically matters.
    store.applyEvent({
      type: "thread.token-usage.updated",
      threadId: "t-1",
      provider: "opencode",
      at: 15,
      source: "kone.store",
      usage: { contextWindow: 200000, contextUsed: 120000, compactsAutomatically: true },
    } as RuntimeEvent);
    expect(store.threadMeta("t-1")?.compactsAutomatically).toBe(true);
  });

  test("token-usage for antigravity keeps the max running total across turns", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-anty", projectPath: "/p", provider: "antigravity" });
    store.applyEvent(turnStarted("t-anty", "turn-1", 10));
    store.applyEvent(
      tokenUsage(
        "t-anty",
        15,
        { input: 100, output: 50, total: 150 },
        "antigravity",
      ),
    );
    // Running total: next turn reports cumulative total 220
    store.applyEvent(
      tokenUsage(
        "t-anty",
        20,
        { input: 140, output: 80, total: 220 },
        "antigravity",
      ),
    );
    expect(store.threadMeta("t-anty")?.tokens).toBe(220);
  });

  test("backfills token totals for stored Antigravity threads on store initialization", async () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-backfill", projectPath: "/p", provider: "antigravity" });

    // Set conversation_id on the thread row, with tokens as NULL
    const raw = rawDb();
    raw.prepare("UPDATE threads SET conversation_id = 'conv-backfill-1', tokens = NULL WHERE thread_id = 't-backfill'").run();
    raw.close();

    // Create the conversation database under temporary ANTIGRAVITY_CONVERSATIONS_DIR
    const antyDir = mkdtempSync(path.join(tmpdir(), "kone-anty-backfill-"));
    const convDb = new Database(path.join(antyDir, "conv-backfill-1.db"));
    convDb.exec("CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)");
    const insert = convDb.prepare("INSERT INTO gen_metadata (idx, data) VALUES (?, ?)");

    function varint(value: number): number[] {
      const out: number[] = [];
      let v = BigInt(value);
      while (v > 0x7fn) {
        out.push(Number(v & 0x7fn) | 0x80);
        v >>= 7n;
      }
      out.push(Number(v));
      return out;
    }
    function key(field: number, wireType: number): number[] {
      return varint((field << 3) | wireType);
    }
    function fieldVarint(field: number, value: number): number[] {
      return [...key(field, 0), ...varint(value)];
    }
    function fieldBytes(field: number, bytes: Uint8Array): number[] {
      return [...key(field, 2), ...varint(bytes.length), ...bytes];
    }
    function encodeMessage(fields: number[][]): Uint8Array {
      return Uint8Array.from(fields.flat());
    }
    const rowBytes = encodeMessage([
      fieldBytes(1, encodeMessage([
        fieldBytes(4, encodeMessage([
          fieldVarint(2, 500),
          fieldVarint(3, 200),
          fieldVarint(9, 150),
          fieldVarint(10, 50),
          fieldBytes(11, new TextEncoder().encode("r1")),
        ])),
        fieldBytes(21, new TextEncoder().encode("Gemini 3.5 Flash (High)")),
      ])),
    ]);
    insert.run(0, rowBytes);
    convDb.close();

    process.env.ANTIGRAVITY_CONVERSATIONS_DIR = antyDir;
    try {
      const rehydrated = new ConversationStoreCtor();
      const meta = rehydrated.threadMeta("t-backfill");
      expect(meta?.tokens).toBe(700);
      expect(meta?.contextUsed).toBe(700);
      expect(meta?.contextWindow).toBe(1_000_000);
      expect(meta?.compactsAutomatically).toBe(true);
    } finally {
      delete process.env.ANTIGRAVITY_CONVERSATIONS_DIR;
      rmSync(antyDir, { recursive: true, force: true });
    }
  });
});

describe("v19 keyset index migration", () => {
  test("fresh DB opens at the current schema with the blocks keyset index", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: SQLite answers this PRAGMA with one row whose only column is user_version.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    const idx = raw
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_blocks_keyset'`)
      .get();
    expect(idx).toBeDefined();
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
    // SAFETY: the projected event wraps the same item shape this test built.
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
    // SAFETY: block 0 of this fixture is the tool_call group holding i-1.
    const storedItem = (stored.blocks[0] as { items: Array<{ detail?: string }> }).items[0]!;
    expect(storedItem.detail).toBe(long);
    const projected = projectStoredThreadForIpc(stored);
    // SAFETY: projection preserves the block/item order of the stored thread.
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
    // SAFETY: the SELECT targets the single row written above; status/detail are its columns.
    const rows = raw
      .prepare(`SELECT * FROM items WHERE thread_id = 't-1' AND turn_id = 'turn-1' AND item_id = 'i-1'`)
      .all() as Array<{ status: string; detail: string }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("completed");
    expect(rows[0]!.detail).toBe("final");
    raw.close();
  });
});

describe("studio plane in app_state", () => {
  test("fresh DB opens with the app_state table and no project_boards or studio", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: sqlite_master rows carry the object's name in `name`.
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(tables).toContain("app_state");
    // The legacy tables are gone, not merely unused.
    expect(tables).not.toContain("project_boards");
    expect(tables).not.toContain("studio");
    expect(store.loadStudio()).toBeNull();
    raw.close();
  });

  test("the plane round-trips through save and reopen, and refuses a foreign version", () => {
    const store = freshStore();
    const layout = {
      version: 2 as const,
      rows: [{ projectPath: "/p", panes: [{ id: "p1" }], focusedId: "p1" }],
      focusedRow: "/p",
    };
    expect(store.saveStudio(layout)?.savedAt).toBeGreaterThan(0);
    expect(store.loadStudio()).toEqual(layout);

    // A document from a build that moved on is not readable as this shape, and
    // an unreadable plane is an empty one — never a half-applied layout.
    const raw = rawDb();
    raw
      .prepare(`UPDATE app_state SET value = ? WHERE key = 'studio_layout'`)
      .run(JSON.stringify({ version: 3, rows: [], focusedRow: null }));
    raw.close();
    expect(new ConversationStoreCtor().loadStudio()).toBeNull();
  });
});

describe("queued turns schema", () => {
  test("fresh DB opens at the current schema with the queued_turns table and pending index", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: SQLite answers this PRAGMA with one row whose only column is user_version.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    // SAFETY: sqlite_master rows carry the object's name in `name`.
    const tables = (raw.prepare(`SELECT name FROM sqlite_master WHERE type = 'table'`).all() as Array<{
      name: string;
    }>).map((r) => r.name);
    expect(tables).toContain("queued_turns");
    const found = raw
      .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = 'idx_queued_turns_pending'`)
      .get();
    expect(found, `index idx_queued_turns_pending should exist`).toBeDefined();

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

  test("re-opening the store is idempotent and preserves SCHEMA_VERSION", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    const raw = rawDb();
    // SAFETY: SQLite answers this PRAGMA with one row whose only column is user_version.
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(SCHEMA_VERSION);
    // A re-open (a second process) runs the migrations again — every step must be
    // a no-op and the version must hold.
    const reopen = new ConversationStoreCtor();
    reopen.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    // SAFETY: Same PRAGMA row shape as every read above.
    const version2 = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version2.user_version).toBe(SCHEMA_VERSION);
    raw.close();
  });

  test("a claim stranded in 'promoting' by a crash is released to 'queued' at boot", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
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
    expect(claimed?.attemptCount).toBe(2);
  });

  function enq(
    store: ConversationStoreType,
    queueId: string,
    threadId: string,
    userBlockId: string,
    input: string,
    at: number,
    opts: { dispatchMode?: "queue" | "steer"; attachments?: ChatAttachment[]; model?: string } = {},
  ): boolean {
    store.ensureThread({ threadId, projectPath: "/p", provider: "opencode" });
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
    // SAFETY: the SELECT names exactly queue_id and input.
    const rows = raw
      .prepare(`SELECT queue_id, input FROM queued_turns WHERE thread_id = 't-1' ORDER BY created_at`)
      .all() as Array<{ queue_id: string; input: string }>;
    expect(rows).toEqual([
      { queue_id: "q-1", input: "first" },
      { queue_id: "q-2", input: "second" },
    ]);
    raw.close();
  });

  test("rows enqueued in the same millisecond claim in arrival order", () => {
    const store = freshStore();
    // created_at is a millisecond clock, so a burst ties on it. The tiebreak
    // must be arrival (rowid), not the random queue_id it used to be.
    enq(store, "q-zzz", "t-1", "ub-1", "first", 7);
    enq(store, "q-aaa", "t-1", "ub-2", "second", 7);
    enq(store, "q-mmm", "t-1", "ub-3", "third", 7);
    expect(store.listQueuedTurns("t-1").map((r) => r.input)).toEqual([
      "first",
      "second",
      "third",
    ]);
    expect(store.claimNextQueuedTurn("t-1")?.input).toBe("first");
    expect(store.claimNextQueuedTurn("t-1")?.input).toBe("second");
  });

  test("steers enqueued in the same millisecond claim newest-first", () => {
    const store = freshStore();
    enq(store, "q-s1", "t-1", "ub-1", "steer old", 7, { dispatchMode: "steer" });
    enq(store, "q-s2", "t-1", "ub-2", "steer new", 7, { dispatchMode: "steer" });
    expect(store.claimNextQueuedTurn("t-1")?.input).toBe("steer new");
  });

  test("cancelQueuedTurn refuses a row a drain has already claimed", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "already running", 1);
    // The drain claimed it and is awaiting adapter.sendTurn — the turn is on
    // its way to the provider.
    expect(store.claimNextQueuedTurn("t-1")?.queueId).toBe("q-1");

    // The user hits ✕ on the chip. Reporting success here would emit
    // turn.queued-cancelled(reason "user") for a turn that runs anyway.
    expect(store.cancelQueuedTurn("q-1")).toBe(false);

    // The row is still the drain's to settle.
    expect(store.markQueuedTurnPromoted("q-1")).toBe(true);
  });

  test("the stop path still cancels a claimed row", () => {
    const store = freshStore();
    enq(store, "q-1", "t-1", "ub-1", "doomed", 1);
    store.claimNextQueuedTurn("t-1");
    // Unlike the per-item cancel, a stop tears the session down regardless —
    // and flipping 'promoting' is what stops the drain's error path from
    // releasing the row back to 'queued'.
    expect(store.cancelQueuedTurnsForThread("t-1")).toEqual(["q-1"]);
    expect(store.releaseQueuedTurn("q-1")).toBe(false);
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
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
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
    // SAFETY: the SELECT projects exactly state and promoted_at.
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
    expect(store.releaseQueuedTurn("q-1")).toBe(false);
    expect(store.listQueuedTurns("t-1")).toEqual([]);
    const raw = rawDb();
    // SAFETY: the SELECT projects exactly the state column.
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
    // SAFETY: the SELECT projects exactly the state column.
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
    // SAFETY: the SELECT projects exactly the queue_id column.
    const rows = raw
      .prepare(`SELECT queue_id FROM queued_turns ORDER BY queue_id`)
      .all() as Array<{ queue_id: string }>;
    expect(rows).toEqual([{ queue_id: "q-3" }]); // the subtree's rows died with it
    raw.close();
  });

  test("setArchived touches only the threads table — queue rows are the caller's business", () => {
    // The store primitive stays pure data: cancelling the subtree's queued
    // turns (and announcing it) is AgentService.setThreadArchived's job, so
    // the store has no event stream to emit from. This pins that split.
    const store = freshStore();
    store.ensureThread({ threadId: "t-1", projectPath: "/p", provider: "opencode" });
    enq(store, "q-1", "t-1", "ub-1", "one", 1);
    expect(store.setArchived("t-1", true)).toEqual({ ok: true, threadIds: ["t-1"] });
    expect(store.listQueuedTurns("t-1").map((r) => r.queueId)).toEqual(["q-1"]);
    expect(store.setArchived("t-1", false)).toEqual({ ok: true, threadIds: ["t-1"] });
    expect(store.listQueuedTurns("t-1").map((r) => r.queueId)).toEqual(["q-1"]);
  });
});
