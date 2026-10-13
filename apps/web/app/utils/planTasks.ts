// Parse and format agent plan/task lists — the text bodies TodoWrite and similar
// tools emit as `plan_text` items.
//
// The pure parsing/formatting primitives (types, markdown + unicode parsers,
// reconciliation, wire-payload decoders) live in @kone/protocol/plan-tasks so
// the desktop adapters and this renderer share one implementation. This module
// keeps only the renderer-coupled derivation over thread blocks.

import {
  labelForTask,
  parsePlanTasks,
  type PlanTask,
} from "@kone/protocol/plan-tasks";
import { currentKoneTask, koneTasksAsPlan, type KoneTask, type KoneTaskList } from "@kone/protocol/kone-tasks";

export {
  formatPlanTasks,
  labelForTask,
  parsePlanTasks,
  planTaskCounts,
  reconcilePlanTasks,
  type PlanTask,
  type PlanTaskCounts,
  type PlanTaskStatus,
} from "@kone/protocol/plan-tasks";
export type ActivePlanState = {
  tasks: PlanTask[];
  streaming: boolean;
  /** Whose list it is: kone's own, kept through the gateway, or the one the
   *  provider's todo or plan tool sent. */
  source: "kone" | "native";
  /** The provider's own checklist, when the agent kept one beside kone's.
   *  kone's list leads; this one is shown folded under it. */
  provider?: PlanTask[];
};


/** The one task a thread is on right now, in the compact shape the away-from-
 *  thread pill needs: the task's own present-tense label plus where it sits in
 *  the checklist ("3 of 5"). */
export type ActivePlanTask = {
  label: string;
  index: number;
  total: number;
};

/** The task the agent is currently working — the in-progress row of the thread's
 *  latest plan, or (when the model hasn't flipped one yet) the first row still
 *  outstanding. Null when there's no plan, or when every task is done. */
export function activePlanTask(blocks: ThreadBlock[], kone?: readonly KoneTask[] | null): ActivePlanTask | null {
  if (kone?.length) return activeKoneTask(kone);
  const plan = deriveActivePlan(blocks);
  if (!plan || !plan.tasks.length) return null;
  let i = plan.tasks.findIndex((t) => t.status === "in-progress");
  if (i === -1) i = plan.tasks.findIndex((t) => t.status === "pending");
  if (i === -1) return null; // every task completed — the plan has nothing live left
  const task = plan.tasks[i];
  if (!task) return null;
  return { label: labelForTask(task), index: i + 1, total: plan.tasks.length };
}

/** The pill's task off a kone list. Inside a task that splits, it is the
 *  subtask, named with its task and counted among its siblings; otherwise the
 *  task itself, counted among the tasks. */
function activeKoneTask(tasks: readonly KoneTask[]): ActivePlanTask | null {
  const at = currentKoneTask(tasks);
  if (!at) return null;
  const taskLabel = labelForTask(at.task);
  if (at.subtask) {
    return {
      label: `${taskLabel} · ${labelForTask(at.subtask)}`,
      index: at.subIndex + 1,
      total: at.task.subtasks.length,
    };
  }
  return { label: taskLabel, index: at.index + 1, total: tasks.length };
}

/** What the dock's Tasks section shows: kone's own list when the thread keeps
 *  one, with any checklist the provider also sent folded under it; else the
 *  provider's checklist, as before kone kept lists. A cleared kone list hands
 *  the section back to the provider's. `live` is whether the thread is
 *  running a turn — kone's list has no stream of its own to say so. */
export function resolveDockPlan(
  kone: KoneTaskList | null | undefined,
  native: ActivePlanState | null,
  live: boolean,
): ActivePlanState | null {
  if (!kone?.tasks.length) return native;
  const plan: ActivePlanState = { tasks: koneTasksAsPlan(kone.tasks), streaming: live, source: "kone" };
  if (native?.tasks.length) plan.provider = native.tasks;
  return plan;
}

/** The agent's task plan for the floating dock — the latest `plan_text` item in
 *  the thread. Stays visible after the turn settles (even when every task is
 *  done) until a later turn replaces it with a new plan snapshot. */
export function deriveActivePlan(blocks: ThreadBlock[]): ActivePlanState | null {
  for (let i = blocks.length - 1; i >= 0; i--) {
    const b = blocks[i];
    if (!b || b.role !== "assistant") continue;
    for (let j = b.items.length - 1; j >= 0; j--) {
      const it = b.items[j];
      if (!it || it.kind !== "plan_text") continue;
      // Fall back to parsing the markdown body only when the provider gave no
      // structured tasks. Derive ids deterministically from the owning item so
      // that re-deriving the plan on unrelated reactive updates keeps the same
      // row identity (random ids would remount rows and replay Motion each time).
      const tasks = it.tasks ?? parsePlanTasks(it.text, (k) => `${it.itemId}:${k}`);
      if (!tasks.length && it.status !== "in-progress") continue;
      return {
        tasks,
        streaming: it.status === "in-progress",
        source: "native",
      };
    }
  }

  return null;
}
