import { beforeEach, describe, expect, test } from "bun:test";

import type { KoneTaskList } from "@kone/protocol/kone-tasks";
import type { RuntimeEvent } from "~/types/desktop";
import { koneTaskListFor, resetKoneTasksForTest } from "./useKoneTasks";

function list(revision: number, content: string): KoneTaskList {
  return { threadId: "t1", tasks: [{ id: "t1", content, status: "pending", subtasks: [] }], revision, updatedAt: revision };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

let listener: ((event: RuntimeEvent) => void) | null;
let reads: string[];
let resolveRead: ((value: KoneTaskList | null) => void) | null;

beforeEach(() => {
  listener = null;
  reads = [];
  resolveRead = null;
  resetKoneTasksForTest(() => ({
    taskList: (threadId: string) => {
      reads.push(threadId);
      return new Promise<KoneTaskList | null>((resolve) => {
        resolveRead = resolve;
      });
    },
    onEvent: (cb: (event: RuntimeEvent) => void) => {
      listener = cb;
      return () => (listener = null);
    },
  }));
});

function push(next: KoneTaskList): void {
  listener?.({
    type: "thread.tasks-updated",
    threadId: next.threadId,
    provider: "claudeAgent",
    at: 0,
    source: "kone.store",
    tasks: next.tasks,
    revision: next.revision,
    updatedAt: next.updatedAt,
  });
}

describe("kone task lists in the renderer", () => {
  test("the first read for a thread fetches its list once", async () => {
    expect(koneTaskListFor("t1")).toBeNull();
    koneTaskListFor("t1");
    await tick();
    expect(reads).toEqual(["t1"]);
    resolveRead?.(list(1, "A"));
    await tick();
    expect(koneTaskListFor("t1")?.tasks[0]?.content).toBe("A");
    expect(reads).toEqual(["t1"]);
  });

  test("a write on the event stream lands whole, and a slower stale read cannot overwrite it", async () => {
    koneTaskListFor("t1");
    await tick();
    push(list(3, "Newer"));
    resolveRead?.(list(2, "Older"));
    await tick();
    expect(koneTaskListFor("t1")?.revision).toBe(3);
    expect(koneTaskListFor("t1")?.tasks[0]?.content).toBe("Newer");
    push(list(2, "Replayed"));
    expect(koneTaskListFor("t1")?.tasks[0]?.content).toBe("Newer");
  });

  test("a failed first read is tried again, and the list lands once it reads", async () => {
    let calls = 0;
    resetKoneTasksForTest(() => ({
      taskList: () => (++calls === 1 ? Promise.reject(new Error("main process busy")) : Promise.resolve(list(1, "Retried"))),
      onEvent: () => () => {},
    }));
    expect(koneTaskListFor("t1")).toBeNull();
    await new Promise((resolve) => setTimeout(resolve, 650));
    expect(calls).toBe(2);
    expect(koneTaskListFor("t1")?.tasks[0]?.content).toBe("Retried");
  });

  test("no thread, no list", () => {
    expect(koneTaskListFor(null)).toBeNull();
    expect(koneTaskListFor("")).toBeNull();
  });
});
