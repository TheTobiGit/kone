import { describe, expect, test } from "bun:test";

import {
  applyClaudeTaskToolResult,
  isClaudeTaskTool,
  planTasksFromClaudeTracked,
} from "./claudeTaskTracker.js";

describe("claudeTaskTracker", () => {
  test("isClaudeTaskTool is case-insensitive", () => {
    expect(isClaudeTaskTool("TaskCreate")).toBe(true);
    expect(isClaudeTaskTool("taskcreate")).toBe(true);
    expect(isClaudeTaskTool("bash")).toBe(false);
  });

  test("TaskCreate reads structured tool_use_result", () => {
    const tasks = new Map();
    const changed = applyClaudeTaskToolResult(
      tasks,
      { toolName: "taskcreate", input: { subject: "Demo one", description: "x" } },
      { type: "tool_result", content: "Created task #1" },
      { task: { id: "1", subject: "Demo one" } },
      false,
    );
    expect(changed).toBe(true);
    expect(planTasksFromClaudeTracked(tasks)).toEqual([
      { id: "1", content: "Demo one", status: "pending" },
    ]);
  });

  test("TaskUpdate marks a tracked task completed", () => {
    const tasks = new Map();
    applyClaudeTaskToolResult(
      tasks,
      { toolName: "TaskCreate", input: { subject: "Demo", description: "x" } },
      {},
      { task: { id: "1", subject: "Demo" } },
      false,
    );
    const changed = applyClaudeTaskToolResult(
      tasks,
      { toolName: "taskupdate", input: { taskId: "1", status: "completed" } },
      { type: "tool_result", content: "Updated" },
      { success: true, taskId: "1", updatedFields: ["status"] },
      false,
    );
    expect(changed).toBe(true);
    expect(planTasksFromClaudeTracked(tasks)[0]?.status).toBe("completed");
  });

  test("TaskUpdate reads status from structured statusChange when input omits it", () => {
    const tasks = new Map();
    applyClaudeTaskToolResult(
      tasks,
      { toolName: "TaskCreate", input: { subject: "Demo one", description: "x" } },
      {},
      { task: { id: "1", subject: "Demo one" } },
      false,
    );
    applyClaudeTaskToolResult(
      tasks,
      { toolName: "TaskCreate", input: { subject: "Demo two", description: "x" } },
      {},
      { task: { id: "2", subject: "Demo two" } },
      false,
    );
    applyClaudeTaskToolResult(
      tasks,
      { toolName: "taskupdate", input: { taskId: "1" } },
      { type: "tool_result", content: "Updated task #1 status" },
      {
        success: true,
        taskId: "1",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "completed" },
      },
      false,
    );
    applyClaudeTaskToolResult(
      tasks,
      { toolName: "taskupdate", input: { taskId: "2" } },
      { type: "tool_result", content: "Updated task #2 status" },
      {
        success: true,
        taskId: "2",
        updatedFields: ["status"],
        statusChange: { from: "pending", to: "completed" },
      },
      false,
    );
    expect(planTasksFromClaudeTracked(tasks).map((t) => t.status)).toEqual([
      "completed",
      "completed",
    ]);
  });

  test("decodes a JSON-encoded string structured result", () => {
    const tasks = new Map();
    const created = applyClaudeTaskToolResult(
      tasks,
      { toolName: "TaskCreate", input: { subject: "Demo one", description: "x" } },
      { type: "tool_result", content: "Created" },
      JSON.stringify({ task: { id: "1", subject: "Demo one" } }),
      false,
    );
    expect(created).toBe(true);
    // TaskUpdate whose status lives only on the stringified statusChange.
    const updated = applyClaudeTaskToolResult(
      tasks,
      { toolName: "taskupdate", input: { taskId: "1" } },
      { type: "tool_result", content: "Updated" },
      JSON.stringify({ success: true, taskId: "1", statusChange: { from: "pending", to: "completed" } }),
      false,
    );
    expect(updated).toBe(true);
    expect(planTasksFromClaudeTracked(tasks)).toEqual([
      { id: "1", content: "Demo one", status: "completed" },
    ]);
  });
});
