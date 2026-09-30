import { afterEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// The agent layer imports `node:sqlite` (an Electron-runtime built-in this bun
// can't load) — the established repo pattern stands in bun's Database, with a
// thin shim translating node's `{ readOnly }` constructor option to bun's
// `{ readonly }`.
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
mock.module("../../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

// Loaded after the mock is registered — a static import would hoist above it.
const { scanOpenCodeUsage } = await import("./opencodeScan.js");
const { isWithinProject } = await import("../projectScope.js");

const T0 = Date.parse("2026-09-28T10:00:00.000Z");
let dataDir: string | null = null;

afterEach(() => {
  delete process.env.OPENCODE_DATA_DIR;
  if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  dataDir = null;
});

function withDatabase(build: (db: Database) => void): void {
  dataDir = mkdtempSync(path.join(tmpdir(), "kone-opencode-scan-"));
  process.env.OPENCODE_DATA_DIR = dataDir;
  const db = new Database(path.join(dataDir, "opencode.db"));
  build(db);
  db.close();
}

/** Token payload shape for the v2 log fixtures below. */
interface OpenCodeTestTokens {
  readonly input?: number;
  readonly output?: number;
  readonly reasoning?: number;
  readonly cache?: { readonly read?: number; readonly write?: number };
}

function v2Message(tokens: OpenCodeTestTokens, model = { id: "muse-spark-1.3", providerID: "opencode" }): string {
  return JSON.stringify({ time: { created: T0 }, model, tokens, cost: 0 });
}

describe("scanOpenCodeUsage", () => {
  test("reads the v2 log (session_message) with each session's directory", async () => {
    withDatabase((db) => {
      db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, directory TEXT)`);
      db.exec(
        `CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, time_created INTEGER, data TEXT)`,
      );
      db.prepare("INSERT INTO session_v2 VALUES (?, ?)").run("ses_a", "/work/app");
      const insert = db.prepare("INSERT INTO session_message VALUES (?, ?, ?, ?, ?)");
      insert.run("msg_1", "ses_a", "assistant", T0, v2Message({ input: 100, output: 10, reasoning: 5, cache: { read: 50, write: 0 } }));
      // Not an assistant turn, and outside the window: neither counts.
      insert.run("msg_2", "ses_a", "user", T0, JSON.stringify({ time: { created: T0 } }));
      insert.run("msg_3", "ses_a", "assistant", T0 - 86_400_000, v2Message({ input: 999, output: 1 }));
    });

    const { records, sources } = await scanOpenCodeUsage({ sinceMs: T0 - 1000, untilMs: T0 + 1000 });

    expect(sources[0]?.messagesFromDb).toBe(1);
    expect(records).toHaveLength(1);
    const [record] = records;
    expect(record?.sessionId).toBe("ses_a");
    expect(record?.cwd).toBe("/work/app");
    expect(record?.model).toContain("muse-spark-1.3");
    expect(record?.totals.uncachedInputTokens).toBe(100);
    expect(record?.totals.cachedInputTokens).toBe(50);
    expect(record?.totals.outputTokens).toBe(15);
  });

  test("still reads the legacy message table, joining the session's directory", async () => {
    withDatabase((db) => {
      db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, directory TEXT)`);
      db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, data TEXT)`);
      db.prepare("INSERT INTO session VALUES (?, ?)").run("ses_old", "/work/legacy");
      db.prepare("INSERT INTO message VALUES (?, ?, ?, ?)").run(
        "msg_old",
        "ses_old",
        T0,
        JSON.stringify({
          role: "assistant",
          modelID: "claude-sonnet-4.5",
          providerID: "anthropic",
          time: { created: T0 },
          tokens: { input: 20, output: 2 },
        }),
      );
    });

    const { records } = await scanOpenCodeUsage({ sinceMs: T0 - 1000, untilMs: T0 + 1000 });

    expect(records).toHaveLength(1);
    expect(records[0]?.cwd).toBe("/work/legacy");
    expect(records[0]?.sessionId).toBe("ses_old");
  });
});

describe("isWithinProject", () => {
  test("claims the folder and anything under it, never a sibling that shares a prefix", () => {
    expect(isWithinProject("/work/app", "/work/app")).toBe(true);
    expect(isWithinProject("/work/app/packages/core", "/work/app")).toBe(true);
    expect(isWithinProject("/work/app/", "/work/app")).toBe(true);
    expect(isWithinProject("/work/app-old", "/work/app")).toBe(false);
    expect(isWithinProject("/work", "/work/app")).toBe(false);
  });
});
