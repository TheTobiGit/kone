import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";
import { migrate } from "./conversationMigrations.js";

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

let ConversationStoreCtor: typeof import("./ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("./ConversationStore.js")).ConversationStore;
});

function freshStore() {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-agent-grants-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  for (const threadId of ["chalk", "iris", "rowan"]) store.ensureThread({ threadId, projectPath: "/repo", provider: "codex" });
  return store;
}

const grant = (access: "read" | "message" | "followup", createdAt = 1) => ({
  granteeThreadId: "iris",
  targetThreadId: "rowan",
  access,
  grantedByThreadId: "chalk",
  createdAt,
});

describe("closing a contract ends the grants on it", () => {
  // Chalk hands Iris a contract; Rowan holds a grant on Iris beyond the chain.
  function contractStore() {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-agent-grants-test-"));
    setUserDataDir(dir);
    const store = new ConversationStoreCtor(dir);
    for (const threadId of ["chalk", "rowan"]) store.ensureThread({ threadId, projectPath: "/repo", provider: "codex" });
    store.writeSpawnedThread({
      threadId: "iris",
      projectPath: "/repo",
      provider: "codex",
      createdAt: 2,
      title: "Iris",
      lineage: { parentThreadId: "chalk", relationshipToParent: "delegation", rootThreadId: "chalk" },
      contract: { name: "C", role: "r", instructions: "i", scope: "s", deliverable: "d", doneCriteria: "c" },
    });
    return store;
  }
  const onIris = (access: "read" | "message" | "followup") => ({
    granteeThreadId: "rowan",
    targetThreadId: "iris",
    access,
    grantedByThreadId: "chalk",
    createdAt: 3,
  });

  test("the close and the end of the reach it granted land as one: every grant on the contractor is gone", () => {
    const store = contractStore();
    expect(store.setAgentGrant(onIris("followup"))).toBe(true);
    expect(store.setContractClosed("iris", { at: 5, reason: "delivered" })).toBe(true);
    expect(store.agentGrantsOn("iris")).toEqual([]);
    expect(store.agentGrant("rowan", "iris")).toBeNull();
  });

  test("a reopen brings none of the old grants back — they must be given again", () => {
    const store = contractStore();
    expect(store.setAgentGrant(onIris("followup"))).toBe(true);
    expect(store.setContractClosed("iris", { at: 5, reason: "withdrawn" })).toBe(true);
    expect(store.setContractClosed("iris", null)).toBe(true);
    expect(store.agentGrant("rowan", "iris")).toBeNull();
  });

  test("a close that matched nothing (no contract terms) takes no grants", () => {
    const store = contractStore();
    expect(
      store.setAgentGrant({ granteeThreadId: "iris", targetThreadId: "rowan", access: "read", grantedByThreadId: "chalk", createdAt: 3 }),
    ).toBe(true);
    expect(store.setContractClosed("rowan", { at: 5, reason: "delivered" })).toBe(false);
    expect(store.agentGrantsOn("rowan")).toHaveLength(1);
  });
});

describe("agent grants", () => {
  test("one grant per holder and agent: a new one replaces the old, and a revoke takes it back", () => {
    const store = freshStore();
    expect(store.agentGrant("iris", "rowan")).toBeNull();
    expect(store.setAgentGrant(grant("read"))).toBe(true);
    expect(store.setAgentGrant(grant("followup", 2))).toBe(true);
    expect(store.agentGrant("iris", "rowan")).toEqual(grant("followup", 2));
    expect(store.agentGrantsOn("rowan")).toEqual([grant("followup", 2)]);
    expect(store.agentGrantsHeldBy("iris")).toEqual([grant("followup", 2)]);

    expect(store.revokeAgentGrant("iris", "rowan")).toBe(true);
    expect(store.revokeAgentGrant("iris", "rowan")).toBe(false);
    expect(store.agentGrantsOn("rowan")).toEqual([]);
  });

  test("a grant naming a thread that does not exist is refused", () => {
    const store = freshStore();
    expect(store.setAgentGrant({ ...grant("read"), targetThreadId: "nobody" })).toBe(false);
  });
});

describe("migration 31: AgentGrants", () => {
  test("the table refuses an unknown access and goes with either thread", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-migration-grants-"));
    const file = path.join(dir, "kone.sqlite");
    const db = new Database(file);
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, file);
    db.exec(`
      INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at) VALUES ('a', '/p', 'codex', 1, 1);
      INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at) VALUES ('b', '/p', 'codex', 1, 1);
      INSERT INTO agent_grants VALUES ('a', 'b', 'message', 'c', 1);
    `);
    expect(() => db.exec(`INSERT INTO agent_grants VALUES ('b', 'a', 'admin', 'c', 1)`)).toThrow(/CHECK/);
    db.exec(`DELETE FROM threads WHERE thread_id = 'b'`);
    // SAFETY: an aggregate COUNT answers one row with one integer column.
    expect((db.prepare("SELECT COUNT(*) AS n FROM agent_grants").get() as { n: number }).n).toBe(0);
    db.close();
  });
});

describe("migration 32: CrewBoards", () => {
  test("a board goes with its owner, and everything on it with the board; states and access are checked", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-migration-boards-"));
    const file = path.join(dir, "kone.sqlite");
    const db = new Database(file);
    db.exec("PRAGMA foreign_keys = ON");
    migrate(db, file);
    db.exec(`
      INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at) VALUES ('o', '/p', 'codex', 1, 1);
      INSERT INTO threads (thread_id, project_path, provider, created_at, last_activity_at) VALUES ('m', '/p', 'codex', 1, 1);
      INSERT INTO crew_boards (board_id, owner_thread_id, project_path, title, created_at, updated_at) VALUES ('b', 'o', '/p', 'T', 1, 1);
      INSERT INTO crew_board_members (board_id, thread_id, access, granted_by_thread_id) VALUES ('b', 'm', 'rows', 'o');
      INSERT INTO crew_board_rules VALUES ('b', 'r1', 'Use the lock.', 1, 2, 0, 1);
      INSERT INTO crew_board_rows VALUES ('b', 'w1', 'p3', 'm', NULL, NULL, 'building', NULL, 1, 1, 'm');
    `);
    expect(() => db.exec(`INSERT INTO crew_board_rows VALUES ('b', 'w2', 'p4', 'm', NULL, NULL, 'done', NULL, 1, 1, 'm')`)).toThrow(/CHECK/);
    expect(() => db.exec(`INSERT INTO crew_board_members (board_id, thread_id, access, granted_by_thread_id) VALUES ('b', 'o', 'owner', 'o')`)).toThrow(
      /CHECK/,
    );
    db.exec(`DELETE FROM threads WHERE thread_id = 'o'`);
    for (const table of ["crew_boards", "crew_board_members", "crew_board_rules", "crew_board_rows"]) {
      // SAFETY: an aggregate COUNT answers one row with one integer column.
      expect((db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n).toBe(0);
    }
    db.close();
  });
});
