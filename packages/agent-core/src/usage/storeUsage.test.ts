import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Database } from "bun:sqlite";

import { setUserDataDir } from "../userDataDir.js";

// ConversationStore imports node:sqlite (an Electron built-in this bun cannot
// load) — stand it in for bun:sqlite, which has the same prepare/exec surface,
// and point the state dir at a throwaway temp dir. The store is imported
// dynamically so the stub is in place first.
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
mock.module("../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type ConversationStoreType = import("../ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("../ConversationStore.js").ConversationStore;

const stateDir = mkdtempSync(path.join(tmpdir(), "kone-store-usage-test-"));
setUserDataDir(stateDir);

beforeAll(async () => {
  ({ ConversationStore: ConversationStoreCtor } = await import("../ConversationStore.js"));
});

/** A thread with one recorded turn's usage on it. The row is written through a
 *  second connection to the same file rather than through the store: recording
 *  usage properly means folding a whole provider turn, and all this needs is
 *  the row. `turn_usage` carries its own `model` and `provider` columns
 *  alongside the thread's, which is the whole point of the test below. */
function seed(store: ConversationStoreType, threadId: string): void {
  store.ensureThread({
    threadId,
    projectPath: "/tmp/proj",
    provider: "claudeAgent",
    model: "sonnet",
  });
  const db = new Database(path.join(stateDir, "kone.sqlite"));
  try {
    db.prepare(
      `INSERT INTO turn_usage
         (thread_id, turn_id, input_tokens, output_tokens, total_tokens,
          cache_read_tokens, cache_creation_tokens, reasoning_tokens,
          provider, model, at)
       VALUES (?, ?, 100, 50, 150, 0, 0, 0, 'claudeAgent', 'sonnet', ?)`,
    ).run(threadId, `${threadId}-turn-1`, Date.now());
  } finally {
    db.close();
  }
}

describe("usageReportFromStore", () => {
  // The per-day rollup joins turn_usage to threads, and both tables have a
  // `model` and a `provider`. Grouping by the bare names is ambiguous, and
  // SQLite refuses the statement rather than picking one — which took the whole
  // report down (every field empty) instead of one column.
  test("rolls usage up by day without tripping over the join's shared column names", () => {
    const store = new ConversationStoreCtor();
    seed(store, "thread-usage-1");

    const report = store.readStoreUsageReport({ range: "all" });

    expect(report.usageByDayRows).toHaveLength(1);
    expect(report.usageByDayRows[0]).toMatchObject({
      model: "sonnet",
      provider: "claudeAgent",
      input_tokens: 100,
      output_tokens: 50,
      total_tokens: 150,
    });
    expect(report.usageRows).toHaveLength(1);
    expect(report.usageRows[0]).toMatchObject({
      model: "sonnet",
      provider: "claudeAgent",
      project_path: "/tmp/proj",
      turns: 1,
    });
  });
});
