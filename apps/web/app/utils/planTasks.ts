// Parse and format agent plan/task lists — the text bodies TodoWrite and similar
// tools emit as `plan_text` items.
//
// The pure parsing/formatting primitives (types, markdown + unicode parsers,
// reconciliation, wire-payload decoders) live in @kone/protocol/plan-tasks so
// the desktop adapters and this renderer share one implementation. This module
// keeps only the renderer-coupled derivation over thread blocks.

import {
  parsePlanTasks,
  type PlanTask,
} from "@kone/protocol/plan-tasks";

export {
  formatPlanTasks,
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
};

function labelForTask(task: PlanTask): string {
  return task.status === "in-progress" && task.activeForm ? task.activeForm : task.content;
}

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
export function activePlanTask(blocks: ThreadBlock[]): ActivePlanTask | null {
  const plan = deriveActivePlan(blocks);
  if (!plan || !plan.tasks.length) return null;
  let i = plan.tasks.findIndex((t) => t.status === "in-progress");
  if (i === -1) i = plan.tasks.findIndex((t) => t.status === "pending");
  if (i === -1) return null; // every task completed — the plan has nothing live left
  const task = plan.tasks[i];
  if (!task) return null;
  return { label: labelForTask(task), index: i + 1, total: plan.tasks.length };
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
      };
    }
  }

  return null;
}
