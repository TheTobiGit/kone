import { beforeAll, describe, expect, mock, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import {
  exportEligibility,
  exportThread,
  exportThreadChunks,
  exportThreadJsonChunks,
  exportThreadMarkdownChunks,
  TOOL_DETAIL_EXPORT_EXCERPT_CHARS,
} from "./threadExport.js";
import { decodeThreadExportJson } from "@kone/protocol/thread-export";

import { Database } from "bun:sqlite";

import type { RuntimeEvent, RuntimeItem } from "./types.js";

// Same sqlite stand-in as conversationStore.test.ts: ConversationStore imports
// node:sqlite (an Electron-runtime built-in bun can't load), so it is stood in
// for bun:sqlite behind the same surface.
let testUserDataDir = "";
function useUserDataDir(dir: string): string {
  testUserDataDir = dir;
  setUserDataDir(dir);
  return dir;
}
useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-export-test-")));

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
  useUserDataDir(mkdtempSync(path.join(tmpdir(), "kone-export-test-")));
  return new ConversationStoreCtor();
}

beforeAll(async () => {
  const storeModule = await import("./ConversationStore.js");
  ConversationStoreCtor = storeModule.ConversationStore;
});

// ── fixture ───────────────────────────────────────────────────────────────────
// Fixed timestamps throughout: the export must be byte-identical run to run,
// so nothing here may read the clock. created_at is the one stamp the public
// API does not let callers set, so the fixture pins it with one UPDATE.

const T0 = Date.UTC(2026, 2, 10, 9, 0, 0);
const GOLDEN_THREAD = "thread-export-golden";
const LONG_LINE_COUNT = 600;
const longDetail = Array.from(
  { length: LONG_LINE_COUNT },
  (_, index) => `output line ${String(index).padStart(4, "0")}: reversed [3, 2, 1]`,
).join("\n");

type SeedEventBase = {
  threadId: string;
  provider: "codex";
  at: number;
  source: "kone.store";
};

function baseEvent(threadId: string, at: number): SeedEventBase {
  return { threadId, provider: "codex", at, source: "kone.store" };
}

