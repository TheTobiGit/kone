import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import { Database } from "bun:sqlite";

import type { RuntimeEvent, RuntimeItemKind, ThreadLineage } from "./types.js";

// The store imports node:sqlite, an Electron-runtime built-in this bun can't
// load — stand it in for bun:sqlite, whose API surface (exec / prepare().get /
// run / all) matches the store's usage. The agent layer's state dir is pointed
// at a throwaway temp dir per test. ConversationStore is imported *dynamically*
// below so the stub is in place first (static imports hoist above mock.module,
// defeating it — the same pattern gateway/gateway.test.ts uses).
let testUserDataDir = "";
/** Point the agent layer at a fresh temp state dir (see userDataDir.ts). */
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-spawn-store-")));

mock.module("./sqlite.js", () => ({
  DatabaseSync: Database,
}));

type ConversationStoreType = import("./ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

function freshStore(): ConversationStoreType {
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-spawn-store-")));
  return new ConversationStoreCtor();
}

function dbPath(): string {
  return path.join(testUserDataDir, "conversations.sqlite");
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

// ── event seeds ──────────────────────────────────────────────────────────────
// The cleanest way to put blocks/items on disk: apply the same normalized
// RuntimeEvents the real adapters emit, through store.applyEvent.

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

function item(threadId: string, turnId: string, itemId: string, kind: RuntimeItemKind, text: string): RuntimeEvent {
  return {
    type: "item.completed",
    threadId,
    provider: "opencode",
    at: 0,
    source: "kone.store",
    turnId,
    item: { itemId, kind, status: "completed", text },
  };
}

function spawnedLineage(parentThreadId: string, rootThreadId: string): ThreadLineage {
  return { parentThreadId, relationshipToParent: "subagent", rootThreadId };
}

// The v15 schema exactly as the pre-v16 migration ladder leaves it: the
// scratchpads `revision` column and the `gateway_ops` table included, so the
// v15→v16 step is the only thing the migrated store must add.
const V15_SCHEMA = `
  PRAGMA user_version = 15;
  CREATE TABLE threads (
    thread_id TEXT PRIMARY KEY, project_path TEXT NOT NULL, provider TEXT NOT NULL,
    model TEXT, conversation_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
    branch TEXT, added INTEGER, removed INTEGER, tokens INTEGER, archived INTEGER, title TEXT,
    base_tree TEXT, source_thread_id TEXT, fork_context_json TEXT, lineage_json TEXT, request_id TEXT
  );
  CREATE TABLE blocks (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, block_id TEXT NOT NULL UNIQUE, thread_id TEXT NOT NULL,
    role TEXT NOT NULL, turn_id TEXT, text TEXT, state TEXT, error TEXT, at INTEGER NOT NULL,
    ended_at INTEGER, attachments_json TEXT, source TEXT NOT NULL DEFAULT 'native'
  );
  CREATE TABLE items (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, item_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, kind TEXT NOT NULL, status TEXT NOT NULL, text TEXT NOT NULL,
    name TEXT, detail TEXT, tasks_json TEXT, subagent_tool_use_id TEXT,
    UNIQUE (thread_id, turn_id, item_id)
  );
  CREATE TABLE subagents (
    seq INTEGER PRIMARY KEY AUTOINCREMENT, tool_use_id TEXT NOT NULL, thread_id TEXT NOT NULL,
    turn_id TEXT NOT NULL, task_id TEXT, parent_item_id TEXT, agent_type TEXT,
    description TEXT, prompt TEXT, model TEXT, effort TEXT, background INTEGER,
    status TEXT NOT NULL, summary TEXT, last_tool_name TEXT, tokens INTEGER,
    tool_uses INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER,
    UNIQUE (thread_id, turn_id, tool_use_id)
  );
  CREATE TABLE attachments (
    attachment_id TEXT PRIMARY KEY, thread_id TEXT NOT NULL, type TEXT NOT NULL,
    name TEXT NOT NULL, mime_type TEXT NOT NULL, size_bytes INTEGER NOT NULL,
    rel_path TEXT NOT NULL, created_at INTEGER NOT NULL
  );
  CREATE TABLE project_boards (
    project_path TEXT PRIMARY KEY, layout TEXT NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE scratchpads (
    id TEXT PRIMARY KEY, project_path TEXT NOT NULL, title TEXT, body TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, sort_index INTEGER NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE gateway_ops (
    thread_id TEXT NOT NULL, turn_id TEXT NOT NULL, request_id TEXT NOT NULL,
    kind TEXT NOT NULL, fingerprint TEXT NOT NULL, result_json TEXT NOT NULL,
    created_at INTEGER NOT NULL, PRIMARY KEY (thread_id, turn_id, request_id)
  );
  CREATE INDEX idx_gateway_ops_kind ON gateway_ops (kind, created_at);
`;

describe("spawn store surface (thread spawning, v16)", () => {
  test("a v15 legacy DB migrates to v17 and gains parent_thread_id + the gateway_ops dispatched bit", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-spawn-migrate-"));
    const legacy = new Database(path.join(dir, "conversations.sqlite"));
    legacy.exec(V15_SCHEMA);
    legacy.close();

    // Old userData path → new store migrates it on open.
    useUserDataDir(dir);
    const store = new ConversationStoreCtor();

    const ok = store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/tmp/proj",
      provider: "opencode",
      createdAt: 10,
      title: "Migrated child",
      lineage: spawnedLineage("parent-1", "root-1"),
    });
    expect(ok).toBe(true);
    expect(store.threadLineage("child-1")).toEqual(spawnedLineage("parent-1", "root-1"));
    expect(store.spawnedChildren("parent-1").map((t) => t.threadId)).toEqual(["child-1"]);

    // The migration ran to completion: user_version bumped to the current
    // schema, the parent index exists, and the gateway_ops dispatched bit (the
    // spawn crash-recovery ledger) is in place.
    const raw = new Database(dbPath());
    const version = raw.prepare("PRAGMA user_version").get() as { user_version: number };
    expect(version.user_version).toBe(27);
    const idx = raw
      .prepare(
        `SELECT 1 FROM sqlite_master
          WHERE type = 'index' AND name = 'idx_threads_parent'`,
      )
      .get();
    expect(idx).toBeDefined();
    const dispatched = raw
      .prepare(
        `SELECT 1 FROM pragma_table_info('gateway_ops')
          WHERE name = 'dispatched'`,
      )
      .get();
    expect(dispatched).toBeDefined();
    raw.close();
  });

  test("writeSpawnedThread persists lineage + parent pointer and refuses duplicate ids", () => {
    const store = freshStore();
    const input = {
      threadId: "child-1",
      projectPath: "/tmp/proj",
      provider: "opencode",
      model: "deepseek-v4",
      createdAt: 10,
      title: "Fix the sidebar",
      lineage: spawnedLineage("parent-1", "root-1"),
    };
    expect(store.writeSpawnedThread(input)).toBe(true);

    expect(store.threadLineage("child-1")).toEqual(input.lineage);
    expect(store.threadLineage("parent-1")).toBeNull();

    const children = store.spawnedChildren("parent-1");
    expect(children.map((t) => t.threadId)).toEqual(["child-1"]);
    expect(children[0]).toMatchObject({
      provider: "opencode",
      model: "deepseek-v4",
      title: "Fix the sidebar",
    });

    expect(store.spawnedChildren("nobody")).toEqual([]);

    // Same id again → UNIQUE violation lands in the catch, false.
    expect(store.writeSpawnedThread({ ...input })).toBe(false);
  });

  test("boot recovery seals an undispatched spawned child as failed (F8)", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-spawn-seal-"));
    useUserDataDir(dir);
    const store = new ConversationStoreCtor();

    // The exact half-created shape: the child row exists, its spawn op is
    // reserved with the result naming the child, but startThread never ran —
    // no dispatched mark, no turn. A crash between the store write and
    // dispatch leaves exactly this.
    const childId = "stillborn-1";
    expect(
      store.writeSpawnedThread({
        threadId: childId,
        projectPath: "/tmp/proj",
        provider: "opencode",
        createdAt: 10,
        title: "Never started",
        lineage: spawnedLineage("parent-1", "root-1"),
      }),
    ).toBe(true);
    const reserve = store.reserveGatewayOp({
      threadId: "parent-1",
      turnId: "turn-1",
      requestId: "req-1",
      kind: "spawn.thread",
      fingerprint: "fp",
    });
    expect(reserve?.kind).toBe("reserved");
    store.setGatewayOpResult({
      threadId: "parent-1",
      turnId: "turn-1",
      requestId: "req-1",
      resultJson: JSON.stringify({ threadId: childId }),
    });
    expect(store.threadTurnSpan(childId)).toBeNull();

    // Boot: reopening the same DB runs sealUndispatchedSpawns — the child now
    // reads failed with the reason, so a parent wait settles on it.
    useUserDataDir(dir);
    const reopened = new ConversationStoreCtor();
    const span = reopened.threadTurnSpan(childId);
    expect(span?.lastState).toBe("failed");
    expect(span?.lastError).toContain("never started");

    // Idempotent: the seal marks the op dispatched, so a second boot does not
    // double-write (the block persists, still failed).
    useUserDataDir(dir);
    const reopenedAgain = new ConversationStoreCtor();
    expect(reopenedAgain.threadTurnSpan(childId)?.lastState).toBe("failed");
  });

  test("writeSpawnedThread leaves request_id NULL — spawn idempotency rides gateway_ops", () => {
    const store = freshStore();
    store.writeSpawnedThread({
      threadId: "child-1",
      projectPath: "/tmp/proj",
      provider: "opencode",
      createdAt: 10,
      title: "Child",
      lineage: spawnedLineage("parent-1", "root-1"),
    });

    // A side chat that DOES write the same requestId must still resolve to
    // itself: threadIdForRequestId is a global key, and the spawn's requestId
    // (scoped to its parent turn) must not shadow it.
    expect(
      store.writeForkThread({
        threadId: "sidechat-1",
        projectPath: "/tmp/proj",
        provider: "opencode",
        createdAt: 20,
        sourceThreadId: "root-1",
        forkContext: {
          sourceThreadId: "root-1",
          forkPointBlockId: null,
          importedAt: 20,
          bootstrapStatus: "pending",
        },
        lineage: { parentThreadId: null, relationshipToParent: "side_chat", rootThreadId: "root-1" },
        requestId: "spawn-req-1",
        importedBlocks: [],
      }),
    ).toBe(true);

    // The global key resolves to the side chat — not to the spawned thread.
    expect(store.threadIdForRequestId("spawn-req-1")).toBe("sidechat-1");
    const raw = new Database(dbPath());
    const row = raw
      .prepare(`SELECT request_id FROM threads WHERE thread_id = 'child-1'`)
      .get() as { request_id: string | null };
    expect(row.request_id).toBeNull();
    raw.close();
  });

  test("spawnDepth walks the chain, stops at a missing parent, and survives a cycle", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "root-1", projectPath: "/tmp/proj", provider: "opencode" });
    const spawn = (id: string, parent: string, at: number) =>
      store.writeSpawnedThread({
        threadId: id,
        projectPath: "/tmp/proj",
        provider: "opencode",
        createdAt: at,
        title: id,
        lineage: spawnedLineage(parent, "root-1"),
      });
    spawn("child-1", "root-1", 10);
    spawn("grandchild-1", "child-1", 20);

    expect(store.spawnDepth("root-1")).toBe(0);
    expect(store.spawnDepth("child-1")).toBe(1);
    expect(store.spawnDepth("grandchild-1")).toBe(2);

    // A missing parent terminates the walk (children survive deletion).
    spawn("orphan-1", "ghost-parent", 30);
    expect(store.spawnDepth("orphan-1")).toBe(1);

    // A hand-crafted cycle must not hang: x → y → z → x.
    const raw = new Database(dbPath());
    const insert = raw.prepare(
      `INSERT INTO threads (thread_id, project_path, provider, created_at, updated_at, title, lineage_json, parent_thread_id)
       VALUES (?, '/tmp/proj', 'opencode', 1, 1, ?, '{}', ?)`,
    );
    insert.run("cycle-x", "x", "cycle-y");
    insert.run("cycle-y", "y", "cycle-z");
    insert.run("cycle-z", "z", "cycle-x");
    raw.close();

    expect(store.spawnDepth("cycle-x")).toBe(64);
  });

  test("liveSpawnedThreadIds includes running children, excludes settled and non-spawned", () => {
    const store = freshStore();
    // A plain root with a running turn — excluded by the parent filter.
    store.ensureThread({ threadId: "root-1", projectPath: "/tmp/proj", provider: "opencode" });
    store.applyEvent(turnStarted("root-1", "turn-0", 1));

    for (const id of ["running-1", "running-2", "done-1", "not-started-1"]) {
      store.writeSpawnedThread({
        threadId: id,
        projectPath: "/tmp/proj",
        provider: "opencode",
        createdAt: 10,
        title: id,
        lineage: spawnedLineage("root-1", "root-1"),
      });
    }
    store.applyEvent(turnStarted("running-1", "t1", 20));
    store.applyEvent(turnStarted("running-2", "t2", 30));
    store.applyEvent(turnStarted("done-1", "t3", 40));
    store.applyEvent(turnCompleted("done-1", "t3", 50));

    expect(store.liveSpawnedThreadIds().sort()).toEqual(["running-1", "running-2"]);
  });

  test("latestAssistantText returns the narrative only, in arrival order", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "child-1", projectPath: "/tmp/proj", provider: "opencode" });
    store.applyEvent(turnStarted("child-1", "turn-1", 10));
    // Reasoning, narrative, more narrative, a tool call — only the
    // assistant_text items may ride back as the child's summary.
    store.applyEvent(item("child-1", "turn-1", "i1", "reasoning_text", "hidden chain-of-thought"));
    store.applyEvent(item("child-1", "turn-1", "i2", "assistant_text", "First paragraph "));
    store.applyEvent(item("child-1", "turn-1", "i3", "assistant_text", "second paragraph."));
    store.applyEvent(item("child-1", "turn-1", "i4", "tool_call", "cat /etc/hosts"));

    expect(store.latestAssistantText("child-1")).toBe("First paragraph second paragraph.");
    expect(store.latestAssistantText("never-spoke-1")).toBeNull();
  });

  test("threadTurnSpan reports endedAt null while a turn runs, with the newest block's state", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "child-1", projectPath: "/tmp/proj", provider: "opencode" });
    expect(store.threadTurnSpan("child-1")).toBeNull();

    store.applyEvent(turnStarted("child-1", "turn-1", 100));
    expect(store.threadTurnSpan("child-1")).toEqual({
      startedAt: 100,
      endedAt: null,
      runningTurns: 1,
      lastState: "running",
    });

    store.applyEvent(turnCompleted("child-1", "turn-1", 150));
    expect(store.threadTurnSpan("child-1")).toEqual({
      startedAt: 100,
      endedAt: 150,
      runningTurns: 0,
      lastState: "completed",
    });
  });
});
