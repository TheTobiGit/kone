import { beforeAll, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "./userDataDir.js";

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

test("a block moved to the end reads after everything written before the move", () => {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-block-order-test-"));
  setUserDataDir(dir);
  const store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "t", projectPath: "/repo", provider: "codex" });

  store.recordUserBlock({ blockId: "own", threadId: "t", text: "ship it" });
  store.recordUserBlock({ blockId: "carried", threadId: "t", text: "a note that waited" });
  store.moveBlockToEnd("t", "own");

  const ids = store.loadThread("t")?.blocks.map((b) => b.id);
  expect(ids).toEqual(["carried", "own"]);
});