function seedGoldenThread(store: ConversationStoreType): void {
  store.ensureThread({
    threadId: GOLDEN_THREAD,
    projectPath: "/tmp/kone-export-golden",
    provider: "codex",
    model: "gpt-5.3",
  });
  store.setTitle(GOLDEN_THREAD, "Export golden thread");
  store.recordUserBlock({
    blockId: "u-golden-1",
    threadId: GOLDEN_THREAD,
    text: "How do I reverse a list in Python?",
    at: T0,
  });
  store.applyEvent({ ...baseEvent(GOLDEN_THREAD, T0 + 1000), type: "turn.started", turnId: "turn-golden-1" });
  const narrative: RuntimeItem = {
    itemId: "i-text-1",
    kind: "assistant_text",
    status: "completed",
    text: "You can use slicing:",
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1100),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: narrative,
  });
  const reasoning: RuntimeItem = {
    itemId: "i-reason-1",
    kind: "reasoning_text",
    status: "completed",
    text: "The user asks a basic question; answer directly.",
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1150),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: reasoning,
  });
  const plan: RuntimeItem = {
    itemId: "i-plan-1",
    kind: "plan_text",
    status: "completed",
    text: "",
    tasks: [
      { id: "p1", content: "Answer the question", status: "completed" },
      { id: "p2", content: "Show the command output", status: "in-progress", activeForm: "Showing output" },
    ],
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1200),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: plan,
  });
  const toolCall: RuntimeItem = {
    itemId: "i-tool-1",
    kind: "tool_call",
    status: "completed",
    text: 'python3 -c "print([1, 2, 3][::-1])"',
    name: "exec",
    detail: longDetail,
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1300),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: toolCall,
  });
  const taskCall: RuntimeItem = {
    itemId: "i-task-1",
    kind: "tool_call",
    status: "completed",
    text: "Search the router",
    name: "Task",
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1350),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: taskCall,
  });
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1400),
    type: "subagent.completed",
    turnId: "turn-golden-1",
    subagent: {
      toolUseId: "toolu-1",
      taskId: "task-1",
      parentItemId: "i-task-1",
      agentType: "explore",
      description: "Search the router",
      prompt: "Find where the router is defined.",
      model: "sonnet",
      status: "completed",
      summary: "The router lives in src/router.ts.",
      tokens: 350,
      toolUses: 4,
      startedAt: T0 + 1360,
      endedAt: T0 + 1390,
    },
  });
  const childText: RuntimeItem = {
    itemId: "i-child-1",
    kind: "assistant_text",
    status: "completed",
    text: "Looking at the router…",
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1380),
    type: "item.completed",
    turnId: "turn-golden-1",
    item: childText,
    subagentToolUseId: "toolu-1",
  });
  const usage: RuntimeEvent = {
    ...baseEvent(GOLDEN_THREAD, T0 + 1500),
    type: "thread.token-usage.updated",
    usage: { input: 1200, output: 800, total: 2000 },
  };
  store.applyEvent(usage);
  store.applyEvent({ ...baseEvent(GOLDEN_THREAD, T0 + 1600), type: "turn.completed", turnId: "turn-golden-1" });
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 1700),
    type: "thread.state.changed",
    state: "compacted",
    beforeTokens: 90000,
    afterTokens: 12000,
  });
  store.recordUserBlock({
    blockId: "u-golden-2",
    threadId: GOLDEN_THREAD,
    text: "And in Rust?",
    at: T0 + 2000,
  });
  store.applyEvent({ ...baseEvent(GOLDEN_THREAD, T0 + 2100), type: "turn.started", turnId: "turn-golden-2" });
  const failedText: RuntimeItem = {
    itemId: "i-text-2",
    kind: "assistant_text",
    status: "completed",
    text: "Use `.rev()`:",
  };
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 2200),
    type: "item.completed",
    turnId: "turn-golden-2",
    item: failedText,
  });
  store.applyEvent({
    ...baseEvent(GOLDEN_THREAD, T0 + 2300),
    type: "turn.aborted",
    turnId: "turn-golden-2",
    reason: "failed",
    message: "provider exploded",
  });
  // Pin the one clock-derived stamp so the golden file is byte-stable.
  const db = new Database(path.join(testUserDataDir, "kone.sqlite"));
  try {
    db.prepare("UPDATE threads SET created_at = ? WHERE thread_id = ?").run(T0 - 1000, GOLDEN_THREAD);
  } finally {
    db.close();
  }
}

function markdownOf(store: ConversationStoreType, pageUserBlocks?: number): string {
  const chunks =
    pageUserBlocks === undefined
      ? exportThreadMarkdownChunks(store, GOLDEN_THREAD)
      : exportThreadMarkdownChunks(store, GOLDEN_THREAD, pageUserBlocks);
  return Array.from(chunks).join("");
}

function jsonOf(store: ConversationStoreType, pageUserBlocks?: number): string {
  const chunks =
    pageUserBlocks === undefined
      ? exportThreadJsonChunks(store, GOLDEN_THREAD)
      : exportThreadJsonChunks(store, GOLDEN_THREAD, pageUserBlocks);
  return Array.from(chunks).join("");
}

// ── eligibility ───────────────────────────────────────────────────────────────

describe("exportEligibility", () => {
  test("a missing thread is not exportable", () => {
    expect(exportEligibility(freshStore(), "nope")).toBe("thread-not-found");
  });

  test("a thread with no turns is not exportable", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-empty", projectPath: "/tmp/x", provider: "codex" });
    expect(exportEligibility(store, "t-empty")).toBe("no-completed-turns");
  });

  test("a thread with only a user prompt is not exportable", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-prompt", projectPath: "/tmp/x", provider: "codex" });
    store.recordUserBlock({ threadId: "t-prompt", text: "hello?", at: T0 });
    expect(exportEligibility(store, "t-prompt")).toBe("no-completed-turns");
  });

  test("a running turn blocks the export", () => {
    const store = freshStore();
    store.ensureThread({ threadId: "t-running", projectPath: "/tmp/x", provider: "codex" });
    store.recordUserBlock({ threadId: "t-running", text: "hello?", at: T0 });
    store.applyEvent({ ...baseEvent("t-running", T0 + 100), type: "turn.started", turnId: "turn-1" });
    store.applyEvent({ ...baseEvent("t-running", T0 + 200), type: "turn.completed", turnId: "turn-1" });
    store.recordUserBlock({ threadId: "t-running", text: "again", at: T0 + 300 });
    store.applyEvent({ ...baseEvent("t-running", T0 + 400), type: "turn.started", turnId: "turn-2" });
    expect(exportEligibility(store, "t-running")).toBe("thread-running");
  });

  test("a thread with a completed turn is exportable", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(exportEligibility(store, GOLDEN_THREAD)).toBeNull();
  });
});

