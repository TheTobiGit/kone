import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

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

import { setUserDataDir } from "../userDataDir.js";
import type { RuntimeEvent } from "../types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-page-steer-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("../ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function event(partial: Partial<RuntimeEvent> & Pick<RuntimeEvent, "type" | "threadId">): RuntimeEvent {
  // SAFETY: the base fields every event in this test carries; the caller
  // supplies the discriminating type and threadId.
  return { provider: "codex", at: 1, source: "kone.store", ...partial } as RuntimeEvent;
}

type PageOptions = { limit: number; countBlocks: boolean; cursor?: string };

describe("loadThreadPage block paging across a steered turn", () => {
  test("pages every physical block exactly once, complete and without duplicates", async () => {
    const { getConversationStore } = await import("../ConversationStore.js");
    const store = getConversationStore();
    store.ensureThread({ threadId: "t-steer", projectPath: "/p", provider: "codex", model: "gpt-x" });
    store.recordUserBlock({ threadId: "t-steer", text: "opening", at: 1 });
    store.applyEvent(event({ type: "turn.started", threadId: "t-steer", turnId: "turn-1", at: 2 }));
    store.applyEvent(
      event({
        type: "item.updated",
        threadId: "t-steer",
        turnId: "turn-1",
        at: 3,
        item: { itemId: "i-1", kind: "assistant_text", status: "completed", text: "part one" },
      }),
    );
    store.recordUserBlock({ threadId: "t-steer", text: "steer", at: 4 });
    const steerBlock = store.loadThread("t-steer")!.blocks.at(-1)!;
    store.markUserBlockSteered("t-steer", steerBlock.id, "turn-1", 5);
    store.applyEvent(
      event({
        type: "item.updated",
        threadId: "t-steer",
        turnId: "turn-1",
        at: 6,
        item: { itemId: "i-2", kind: "assistant_text", status: "completed", text: "part two" },
      }),
    );
    store.applyEvent(event({ type: "turn.completed", threadId: "t-steer", turnId: "turn-1", at: 7 }));

    const full = store.loadThread("t-steer")!;
    const fullTexts = full.blocks.map((block) =>
      block.role === "user" ? block.text : block.items.map((item) => item.text).join(" "),
    );
    // The steered turn reads as three rendered pieces around the steer.
    expect(fullTexts).toEqual(["opening", "part one", "steer", "part two"]);

    // Page the whole thread with a block-count limit of one, following the
    // cursor, and confirm the pages reconstruct the transcript exactly.
    const paged: string[] = [];
    let cursor: string | null = null;
    for (let guard = 0; guard < 20; guard += 1) {
      const params: PageOptions = {
        limit: 1,
        countBlocks: true,
      };
      if (cursor) params.cursor = cursor;
      const page = store.loadThreadPage("t-steer", params);
      if (!page) throw new Error("page missing");
      const pageTexts = page.blocks.map((block) =>
        block.role === "user" ? block.text : block.items.map((item) => item.text).join(" "),
      );
      // Pages arrive newest-first; prepend each whole page to rebuild order.
      paged.unshift(...pageTexts);
      if (!page.nextCursor) break;
      cursor = page.nextCursor;
    }
    expect(paged).toEqual(fullTexts);
  });
});
