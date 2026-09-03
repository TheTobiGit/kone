import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";

import type { RuntimeEvent } from "./types.js";

// Counts every write against the `threads` table driven by `touch()` — the
// recency/activity stamp `applyEvent` issues per event. The streaming path's
// per-delta `item.updated` events must NOT each rewrite the thread row; that
// stamp only needs turn-level granularity (turn.started / turn.completed).
let touchRuns = 0;

/** bun:sqlite shim for `node:sqlite` (bun can't load the Electron built-in),
 *  with a counter on the exact `touch()` UPDATE so the test can assert how many
 *  times a turn rewrites its own thread row. */
class InstrumentedDatabase {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
  }
  prepare(sql: string) {
    const stmt = this.db.prepare(sql);
    const isTouch = /^UPDATE threads SET (?:last_activity_at|updated_at)\b/.test(sql.trim());
    return {
      run: (...args: unknown[]) => {
        if (isTouch) touchRuns += 1;
        return stmt.run(...args);
      },
      get: (...args: unknown[]) => stmt.get(...args),
      all: (...args: unknown[]) => stmt.all(...args),
    };
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("./sqlite.js", () => ({ DatabaseSync: InstrumentedDatabase }));

// Loaded dynamically so the shim is in place first (same pattern as the other
// store tests).
const { ConversationStore } = await import("./ConversationStore.js");

function itemUpdated(threadId: string, turnId: string, at: number, i: number): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    provider: "opencode",
    at,
    source: "kone.store",
    turnId,
    item: {
      itemId: `item-${i}`,
      kind: "assistant_text",
      status: "in-progress",
      text: `delta ${i}`,
    },
  };
}

describe("ConversationStore streaming-path recency stamp", () => {
  test("a turn's per-delta item.updated events do not each rewrite the thread row", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "kone-touch-perf-"));
    setUserDataDir(dir);
    touchRuns = 0;

    const store = new ConversationStore();
    const threadId = "thread-touch-perf";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "opencode", model: "m" });

    const t0 = 1_000_000;
    store.applyEvent({
      type: "turn.started",
      threadId,
      provider: "opencode",
      at: t0,
      source: "kone.store",
      turnId,
    });
    // The hot path: one text delta after another, thousands per real turn.
    for (let i = 0; i < 2000; i++) {
      store.applyEvent(itemUpdated(threadId, turnId, t0 + i, i));
    }
    store.applyEvent({
      type: "turn.completed",
      threadId,
      provider: "opencode",
      at: t0 + 2000,
      source: "kone.store",
      turnId,
    });

    // Recency is a turn-level stamp: only turn.started and turn.completed need
    // rewrite the thread row. The 2000 deltas must not each add one.
    expect(touchRuns).toBe(2);
  });
});