// ── Markdown determinism ──────────────────────────────────────────────────────

describe("markdown export", () => {
  test("the same thread exports byte-identical Markdown twice", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(markdownOf(store)).toBe(markdownOf(store));
  });

  test("paging does not change the Markdown bytes", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(markdownOf(store, 1)).toBe(markdownOf(store));
  });

  test("matches the golden file", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const actual = markdownOf(store);
    const goldenPath = new URL("./threadExport.golden.md", import.meta.url);
    if (process.env.UPDATE_GOLDEN === "1") {
      writeFileSync(goldenPath, actual);
      return;
    }
    expect(actual).toBe(readFileSync(goldenPath, "utf8"));
  });

  test("tool bodies are excerpted in Markdown, never silently", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const md = markdownOf(store);
    expect(md).not.toContain(longDetail);
    expect(md).toContain(
      `[… showing ${TOOL_DETAIL_EXPORT_EXCERPT_CHARS} of ${longDetail.length} chars — the full output is in the JSON export]`,
    );
  });

  test("covers header, turns, tools, subagents, compactions, usage, and errors", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const md = markdownOf(store);
    expect(md).toContain("# Export golden thread");
    expect(md).toContain("- Provider: codex");
    expect(md).toContain("- Model: gpt-5.3");
    expect(md).toContain("How do I reverse a list in Python?");
    expect(md).toContain("You can use slicing:");
    expect(md).toContain("### Tool `exec` · completed");
    expect(md).toContain("#### Subagent `Search the router` · completed");
    expect(md).toContain("The router lives in src/router.ts.");
    expect(md).toContain("> Compaction ·");
    expect(md).toContain("90000 → 12000 tokens");
    expect(md).toContain("*Usage: 1200 in · 800 out · 2000 total*");
    expect(md).toContain("## Assistant ·");
    expect(md).toContain("failed");
    expect(md).toContain("Error: provider exploded");
  });
});

// ── JSON round-trip ───────────────────────────────────────────────────────────

describe("json export", () => {
  test("the same thread exports byte-identical JSON twice", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(jsonOf(store)).toBe(jsonOf(store));
  });

  test("paging does not change the JSON bytes", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(jsonOf(store, 1)).toBe(jsonOf(store));
  });

  test("export decodes to a structure equivalent to the store", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const decoded = decodeThreadExportJson(jsonOf(store));
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    const meta = store.threadMeta(GOLDEN_THREAD);
    expect(decoded.thread.threadId).toBe(GOLDEN_THREAD);
    expect(decoded.thread.provider).toBe("codex");
    expect(decoded.thread.model).toBe(meta?.model ?? null);
    expect(decoded.thread.createdAt).toBe(meta?.createdAt);
    expect(decoded.thread.title).toBe(meta?.title ?? null);
    const stored = store.loadThread(GOLDEN_THREAD);
    expect(decoded.blocks.length).toBe(stored?.blocks.length);
    expect(decoded.blocks.map((b) => b.role)).toEqual(stored?.blocks.map((b) => b.role));
    // The lossless half of the contract: bodies longer than the 8000-char
    // wire cap survive byte-identical. Compared after decoding (rather than
    // against the raw JSON text, where newlines are escaped).
    expect(longDetail.length).toBeGreaterThan(8000);
    const assistantItems = decoded.blocks.flatMap((b) => (b.role === "assistant" ? b.items : []));
    expect(assistantItems.find((i) => i.itemId === "i-tool-1")?.detail).toBe(longDetail);
    expect(decoded.compactions).toEqual([
      { at: T0 + 1700, beforeTokens: 90000, afterTokens: 12000 },
    ]);
    const usage = store.listTurnUsage(GOLDEN_THREAD);
    expect(decoded.usage.length).toBe(usage.length);
    expect(decoded.usage[0]?.turnId).toBe("turn-golden-1");
    expect(decoded.usage[0]?.inputTokens).toBe(1200);
  });

  test("subagent runs round-trip with their nested items", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const decoded = decodeThreadExportJson(jsonOf(store));
    const firstAssistant = decoded?.blocks[1];
    if (!firstAssistant || firstAssistant.role !== "assistant") {
      throw new Error("golden fixture lost its first assistant turn");
    }
    const taskItem = firstAssistant.items.find((i) => i.itemId === "i-task-1");
    expect(taskItem?.subagent?.summary).toBe("The router lives in src/router.ts.");
    expect(taskItem?.subagent?.items.map((i) => i.text)).toEqual(["Looking at the router…"]);
  });

  test("format dispatch yields both documents", () => {
    const store = freshStore();
    seedGoldenThread(store);
    expect(Array.from(exportThreadChunks(store, GOLDEN_THREAD, "markdown")).join("")).toBe(
      markdownOf(store),
    );
    expect(Array.from(exportThreadChunks(store, GOLDEN_THREAD, "json")).join("")).toBe(
      jsonOf(store),
    );
  });
});

