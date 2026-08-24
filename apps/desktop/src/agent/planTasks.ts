import { randomUUID } from "node:crypto";

import { z } from "zod";

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

const TodoItemWire = z.object({
  content: z.string().optional(),
  activeForm: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

const TodoWritePayloadWire = z.object({
  todos: z.array(TodoItemWire),
}).passthrough();

/** Parse a TodoWrite tool call's streamed JSON input. Partial JSON is normal
 *  mid-stream — returns undefined on parse failure. */
export function parseTodoWriteInput(rawJson: string): Omit<PlanTask, "id">[] | undefined {
  try {
    const parsed: unknown = JSON.parse(rawJson);
    const result = TodoWritePayloadWire.safeParse(parsed);
    if (!result.success) return undefined;
    const out: Omit<PlanTask, "id">[] = [];
    for (const entry of result.data.todos) {
      const content = entry.content?.trim() ?? "";
      if (!content) continue;
      const activeForm = entry.activeForm?.trim() || undefined;
      const status: PlanTaskStatus =
        entry.status === "completed"
          ? "completed"
          : entry.status === "in_progress"
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

const CodexPlanItemWire = z.object({
  step: z.string().optional(),
  status: z.string().optional(),
}).passthrough();

const CodexPlanPayloadWire = z.object({
  plan: z.array(CodexPlanItemWire),
}).passthrough();

export interface CodexPlanPayload {
  plan?: Array<{
    step?: string;
    status?: string;
  }>;
}

/** Map a Codex `turn/plan/updated` payload to a task snapshot. */
export function parseCodexPlanSnapshot(payload: CodexPlanPayload | null | undefined): Omit<PlanTask, "id">[] | undefined {
  const parsed = CodexPlanPayloadWire.safeParse(payload);
  if (!parsed.success) return undefined;
  const out: Omit<PlanTask, "id">[] = [];
  for (const entry of parsed.data.plan) {
    const content = entry.step?.trim() ?? "";
    if (!content) continue;
    const status: PlanTaskStatus =
      entry.status === "completed"
        ? "completed"
        : entry.status === "inProgress"
          ? "in-progress"
          : "pending";
    out.push({ content, status });
  }
  return out.length > 0 ? out : undefined;
}
