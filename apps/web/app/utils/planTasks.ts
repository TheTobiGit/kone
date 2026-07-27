// Parse and format agent plan/task lists — the text bodies TodoWrite and similar
// tools emit as `plan_text` items. Supports markdown checkboxes (`- [ ]`, `- [x]`,
// `- [/]` for in-progress) and the unicode markers ClaudeAdapter's formatTodos
// produces (`○`, `→`, `✓`).

import type { ThreadBlock } from "~/composables/useAgent";

export type PlanTaskStatus = "pending" | "in_progress" | "completed";

export type PlanTask = {
  content: string;
  status: PlanTaskStatus;
};

export type ActivePlanState = {
  source: string;
  streaming: boolean;
};

const MD_LINE = /^-\s+\[( |x|X|\/|\-)\]\s+(.+)$/;
const UNICODE_LINE = /^([○→✓])\s+(.+)$/;

function statusFromMarker(marker: string): PlanTaskStatus {
  const m = marker.toLowerCase();
  if (m === "x") return "completed";
  if (m === "/" || m === "-") return "in_progress";
  return "pending";
}

function statusFromGlyph(glyph: string): PlanTaskStatus {
  if (glyph === "✓") return "completed";
  if (glyph === "→") return "in_progress";
  return "pending";
}

function markerForStatus(status: PlanTaskStatus): string {
  if (status === "completed") return "[x]";
  if (status === "in_progress") return "[/]";
  return "[ ]";
}

/** Parse a plan_text body into structured tasks. Unknown lines are skipped. */
export function parsePlanTasks(source: string): PlanTask[] {
  const out: PlanTask[] = [];
  for (const raw of source.split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    const md = MD_LINE.exec(line);
    if (md) {
      out.push({ status: statusFromMarker(md[1]!), content: md[2]!.trim() });
      continue;
    }
    const uni = UNICODE_LINE.exec(line);
    if (uni) {
      out.push({ status: statusFromGlyph(uni[1]!), content: uni[2]!.trim() });
    }
  }
  return out;
}

/** Serialize tasks back to markdown checkbox lines. */
export function formatPlanTasks(tasks: readonly PlanTask[]): string {
  return tasks.map((t) => `- ${markerForStatus(t.status)} ${t.content}`).join("\n");
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
    else if (t.status === "in_progress") inProgress += 1;
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
      const tasks = parsePlanTasks(it.text);
      if (!tasks.length && it.status !== "in-progress") continue;
      latest = {
        source: it.text,
        streaming: it.status === "in-progress",
      };
    }
  }

  return latest;
}