// ── file outcome ──────────────────────────────────────────────────────────────

describe("exportThread", () => {
  test("writes Markdown and JSON files that match the streamed chunks", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const dir = mkdtempSync(path.join(tmpdir(), "kone-export-out-"));
    const mdPath = path.join(dir, "thread.md");
    const mdOutcome = exportThread(store, GOLDEN_THREAD, "markdown", mdPath);
    if (!mdOutcome.ok) throw new Error(`markdown export failed: ${mdOutcome.message}`);
    expect(readFileSync(mdPath, "utf8")).toBe(markdownOf(store));
    expect(mdOutcome.bytes).toBeGreaterThan(0);
    const jsonPath = path.join(dir, "thread.json");
    const jsonOutcome = exportThread(store, GOLDEN_THREAD, "json", jsonPath);
    if (!jsonOutcome.ok) throw new Error(`json export failed: ${jsonOutcome.message}`);
    expect(readFileSync(jsonPath, "utf8")).toBe(jsonOf(store));
  });

  test("refuses the same threads the eligibility predicate blocks", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const dir = mkdtempSync(path.join(tmpdir(), "kone-export-out-"));
    const missing = exportThread(store, "nope", "markdown", path.join(dir, "x.md"));
    expect(missing.ok).toBe(false);
    if (missing.ok) return;
    expect(missing.reason).toBe("thread-not-found");
    const emptyThread = "t-empty-file";
    store.ensureThread({ threadId: emptyThread, projectPath: "/tmp/x", provider: "codex" });
    const empty = exportThread(store, emptyThread, "json", path.join(dir, "y.json"));
    expect(empty.ok).toBe(false);
    if (empty.ok) return;
    expect(empty.reason).toBe("no-completed-turns");
    expect(existsSync(path.join(dir, "y.json"))).toBe(false);
  });

  test("rejects bad inputs without touching the store", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const dir = mkdtempSync(path.join(tmpdir(), "kone-export-out-"));
    const badFormat = exportThread(store, GOLDEN_THREAD, "zip", path.join(dir, "x.md"));
    expect(badFormat.ok).toBe(false);
    const relative = exportThread(store, GOLDEN_THREAD, "markdown", "relative/path.md");
    expect(relative.ok).toBe(false);
    if (relative.ok) return;
    expect(relative.reason).toBe("invalid-path");
  });

  test("a write failure reports instead of leaving a half-file", () => {
    const store = freshStore();
    seedGoldenThread(store);
    const missingDir = path.join(tmpdir(), "kone-export-missing-dir");
    const target = path.join(missingDir, "thread.md");
    const outcome = exportThread(store, GOLDEN_THREAD, "markdown", target);
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.reason).toBe("write-failed");
    expect(existsSync(target)).toBe(false);
  });
});
