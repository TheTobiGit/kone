import { describe, expect, test } from "bun:test";

import {
  formatPlanTasks,
  labelForTask,
  parseCodexPlanSnapshot,
  parsePlanTasks,
  parseTodoWriteInput,
  planTaskCounts,
  reconcilePlanTasks,
  type PlanTask,
} from "./planTasks.js";

function task(content: string, status: PlanTask["status"] = "pending", id?: string, activeForm?: string): PlanTask {
  const t: PlanTask = { id: id ?? crypto.randomUUID(), content, status };
  if (activeForm) t.activeForm = activeForm;
  return t;
}

function snap(content: string, status: PlanTask["status"] = "pending", activeForm?: string) {
  const s: Omit<PlanTask, "id"> = { content, status };
  if (activeForm) s.activeForm = activeForm;
  return s;
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

  test("preserves activeForm across reconciliation", () => {
    const prev = [task("Task", "pending", "t1")];
    const next = reconcilePlanTasks(prev, [snap("Task", "in-progress", "Doing task...")]);
    expect(next[0]?.activeForm).toBe("Doing task...");
  });
});

describe("parsePlanTasks / formatPlanTasks", () => {
  test("markdown checkboxes round-trip with dashes", () => {
    const source = "- [ ] Pending\n- [/] Live\n- [x] Done";
    const tasks = parsePlanTasks(source);
    expect(tasks.map((t) => t.status)).toEqual(["pending", "in-progress", "completed"]);
    expect(formatPlanTasks(tasks)).toBe(source);
  });

  test("markdown checkboxes with asterisks and pluses", () => {
    const source = "* [ ] Star pending\n+ [x] Plus done\n- [-] Dash live";
    const tasks = parsePlanTasks(source);
    expect(tasks.map((t) => t.status)).toEqual(["pending", "completed", "in-progress"]);
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

  test("uses custom id generator", () => {
    const tasks = parsePlanTasks("- [ ] One\n- [ ] Two", (i) => `custom-${i}`);
    expect(tasks.map((t) => t.id)).toEqual(["custom-0", "custom-1"]);
  });
});

describe("labelForTask", () => {
  test("returns activeForm when in-progress and activeForm is present", () => {
    expect(labelForTask(task("Build feature", "in-progress", "1", "Building feature..."))).toBe(
      "Building feature...",
    );
  });

  test("returns content when pending even if activeForm is present", () => {
    expect(labelForTask(task("Build feature", "pending", "1", "Building feature..."))).toBe(
      "Build feature",
    );
  });

  test("returns content when in-progress but activeForm is undefined", () => {
    expect(labelForTask(task("Build feature", "in-progress", "1"))).toBe("Build feature");
  });
});

describe("planTaskCounts", () => {
  test("calculates totals, completed, and inProgress correctly", () => {
    const tasks = [
      task("1", "completed"),
      task("2", "completed"),
      task("3", "in-progress"),
      task("4", "pending"),
    ];
    expect(planTaskCounts(tasks)).toEqual({
      total: 4,
      completed: 2,
      inProgress: 1,
    });
  });

  test("handles empty task list", () => {
    expect(planTaskCounts([])).toEqual({
      total: 0,
      completed: 0,
      inProgress: 0,
    });
  });
});

describe("parseTodoWriteInput", () => {
  test("parses valid TodoWrite payload", () => {
    const json = JSON.stringify({
      todos: [
        { content: "First task", status: "completed" },
        { content: "Second task", status: "in_progress", activeForm: "Doing second task" },
        { content: "Third task", status: "pending" },
      ],
    });
    const parsed = parseTodoWriteInput(json);
    expect(parsed).toEqual([
      { content: "First task", status: "completed" },
      { content: "Second task", status: "in-progress", activeForm: "Doing second task" },
      { content: "Third task", status: "pending" },
    ]);
  });

  test("returns undefined on malformed json or missing todos", () => {
    expect(parseTodoWriteInput("invalid json")).toBeUndefined();
    expect(parseTodoWriteInput(JSON.stringify({}))).toBeUndefined();
    expect(parseTodoWriteInput(JSON.stringify({ todos: [] }))).toBeUndefined();
  });
});

describe("parseCodexPlanSnapshot", () => {
  test("parses valid Codex payload", () => {
    const payload = {
      plan: [
        { step: "Step 1", status: "completed" },
        { step: "Step 2", status: "inProgress" },
        { step: "Step 3", status: "pending" },
      ],
    };
    const parsed = parseCodexPlanSnapshot(payload);
    expect(parsed).toEqual([
      { content: "Step 1", status: "completed" },
      { content: "Step 2", status: "in-progress" },
      { content: "Step 3", status: "pending" },
    ]);
  });

  test("returns undefined on null or empty payload", () => {
    expect(parseCodexPlanSnapshot(null)).toBeUndefined();
    expect(parseCodexPlanSnapshot(undefined)).toBeUndefined();
    expect(parseCodexPlanSnapshot({ plan: [] })).toBeUndefined();
  });
});
