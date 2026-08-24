// Parse and format agent plan/task lists — the text bodies TodoWrite and similar
// tools emit as `plan_text` items. Supports markdown checkboxes (`- [ ]`, `- [x]`,
// `- [/]` for in-progress) and the unicode markers ClaudeAdapter's formatTodos
// produces (`○`, `→`, `✓`).
//
// Shared by the desktop adapters (producing snapshots from provider wire
// payloads) and the web renderer (parsing rendered `plan_text` bodies).

import { z } from "zod";

/** Matches the shared vocabulary of Claude's TodoWrite and Codex's
 *  TurnPlanStep — the only two producers. */
export type PlanTaskStatus = "pending" | "in-progress" | "completed";

export type PlanTask = {
  /** kone-minted and held stable across snapshots. Providers send no ids (see
   *  agent-plan-tasks-plan.md §0), and the renderer needs a stable key:
   *  content is not one, because a checklist may legitimately repeat a label.
   *  Render identity only — nothing addresses a task by it. */
  id: string;
  /** Imperative form: TodoWrite `content`, Codex `step`. */
  content: string;
  /** Present-continuous form for the in-progress row. TodoWrite only; Codex
   *  sends no equivalent. */
  activeForm?: string;
  status: PlanTaskStatus;
};

const MD_LINE = /^-\s+\[( |x|X|\/|-)\]\s+(.+)$/;
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
    const task: PlanTask = { id, content: entry.content, status: entry.status };
    if (entry.activeForm) task.activeForm = entry.activeForm;
    return task;
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

/** Serialize tasks to markdown checkbox lines for `plan_text` item bodies. */
export function formatPlanTasks(tasks: readonly PlanTask[]): string {
  return tasks.map((t) => `- ${markerForStatus(t.status)} ${labelForTask(t)}`).join("\n");
}

export type PlanTaskCounts = {
  total: number;
  completed: number;
  inProgress: number;
};

export function planTaskCounts(tasks: readonly PlanTask[]): PlanTaskCounts {
  let completed = 0;
  let inProgress = 0;
  for (const t of tasks) {
    if (t.status === "completed") completed += 1;
    else if (t.status === "in-progress") inProgress += 1;
  }
  return { total: tasks.length, completed, inProgress };
}

// ── provider wire payloads ───────────────────────────────────────────────────

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
