import { describe, expect, test } from "bun:test";

import type { PlanTask } from "~/types/desktop";
import type { AssistantBlock, ThreadBlock } from "~/composables/useAgent";
import {
  deriveActivePlan,
  formatPlanTasks,
  parsePlanTasks,
  reconcilePlanTasks,
} from "./planTasks";

function task(content: string, status: PlanTask["status"] = "pending", id?: string): PlanTask {
  return { id: id ?? crypto.randomUUID(), content, status };
}

function snap(content: string, status: PlanTask["status"] = "pending") {
  return { content, status };
}

describe("reconcilePlanTasks", () => {
  test("duplicate labels map 1:1 by occurrence", () => {
    const prev = [task("Write tests", "pending", "a"), task("Write tests", "pending", "b")];
    const next = reconcilePlanTasks(prev, [snap("Write tests"), snap("Write tests")]);
    expect(next.map((t) => t.id)).toEqual(["a", "b"]);
  });

  test("status flip preserves ids", () => {
    const prev = [task("Run linter", "pending", "x"), task("Run tests", "pending", "y")];
    const next = reconcilePlanTasks(prev, [
      snap("Run linter", "in-progress"),
      snap("Run tests", "pending"),
    ]);
    expect(next[0]?.id).toBe("x");
    expect(next[0]?.status).toBe("in-progress");
    expect(next[1]?.id).toBe("y");
  });

  test("mid-list insert keeps existing ids", () => {
    const prev = [task("A", "completed", "1"), task("B", "pending", "2"), task("C", "pending", "3")];
    const next = reconcilePlanTasks(prev, [
      snap("A", "completed"),
      snap("New", "in-progress"),
      snap("B", "pending"),
      snap("C", "pending"),
    ]);
    expect(next[0]?.id).toBe("1");
    expect(next[2]?.id).toBe("2");
    expect(next[3]?.id).toBe("3");
    expect(next[1]?.content).toBe("New");
  });

  test("reword at same index keeps id", () => {
    const prev = [task("Old label", "pending", "keep")];
    const next = reconcilePlanTasks(prev, [snap("New label", "in-progress")]);
    expect(next[0]?.id).toBe("keep");
    expect(next[0]?.content).toBe("New label");
  });

  test("removed task is dropped", () => {
    const prev = [task("Stay", "pending", "s"), task("Go", "pending", "g")];
    const next = reconcilePlanTasks(prev, [snap("Stay")]);
    expect(next).toHaveLength(1);
    expect(next[0]?.id).toBe("s");
  });

  test("re-added task mints a fresh id", () => {
    const prev = [task("Other", "completed", "o")];
    const next = reconcilePlanTasks(prev, [snap("Other"), snap("Return", "pending")]);
    expect(next[0]?.id).toBe("o");
    expect(next[1]?.content).toBe("Return");
    expect(next[1]?.id).not.toBe("o");
  });
});

describe("parsePlanTasks / formatPlanTasks", () => {
  test("markdown checkboxes round-trip", () => {
    const source = "- [ ] Pending\n- [/] Live\n- [x] Done";
    const tasks = parsePlanTasks(source);
    expect(tasks.map((t) => t.status)).toEqual(["pending", "in-progress", "completed"]);
    expect(formatPlanTasks(tasks)).toBe(source);
  });

  test("unicode markers", () => {
    const tasks = parsePlanTasks("○ Pending\n→ Live\n✓ Done");
    expect(tasks.map((t) => t.status)).toEqual(["pending", "in-progress", "completed"]);
  });

  test("[X] counts as completed", () => {
    const tasks = parsePlanTasks("- [X] Done");
    expect(tasks[0]?.status).toBe("completed");
  });

  test("skips malformed lines", () => {
    expect(parsePlanTasks("not a task\n- [ ] Valid")).toHaveLength(1);
  });

  test("empty input yields empty list", () => {
    expect(parsePlanTasks("")).toEqual([]);
  });
});

describe("deriveActivePlan", () => {
  function assistantBlock(items: AssistantBlock["items"], turnId = "t1"): AssistantBlock {
    return {
      id: "b1",
      role: "assistant",
      turnId,
      items,
      state: "completed",
      at: 1,
    };
  }

  test("prefers item.tasks over parsed text", () => {
    const structured = [task("From data", "in-progress", "id-1")];
    const blocks: ThreadBlock[] = [
      assistantBlock([
        {
          itemId: "p1",
          kind: "plan_text",
          status: "in-progress",
          text: "- [ ] Ignored",
          tasks: structured,
        },
      ]),
    ];
    const plan = deriveActivePlan(blocks);
    expect(plan?.tasks).toEqual(structured);
    expect(plan?.streaming).toBe(true);
  });

  test("falls back to parsing text", () => {
    const blocks: ThreadBlock[] = [
      assistantBlock([
        {
          itemId: "p1",
          kind: "plan_text",
          status: "completed",
          text: "- [x] Legacy task",
        },
      ]),
    ];
    const plan = deriveActivePlan(blocks);
    expect(plan?.tasks).toHaveLength(1);
    expect(plan?.tasks[0]?.content).toBe("Legacy task");
    expect(plan?.streaming).toBe(false);
  });

  test("skips prose items with no tasks", () => {
    const blocks: ThreadBlock[] = [
      assistantBlock([
        {
          itemId: "p1",
          kind: "plan_text",
          status: "completed",
          text: "Here is my plan in prose with no checkboxes.",
        },
      ]),
    ];
    expect(deriveActivePlan(blocks)).toBeNull();
  });

  test("takes the latest plan across blocks", () => {
    const blocks: ThreadBlock[] = [
      assistantBlock(
        [{ itemId: "p1", kind: "plan_text", status: "completed", text: "- [x] Old" }],
        "t1",
      ),
      assistantBlock(
        [{ itemId: "p2", kind: "plan_text", status: "in-progress", text: "- [/] New" }],
        "t2",
      ),
    ];
    const plan = deriveActivePlan(blocks);
    expect(plan?.tasks[0]?.content).toBe("New");
    expect(plan?.streaming).toBe(true);
  });

  test("derives stable fallback ids across re-derivation", () => {
    const blocks: ThreadBlock[] = [
      assistantBlock([
        {
          itemId: "p1",
          kind: "plan_text",
          status: "in-progress",
          text: "- [x] First\n- [/] Second",
        },
      ]),
    ];
    const first = deriveActivePlan(blocks);
    const second = deriveActivePlan(blocks);
    // Ids are keyed off the owning item, so re-deriving the same blocks yields
    // the same ids (no random remint → rows keep their identity).
    expect(first?.tasks.map((t) => t.id)).toEqual(["p1:0", "p1:1"]);
    expect(second?.tasks.map((t) => t.id)).toEqual(first?.tasks.map((t) => t.id));
  });

  test("holds after the turn settles", () => {
    const blocks: ThreadBlock[] = [
      assistantBlock([
        {
          itemId: "p1",
          kind: "plan_text",
          status: "completed",
          text: "- [x] All done",
        },
      ]),
    ];
    const plan = deriveActivePlan(blocks);
    expect(plan).not.toBeNull();
    expect(plan?.streaming).toBe(false);
  });
});
