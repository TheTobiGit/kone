import { randomUUID } from "node:crypto";

import type { PlanTask, PlanTaskStatus } from "./types.js";

function mintPlanTaskId(): string {
  return randomUUID();
}

/** Match an id-less provider snapshot against the prior reconciled list. */
export function reconcilePlanTasks(
  prev: readonly PlanTask[],
  snapshot: readonly Omit<PlanTask, "id">[],
): PlanTask[] {
  const claimed = new Set<string>();
  return snapshot.map((entry, index) => {
    let matched: PlanTask | undefined;
    for (const p of prev) {
      if (claimed.has(p.id)) continue;
      if (p.content === entry.content) {
        matched = p;
        break;
      }
    }
    if (!matched && prev.length === snapshot.length) {
      const atIndex = prev[index];
      if (atIndex && !claimed.has(atIndex.id)) matched = atIndex;
    }
    const id = matched?.id ?? mintPlanTaskId();
    claimed.add(id);
    const task: PlanTask = {
      id,
      content: entry.content,
      status: entry.status,
    };
    if (entry.activeForm) task.activeForm = entry.activeForm;
    return task;
  });
}

function markerForStatus(status: PlanTaskStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in-progress") return "[/]";
  return "[ ]";
}

function labelForTask(task: PlanTask): string {
  return task.status === "in-progress" && task.activeForm ? task.activeForm : task.content;
}

/** Serialize tasks to markdown checkbox lines for `plan_text` item bodies. */
export function formatPlanTasks(tasks: readonly PlanTask[]): string {
  return tasks.map((t) => `- ${markerForStatus(t.status)} ${labelForTask(t)}`).join("\n");
}

/** Parse a TodoWrite tool call's streamed JSON input. Partial JSON is normal
 *  mid-stream — returns undefined on parse failure. */
export function parseTodoWriteInput(rawJson: string): Omit<PlanTask, "id">[] | undefined {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (!("todos" in parsed)) return undefined;
    const todos: unknown = parsed.todos;
    if (!Array.isArray(todos)) return undefined;
    const out: Omit<PlanTask, "id">[] = [];
    for (const entry of todos) {
      if (typeof entry !== "object" || entry === null) continue;
      const contentRaw = "content" in entry ? entry.content : undefined;
      const content = typeof contentRaw === "string" ? contentRaw.trim() : "";
      if (!content) continue;
      const activeFormRaw = "activeForm" in entry ? entry.activeForm : undefined;
      const activeForm =
        typeof activeFormRaw === "string" && activeFormRaw.trim()
          ? activeFormRaw.trim()
          : undefined;
      const statusRaw = "status" in entry ? entry.status : undefined;
      const status: PlanTaskStatus =
        statusRaw === "completed"
          ? "completed"
          : statusRaw === "in_progress"
            ? "in-progress"
            : "pending";
      const task: Omit<PlanTask, "id"> = { content, status };
      if (activeForm) task.activeForm = activeForm;
      out.push(task);
    }
    return out.length > 0 ? out : undefined;
  } catch {
    return undefined;
  }
}

/** Map a Codex `turn/plan/updated` payload to a task snapshot. */
export function parseCodexPlanSnapshot(payload: unknown): Omit<PlanTask, "id">[] | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  if (!("plan" in payload)) return undefined;
  const plan: unknown = payload.plan;
  if (!Array.isArray(plan)) return undefined;
  const out: Omit<PlanTask, "id">[] = [];
  for (const entry of plan) {
    if (typeof entry !== "object" || entry === null) continue;
    const stepRaw = "step" in entry ? entry.step : undefined;
    const content = typeof stepRaw === "string" ? stepRaw.trim() : "";
    if (!content) continue;
    const statusRaw = "status" in entry ? entry.status : undefined;
    const status: PlanTaskStatus =
      statusRaw === "completed"
        ? "completed"
        : statusRaw === "inProgress"
          ? "in-progress"
          : "pending";
    out.push({ content, status });
  }
  return out.length > 0 ? out : undefined;
}
