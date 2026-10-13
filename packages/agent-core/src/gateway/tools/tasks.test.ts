import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import type { KoneTask } from "@kone/protocol/kone-tasks";

import { setUserDataDir } from "../../userDataDir.js";
import type { RuntimeEvent } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayRecord, GatewayToolContext } from "../schemas.js";
import { createTaskTools } from "./tasks.js";

// A thread's kone task list on a real store: written whole, ticked by id,
// subtasks one level deep with the parent's status read off them.

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

mock.module("../../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type Store = import("../../ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("../../ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("../../ConversationStore.js")).ConversationStore;
});

let store: Store;
let events: RuntimeEvent[];
let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-tasks-test-"));
  setUserDataDir(dir);
  store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "sienna", projectPath: "/repo", provider: "claudeAgent" });
  store.ensureThread({ threadId: "other", projectPath: "/repo", provider: "codex" });
  events = [];
  registry = createRegistry(createTaskTools({ store, emit: (event) => events.push(event) }));
});

const ctxFor = (threadId: string, turnId: string | null = "turn-1"): GatewayToolContext => ({
  threadId,
  turnId,
  provider: "claudeAgent",
  cwd: "/repo",
  requestId: 1,
});
const call = (tool: string, args: GatewayRecord, from = "sienna") => registry.call(ctxFor(from), tool, args);
const textOf = (result: Awaited<ReturnType<typeof call>>) => result.content.map((c) => ("text" in c ? c.text : "")).join("\n");
const tasks = (threadId = "sienna"): KoneTask[] => store.threadTaskList(threadId)?.tasks ?? [];
const idsAndStatuses = (list: KoneTask[]) =>
  list.map((t) => [t.id, t.status, t.subtasks.map((s) => [s.id, s.status])]);

describe("kone tasks", () => {
  test("a whole-list write mints ids, derives parent status from subtasks, and publishes the list", async () => {
    const res = await call("tasks_write", {
      tasks: [
        { content: "Add the store", status: "completed" },
        {
          content: "Wire the tools",
          status: "pending",
          subtasks: [
            { content: "Schema", status: "completed" },
            { content: "Handler", status: "in-progress", activeForm: "Writing the handler" },
            { content: "Tests" },
          ],
        },
        { content: "Dock" },
      ],
    });
    expect(res.isError).toBeFalsy();
    expect(idsAndStatuses(tasks())).toEqual([
      ["t1", "completed", []],
      // The parent said pending; its subtasks say it is under way.
      ["t2", "in-progress", [["t3", "completed"], ["t4", "in-progress"], ["t5", "pending"]]],
      ["t6", "pending", []],
    ]);
    expect(textOf(res)).toContain("Your tasks, 1 of 3 done:");
    expect(textOf(res)).toContain("- [t2] → Wire the tools (1/3)");
    expect(textOf(res)).toContain("  - [t4] → Handler");
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event.type).toBe("thread.tasks-updated");
    if (event.type === "thread.tasks-updated") {
      expect(event.threadId).toBe("sienna");
      expect(event.revision).toBe(1);
      expect(event.tasks).toEqual(tasks());
    }
  });

  test("rewriting the list keeps the ids of rows with the same words and never reuses a dropped one", async () => {
    await call("tasks_write", { tasks: [{ content: "A" }, { content: "B", subtasks: [{ content: "B1" }] }] });
    expect(idsAndStatuses(tasks())).toEqual([["t1", "pending", []], ["t2", "pending", [["t3", "pending"]]]]);
    await call("tasks_write", {
      tasks: [{ content: "B", subtasks: [{ content: "B1", status: "completed" }, { content: "B2" }] }, { content: "C" }],
    });
    // A is gone; t1 is not handed to C.
    expect(idsAndStatuses(tasks())).toEqual([["t2", "in-progress", [["t3", "completed"], ["t4", "pending"]]], ["t5", "pending", []]]);
    expect(store.threadTaskList("sienna")?.revision).toBe(2);
  });

  test("an id kone never gave is ignored, so a stale tick can never land on a new row", async () => {
    await call("tasks_write", { tasks: [{ id: "t1", content: "Old" }] });
    // The agent's own "t1" was not kone's to give: the row gets a minted id.
    expect(idsAndStatuses(tasks())).toEqual([["t1", "pending", []]]);
    await call("tasks_write", { tasks: [{ id: "mine", content: "Kept" }] });
    await call("tasks_write", { tasks: [] });
    await call("tasks_update", { add: [{ content: "New" }] });
    // t1 and t2 went to rows since dropped; the new row gets neither.
    expect(tasks().map((t) => t.id)).toEqual(["t3"]);
    const stale = await call("tasks_update", { updates: [{ id: "t1", status: "completed" }] });
    expect(stale.isError).toBe(true);
  });

  test("an update ticks leaves, refuses a parent's status, adds rows and subtasks, and completes the parent", async () => {
    await call("tasks_write", { tasks: [{ content: "Wire", subtasks: [{ content: "One" }, { content: "Two" }] }] });
    const refused = await call("tasks_update", { updates: [{ id: "t1", status: "completed" }] });
    expect(refused.isError).toBe(true);
    expect(textOf(refused)).toContain("status follows them");

    await call("tasks_update", {
      updates: [{ id: "t2", status: "completed" }, { id: "t3", status: "in-progress" }],
      add: [{ content: "Ship" }, { parent: "t1", content: "Three" }],
    });
    expect(idsAndStatuses(tasks())).toEqual([
      ["t1", "in-progress", [["t2", "completed"], ["t3", "in-progress"], ["t5", "pending"]]],
      ["t4", "pending", []],
    ]);

    await call("tasks_update", { updates: [{ id: "t3", status: "completed" }, { id: "t5", status: "completed" }] });
    expect(tasks()[0]!.status).toBe("completed");
  });

  test("a bad id, a nested subtask or a duplicate id is refused and the list is left as it was", async () => {
    await call("tasks_write", { tasks: [{ content: "A", subtasks: [{ content: "A1" }] }] });
    const before = store.threadTaskList("sienna");

    const unknown = await call("tasks_update", { updates: [{ id: "t9", status: "completed" }] });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('No row "t9"');

    const nested = await call("tasks_update", { add: [{ parent: "t2", content: "deeper" }] });
    expect(nested.isError).toBe(true);
    expect(textOf(nested)).toContain("a subtask has none of its own");

    const dup = await call("tasks_write", { tasks: [{ id: "t1", content: "A" }, { id: "t1", content: "B" }] });
    expect(dup.isError).toBe(true);

    expect(store.threadTaskList("sienna")).toEqual(before);
    expect(events).toHaveLength(1);
  });

  test("the list is the calling thread's own, and reading it needs no live turn", async () => {
    await call("tasks_write", { tasks: [{ content: "Mine" }] });
    expect(tasks("other")).toEqual([]);
    const read = await registry.call(ctxFor("sienna", null), "tasks_read", {});
    expect(textOf(read)).toContain("- [t1] ○ Mine");
    const write = await registry.call(ctxFor("sienna", null), "tasks_write", { tasks: [] });
    expect(write.isError).toBe(true);
  });

  test("an empty write clears the list", async () => {
    await call("tasks_write", { tasks: [{ content: "A" }] });
    const res = await call("tasks_write", { tasks: [] });
    expect(textOf(res)).toBe("Your task list is empty.");
    expect(tasks()).toEqual([]);
  });
});
