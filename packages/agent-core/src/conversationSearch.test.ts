import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import { Database } from "bun:sqlite";

import type { RuntimeEvent } from "./types.js";

// Same stub discipline as conversationStore.test.ts: ConversationStore imports
// node:sqlite (an Electron-runtime built-in bun can't load), so stand it in
// for bun:sqlite and point the state dir at a throwaway temp dir per store.
let testUserDataDir = "";
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-search-test-")));

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
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-search-test-")));
  return new ConversationStoreCtor();
}

function dbPath(): string {
  return path.join(testUserDataDir, "kone.sqlite");
}

function rawDb(): Database {
  return new Database(dbPath());
}

function ftsRowCount(db: Database, threadId: string): number {
  // SAFETY: COUNT(*) always arrives under the alias asked for.
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM conversation_fts WHERE thread_id = ?`)
    .get(threadId) as { n: number };
  return row.n;
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

// ── seeds ────────────────────────────────────────────────────────────────────

function ensureSeededThread(store: ConversationStoreType, threadId: string): void {
  store.ensureThread({ threadId, projectPath: "/p", provider: "opencode" });
}

function userPrompt(store: ConversationStoreType, threadId: string, text: string): void {
  store.recordUserBlock({ threadId, text });
}

function turnStarted(store: ConversationStoreType, threadId: string, turnId: string): void {
  const event: RuntimeEvent = {
    type: "turn.started",
    threadId,
    provider: "opencode",
    at: Date.now(),
    source: "kone.store",
    turnId,
  };
  store.applyEvent(event);
}

function streamItem(
  store: ConversationStoreType,
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
): void {
  const event: RuntimeEvent = {
    type: "item.updated",
    threadId,
    turnId,
    provider: "opencode",
    at: Date.now(),
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "in-progress", text },
  };
  store.applyEvent(event);
}

function completeItem(
  store: ConversationStoreType,
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
): void {
  const event: RuntimeEvent = {
    type: "item.completed",
    threadId,
    turnId,
    provider: "opencode",
    at: Date.now(),
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
  store.applyEvent(event);
}

function turnCompleted(store: ConversationStoreType, threadId: string, turnId: string): void {
  const event: RuntimeEvent = {
    type: "turn.completed",
    threadId,
    provider: "opencode",
    at: Date.now(),
    source: "kone.store",
    turnId,
  };
  store.applyEvent(event);
}

/** One settled assistant turn carrying a single text item — the common case. */
function settledTurn(
  store: ConversationStoreType,
  threadId: string,
  turnId: string,
  text: string,
): void {
  turnStarted(store, threadId, turnId);
  completeItem(store, threadId, turnId, `${turnId}-item`, text);
  turnCompleted(store, threadId, turnId);
}

describe("conversation full-text search", () => {
  test("user prompts and assistant items are searchable with snippets and jump ids", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-search-basic");
    userPrompt(store, "t-search-basic", "how do I migrate the nebula database");
    settledTurn(store, "t-search-basic", "turn-1", "run the nebula migration with backups enabled");

    const hits = store.searchConversations("nebula");
    expect(hits.length).toBe(2);

    const kinds = new Set(hits.map((h) => h.entryKind));
    expect(kinds.has("block")).toBe(true);
    expect(kinds.has("item")).toBe(true);

    for (const hit of hits) {
      expect(hit.threadId).toBe("t-search-basic");
      expect(hit.snippet.includes("<mark>")).toBe(true);
      expect(hit.snippet.includes("</mark>")).toBe(true);
    }

    const blockHit = hits.find((h) => h.entryKind === "block");
    expect(blockHit?.blockId).toBeTruthy();
    expect(blockHit?.itemId).toBeNull();

    const itemHit = hits.find((h) => h.entryKind === "item");
    expect(itemHit?.turnId).toBe("turn-1");
    expect(itemHit?.itemId).toBe("turn-1-item");
    // The item hit jumps to the assistant block carrying its turn.
    expect(itemHit?.blockId).toBe("t-search-basic::turn-1");
  });

  test("bm25 ranks the denser match first", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-rank-sparse");
    ensureSeededThread(store, "t-rank-dense");
    settledTurn(store, "t-rank-sparse", "turn-1", "a passing mention of quokka");
    settledTurn(
      store,
      "t-rank-dense",
      "turn-1",
      "quokka quokka quokka quokka quokka quokka quokka",
    );

    const hits = store.searchConversations("quokka");
    expect(hits.length).toBe(2);
    expect(hits[0]?.threadId).toBe("t-rank-dense");
    expect(hits[1]?.threadId).toBe("t-rank-sparse");
    expect(hits[0]?.rank).toBeLessThan(hits[1]?.rank ?? 0);
  });

  test("global search spans threads; threadId scopes to one", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-scope-a");
    ensureSeededThread(store, "t-scope-b");
    userPrompt(store, "t-scope-a", "the lighthouse keeper manual");
    userPrompt(store, "t-scope-b", "the lighthouse wiring diagram");

    const global = store.searchConversations("lighthouse");
    expect(new Set(global.map((h) => h.threadId))).toEqual(new Set(["t-scope-a", "t-scope-b"]));

    const scoped = store.searchConversations("lighthouse", { threadId: "t-scope-a" });
    expect(scoped.length).toBeGreaterThan(0);
    for (const hit of scoped) {
      expect(hit.threadId).toBe("t-scope-a");
    }
  });

  test("phrase queries match adjacency, not scattered words", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-phrase-near");
    ensureSeededThread(store, "t-phrase-far");
    settledTurn(store, "t-phrase-near", "turn-1", "we colonized the red planet together");
    settledTurn(
      store,
      "t-phrase-far",
      "turn-1",
      "the planet was red in the painting and red in the sky",
    );

    const hits = store.searchConversations(`"red planet"`);
    expect(hits.map((h) => h.threadId)).toEqual(["t-phrase-near"]);
  });

  test("tool call names and payloads are indexed", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-tool");
    turnStarted(store, "t-tool", "turn-1");
    const event: RuntimeEvent = {
      type: "item.completed",
      threadId: "t-tool",
      turnId: "turn-1",
      provider: "opencode",
      at: Date.now(),
      source: "kone.store",
      item: {
        itemId: "tool-1",
        kind: "tool_call",
        status: "completed",
        text: "",
        name: "Bash",
        detail: "zephyr deploy log line one",
      },
    };
    store.applyEvent(event);
    turnCompleted(store, "t-tool", "turn-1");

    const byName = store.searchConversations("Bash", { threadId: "t-tool" });
    expect(byName.length).toBeGreaterThan(0);
    expect(byName[0]?.entryKind).toBe("item");

    const byPayload = store.searchConversations("zephyr", { threadId: "t-tool" });
    expect(byPayload.length).toBeGreaterThan(0);
  });

  test("hostile FTS5-looking input never throws and matches literally", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-hostile");
    settledTurn(store, "t-hostile", "turn-1", "plain harvest text about orchards");

    const hostile = [
      `"`,
      `"unbalanced`,
      `*`,
      `OR`,
      `AND`,
      `NOT`,
      `NEAR(orchard, harvest)`,
      `(orchard OR harvest`,
      `thread_id : orchard`,
      `-orchard`,
      `^orchard`,
      `orchard*`,
      `; DROP TABLE threads;--`,
      `"orchard" AND "harvest" OR "bomb"`,
      `column : *`,
    ];
    for (const query of hostile) {
      const hits = store.searchConversations(query, { threadId: "t-hostile" });
      expect(Array.isArray(hits)).toBe(true);
    }

    // A bare operator matches the literal word or nothing — never everything.
    expect(store.searchConversations("OR", { threadId: "t-hostile" }).length).toBe(0);
    // Empty input answers empty.
    expect(store.searchConversations("")).toEqual([]);
    expect(store.searchConversations("   ")).toEqual([]);
  });

  test("streaming deltas do not touch the index; completion does", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-stream");
    turnStarted(store, "t-stream", "turn-1");

    let text = "";
    for (let i = 0; i < 50; i++) {
      text += ` wombat chunk ${i}`;
      streamItem(store, "t-stream", "turn-1", "item-1", text);
    }

    // Fifty deltas landed in items — none in the index.
    const raw = rawDb();
    try {
      expect(ftsRowCount(raw, "t-stream")).toBe(0);
    } finally {
      raw.close();
    }
    expect(store.searchConversations("wombat", { threadId: "t-stream" })).toEqual([]);

    completeItem(store, "t-stream", "turn-1", "item-1", text);
    expect(store.searchConversations("wombat", { threadId: "t-stream" }).length).toBe(1);
  });

  test("turn completion backfills items that never completed", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-backfill-turn");
    turnStarted(store, "t-backfill-turn", "turn-1");
    // Only deltas, no item.completed — then the turn settles.
    streamItem(store, "t-backfill-turn", "turn-1", "item-1", "half-finished kumquat draft");
    turnCompleted(store, "t-backfill-turn", "turn-1");

    const hits = store.searchConversations("kumquat", { threadId: "t-backfill-turn" });
    expect(hits.length).toBe(1);
    expect(hits[0]?.itemId).toBe("item-1");
  });

  test("aborted turns are indexed too", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-aborted");
    turnStarted(store, "t-aborted", "turn-1");
    streamItem(store, "t-aborted", "turn-1", "item-1", "interrupted papaya thought");
    const event: RuntimeEvent = {
      type: "turn.aborted",
      threadId: "t-aborted",
      provider: "opencode",
      at: Date.now(),
      source: "kone.store",
      turnId: "turn-1",
      reason: "interrupted",
    };
    store.applyEvent(event);

    expect(store.searchConversations("papaya", { threadId: "t-aborted" }).length).toBe(1);
  });

  test("deleting a thread removes its index rows", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-doomed");
    userPrompt(store, "t-doomed", "doomed durian prompt");
    settledTurn(store, "t-doomed", "turn-1", "doomed durian answer");
    expect(store.searchConversations("durian").length).toBe(2);

    const deleted = store.deleteThread("t-doomed");
    expect(deleted.ok).toBe(true);
    expect(store.searchConversations("durian")).toEqual([]);
  });

  test("limit bounds the hits", () => {
    const store = freshStore();
    ensureSeededThread(store, "t-limit");
    for (let i = 0; i < 5; i++) {
      settledTurn(store, "t-limit", `turn-${i}`, `elderberry note number ${i}`);
    }
    expect(store.searchConversations("elderberry", { threadId: "t-limit" }).length).toBe(5);
    expect(
      store.searchConversations("elderberry", { threadId: "t-limit", limit: 2 }).length,
    ).toBe(2);
  });

  test("migration backfills rows written before the index existed", async () => {
    const dir = useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-search-mig-")));
    const file = path.join(dir, "kone.sqlite");
    // Build a v5 database with conversation rows, as an older build left it.
    // The sqlite module resolves to the bun:sqlite stand-in (mocked above),
    // so the handle carries the real DatabaseSync type with no assertion.
    const sqliteModule = await import("./sqlite.js");
    const migrationsModule = await import("./conversationMigrations.js");
    const legacy = new sqliteModule.DatabaseSync(file);
    migrationsModule.migrate(legacy, file, { toMigrationInclusive: 5 });
    legacy.exec(
      `INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at)
       VALUES ('t-legacy', '/p', 'opencode', 1, 1)`,
    );
    legacy.exec(
      `INSERT INTO blocks (block_id, thread_id, role, text, at)
       VALUES ('b-legacy', 't-legacy', 'user', 'legacy fig harvest', 2)`,
    );
    legacy.exec(
      `INSERT INTO items (item_id, thread_id, turn_id, kind, status, text)
       VALUES ('i-legacy', 't-legacy', 'turn-legacy', 'assistant_text', 'completed',
               'legacy fig reply')`,
    );
    legacy.close();

    // Opening the store migrates to latest — the v6 backfill must pick up
    // both rows without any reindex command.
    const store = new ConversationStoreCtor();
    const hits = store.searchConversations("fig");
    expect(hits.length).toBe(2);
    expect(new Set(hits.map((h) => h.entryKind))).toEqual(new Set(["block", "item"]));
  });
});

describe("toFtsQuery", () => {
  test("quotes terms, keeps phrases, empties to null", async () => {
    const searchModule = await import("./store/search.js");
    expect(searchModule.toFtsQuery("")).toBeNull();
    expect(searchModule.toFtsQuery("   ")).toBeNull();
    expect(searchModule.toFtsQuery("OR")).toBe(`"OR"`);
    expect(searchModule.toFtsQuery("red planet")).toBe(`"red" AND "planet"`);
    expect(searchModule.toFtsQuery(`"red planet" rover`)).toBe(
      `"red planet" AND "rover"`,
    );
    // Embedded quotes are doubled, never left to break the MATCH expression.
    expect(searchModule.toFtsQuery(`say "hi" twice`)).toContain(`"hi"`);
  });
});
