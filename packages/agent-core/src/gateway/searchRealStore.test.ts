import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "../userDataDir.js";
import type { AppThreadsStore } from "./tools/appThreads.js";
import { createAppThreadTools } from "./tools/appThreads.js";
import { createRegistry, type GatewayToolContext } from "./registry.js";
import { IrcMailbox } from "./tools/irc.js";

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

mock.module("../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type ConversationStoreType = import("../ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("../ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("../ConversationStore.js")).ConversationStore;
});

function makeToolStore(real: ConversationStoreType): AppThreadsStore {
  return {
    listThreads: () => [],
    loadThread: () => null,
    listProjectAgents: () => [],
    getThreadAgent: () => ({ agentId: null }),
    getAgent: () => null,
    bindThreadAgent: () => null,
    reserveGatewayOp: () => ({ kind: "reserved" }),
    setGatewayOpResult: () => {},
    threadMeta: (threadId) => real.threadMeta(threadId),
    searchConversations: (query, options) => real.searchConversations(query, options),
  };
}

function searchTools(store: AppThreadsStore) {
  return createRegistry(
    createAppThreadTools({ store, jobs: new IrcMailbox(), readProjects: () => [] }),
  );
}

function context(threadId: string): GatewayToolContext {
  return {
    threadId,
    turnId: "turn-1",
    provider: "claudeAgent",
    model: "sonnet",
    cwd: process.cwd(),
    requestId: "search-real-store",
  };
}

interface StoreHarness {
  store: ConversationStoreType;
  cleanup: () => void;
}

function newStore(): StoreHarness {
  const directory = mkdtempSync(path.join(tmpdir(), "kone-search-gateway-test-"));
  setUserDataDir(directory);
  const store = new ConversationStoreCtor();
  return {
    store,
    cleanup: () => {
      store.close();
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("app_search_threads with the real conversation store", () => {
  test("finds an eligible hit beyond the store's first 100 ranked results", async () => {
    const { store, cleanup } = newStore();
    try {
      for (let index = 0; index < 101; index += 1) {
        const threadId = `unreadable-${index}`;
        store.ensureThread({ threadId, projectPath: "/other", provider: "codex" });
        store.recordUserBlock({ threadId, blockId: `block-${index}`, text: "threadneedlesearch" });
      }
      store.ensureThread({ threadId: "allowed-thread", projectPath: "/caller", provider: "codex" });
      store.recordUserBlock({
        threadId: "allowed-thread",
        blockId: "allowed-block",
        text: `eligible threadneedlesearch ${"filler ".repeat(1_000)}`,
      });

      const firstPage = store.searchConversations("threadneedlesearch", { limit: 100 });
      expect(firstPage).toHaveLength(100);
      expect(firstPage.some((hit) => hit.threadId === "allowed-thread")).toBe(false);

      const result = await searchTools(makeToolStore(store)).call(
        context("allowed-thread"),
        "app_search_threads",
        { query: "threadneedlesearch", limit: 1 },
      );
      expect(result.isError).toBeUndefined();
      expect(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"))
        .toContain("allowed-thread");
    } finally {
      cleanup();
    }
  });

  test("lets a parent search its cross-project spawned child", async () => {
    const { store, cleanup } = newStore();
    try {
      store.ensureThread({ threadId: "parent", projectPath: "/parent", provider: "codex" });
      expect(
        store.writeSpawnedThread({
          threadId: "child",
          projectPath: "/child",
          provider: "codex",
          createdAt: 2,
          title: "Child work",
          lineage: { parentThreadId: "parent", relationshipToParent: "subagent" },
        }),
      ).toBe(true);
      store.recordUserBlock({
        threadId: "child",
        blockId: "child-block",
        text: "spawnchildsearch",
      });

      const result = await searchTools(makeToolStore(store)).call(
        context("parent"),
        "app_search_threads",
        { query: "spawnchildsearch" },
      );
      expect(result.isError).toBeUndefined();
      expect(result.content.map((part) => part.type === "text" ? part.text : "").join("\n"))
        .toContain("child");
    } finally {
      cleanup();
    }
  });
});
