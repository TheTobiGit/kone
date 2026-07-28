// Parse and format agent plan/task lists — the text bodies TodoWrite and similar
// tools emit as `plan_text` items. Supports markdown checkboxes (`- [ ]`, `- [x]`,
// `- [/]` for in-progress) and the unicode markers ClaudeAdapter's formatTodos
// produces (`○`, `→`, `✓`).

import type { ThreadBlock } from "~/composables/useAgent";
import type { PlanTask, PlanTaskStatus } from "~/types/desktop";

export type { PlanTask, PlanTaskStatus };

export type ActivePlanState = {
  tasks: PlanTask[];
  streaming: boolean;
};

const MD_LINE = /^-\s+\[( |x|X|\/|\-)\]\s+(.+)$/;
const UNICODE_LINE = /^([○→✓])\s+(.+)$/;

function mintPlanTaskId(): string {
  return crypto.randomUUID();
}

function statusFromMarker(marker: string): PlanTaskStatus {
  const m = marker.toLowerCase();
  if (m === "x") return "completed";
  if (m === "/" || m === "-") return "in-progress";
  return "pending";
}

function statusFromGlyph(glyph: string): PlanTaskStatus {
  if (glyph === "✓") return "completed";
  if (glyph === "→") return "in-progress";
  return "pending";
}

function markerForStatus(status: PlanTaskStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in-progress") return "[/]";
  return "[ ]";
}

function labelForTask(task: PlanTask): string {
  return task.status === "in-progress" && task.activeForm ? task.activeForm : task.content;
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
    return {
      id,
      content: entry.content,
      ...(entry.activeForm ? { activeForm: entry.activeForm } : {}),
      status: entry.status,
    };
  });
}

/** Parse a plan_text body into structured tasks. Unknown lines are skipped.
 *  `idFor(index)` supplies a stable id per parsed row — pass a deterministic one
 *  (e.g. keyed off the owning item) so repeated parses don't remint random ids
 *  and remount every row. Defaults to a fresh random id. */
export function parsePlanTasks(
  source: string,
  idFor: (index: number) => string = mintPlanTaskId,
): PlanTask[] {
  const out: PlanTask[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const md = MD_LINE.exec(line);
    if (md) {
      out.push({
        id: idFor(out.length),
        status: statusFromMarker(md[1]!),
        content: md[2]!.trim(),
      });
      continue;
    }
    const uni = UNICODE_LINE.exec(line);
    if (uni) {
      out.push({
        id: idFor(out.length),
        status: statusFromGlyph(uni[1]!),
        content: uni[2]!.trim(),
      });
    }
  }
  return out;
}

/** Serialize tasks back to markdown checkbox lines. */
export function formatPlanTasks(tasks: readonly PlanTask[]): string {
  return tasks.map((t) => `- ${markerForStatus(t.status)} ${labelForTask(t)}`).join("\n");
}

export function planTaskCounts(tasks: readonly PlanTask[]): {
  total: number;
  completed: number;
  inProgress: number;
} {
  let completed = 0;
  let inProgress = 0;
  for (const t of tasks) {
    if (t.status === "completed") completed += 1;
    else if (t.status === "in-progress") inProgress += 1;
  }
  return { total: tasks.length, completed, inProgress };
}

/** The agent's task plan for the floating dock — the latest `plan_text` item in
 *  the thread. Stays visible after the turn settles (even when every task is
 *  done) until a later turn replaces it with a new plan snapshot. */
export function deriveActivePlan(blocks: ThreadBlock[]): ActivePlanState | null {
  let latest: ActivePlanState | null = null;

  for (const b of blocks) {
    if (b.role !== "assistant") continue;
    for (const it of b.items) {
      if (it.kind !== "plan_text") continue;
      // Fall back to parsing the markdown body only when the provider gave no
      // structured tasks. Derive ids deterministically from the owning item so
      // that re-deriving the plan on unrelated reactive updates keeps the same
      // row identity (random ids would remount rows and replay Motion each time).
      const tasks = it.tasks ?? parsePlanTasks(it.text, (i) => `${it.itemId}:${i}`);
      if (!tasks.length && it.status !== "in-progress") continue;
      latest = {
        tasks,
        streaming: it.status === "in-progress",
      };
    }
  }

  return latest;
}
