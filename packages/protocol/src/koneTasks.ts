// kone tasks: a thread's own checklist, kept by kone rather than by the
// provider. An agent writes it through the gateway (tasks_write, tasks_update)
// and the thread's dock shows it; because kone holds it, it outlives a switch
// of provider and reads the same whichever model wrote it.
//
// Two levels and no deeper: a task, and the subtasks it splits into. A task
// with subtasks has no status of its own — it is done when they all are and
// under way once any is — so the list can never call a task finished while
// part of it is still open. Shared by the gateway that writes the list and the
// renderer that shows it.

import type { PlanTask, PlanTaskStatus } from "./planTasks.js";

export type KoneTaskStatus = PlanTaskStatus;

export const KONE_TASK_STATUSES = ["pending", "in-progress", "completed"] as const satisfies readonly KoneTaskStatus[];

/** One row an agent ticks. */
export interface KoneSubtask {
  /** Short and stable across writes, so a tick lands on the row it meant. */
  id: string;
  /** Imperative form: "Add the store". */
  content: string;
  /** Present-continuous form for the row while it is under way. */
  activeForm?: string;
  status: KoneTaskStatus;
}

/** A top-level task. With subtasks, `status` is derived from them. */
export interface KoneTask extends KoneSubtask {
  subtasks: KoneSubtask[];
}

/** A thread's list as kone holds it. */
export interface KoneTaskList {
  threadId: string;
  tasks: KoneTask[];
  /** 1 on the first write, +1 on each: a reader keeps the newest it has seen. */
  revision: number;
  updatedAt: number;
}

/** A parent's status, read off its subtasks. */
export function deriveParentStatus(subtasks: readonly KoneSubtask[]): KoneTaskStatus {
  if (subtasks.every((s) => s.status === "completed")) return "completed";
  if (subtasks.some((s) => s.status !== "pending")) return "in-progress";
  return "pending";
}

/** The list with every parent's status put back in line with its subtasks. */
export function settleKoneTasks(tasks: readonly KoneTask[]): KoneTask[] {
  return tasks.map((task) =>
    task.subtasks.length > 0 ? { ...task, status: deriveParentStatus(task.subtasks) } : task,
  );
}

/** The row a task is on now: the in-progress one, else the first still open. */
function currentOf<T extends KoneSubtask>(rows: readonly T[]): T | undefined {
  return rows.find((r) => r.status === "in-progress") ?? rows.find((r) => r.status === "pending");
}

/** The task, and the subtask within it, the agent is on right now. Null when
 *  every task is done. */
export function currentKoneTask(tasks: readonly KoneTask[]): { task: KoneTask; index: number; subtask: KoneSubtask | null; subIndex: number } | null {
  const task = currentOf(tasks);
  if (!task) return null;
  const subtask = currentOf(task.subtasks) ?? null;
  return {
    task,
    index: tasks.indexOf(task),
    subtask,
    subIndex: subtask ? task.subtasks.indexOf(subtask) : -1,
  };
}

/** The list in the shape the dock's checklist renders. */
export function koneTasksAsPlan(tasks: readonly KoneTask[]): PlanTask[] {
  return settleKoneTasks(tasks).map((task) => {
    const row: PlanTask = { id: task.id, content: task.content, status: task.status };
    if (task.activeForm) row.activeForm = task.activeForm;
    if (task.subtasks.length > 0) {
      row.subtasks = task.subtasks.map((s) => {
        const sub: PlanTask = { id: s.id, content: s.content, status: s.status };
        if (s.activeForm) sub.activeForm = s.activeForm;
        return sub;
      });
    }
    return row;
  });
}
