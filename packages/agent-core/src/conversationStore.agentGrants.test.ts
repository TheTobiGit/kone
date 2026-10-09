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
