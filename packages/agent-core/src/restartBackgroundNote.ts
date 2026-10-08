import type { PlanTask } from "@kone/protocol/plan-tasks";

// Restart background note.
//
// A restart kills every live provider process, and with it whatever background
// work their turns had running: provider-native subagents and Claude's
// task-tracker checklist. Their rows are sealed at boot so the thread reads
// settled, but the agent that started them — and is still waiting to hear
// back — is never told. This module renders the bounded note that rides in
// front of that agent's next turn, naming what was cancelled.
//
// Two rules shape it:
// - It only ever annotates a turn somebody else started. Staging a note must
//   never wake a settled thread, so nothing here dispatches.
// - It is bounded in entries and label length. A thread can leave dozens of
//   subagents live, and the note competes with the actual request for the
//   model's attention.

export type RestartBackgroundWorkKind = "subagent" | "shell" | "monitor" | "task";

export interface RestartCancelledBackgroundWork {
  kind: RestartBackgroundWorkKind;
  /** One line naming the work — a subagent's description, a task's text. */
  label: string;
  /** Stable identity within the thread, for dedupe across restarts. */
  id: string;
}

const MAX_LABEL_LENGTH = 160;
const MAX_NOTE_ENTRIES = 10;

/** Collapse whitespace and bound a label, or undefined when there is nothing
 *  worth showing. */
export function compactBackgroundLabel(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const text = value.replaceAll(/\s+/g, " ").trim();
  if (text.length === 0) return undefined;
  return text.length > MAX_LABEL_LENGTH ? `${text.slice(0, MAX_LABEL_LENGTH - 1)}…` : text;
}

function identity(entry: RestartCancelledBackgroundWork): string {
  return `${entry.kind}\u0000${entry.id}`;
}

/** Union two work lists, keeping the first-seen order and dropping identities
 *  already present. */
export function mergeRestartCancelledBackgroundWork(
  current: ReadonlyArray<RestartCancelledBackgroundWork>,
  added: ReadonlyArray<RestartCancelledBackgroundWork>,
): RestartCancelledBackgroundWork[] {
  const seen = new Set(current.map(identity));
  const merged = [...current];
  for (const entry of added) {
    const key = identity(entry);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(entry);
  }
  return merged;
}

/** The provider-facing note. Bounded so it cannot crowd out the turn. */
export function restartCancelledBackgroundWorkNote(
  work: ReadonlyArray<RestartCancelledBackgroundWork>,
): string {
  const omitted = work.length - MAX_NOTE_ENTRIES;
  return [
    "Note: kone restarted and this background work was cancelled before it finished. It will not report back:",
    ...work.slice(0, MAX_NOTE_ENTRIES).map((entry) => `- ${entry.kind}: ${entry.label}`),
    ...(omitted > 0 ? [`- and ${omitted} more`] : []),
  ].join("\n");
}

/** The live subagent rows a restart seals, as work entries. A subagent is
 *  always something the agent is waiting on, so none are dropped. */
export function subagentRestartWork(
  rows: ReadonlyArray<{
    threadId: string;
    toolUseId: string;
    description: string | null;
    agentType: string | null;
  }>,
): Array<{ threadId: string; work: RestartCancelledBackgroundWork }> {
  return rows.map((row) => ({
    threadId: row.threadId,
    work: {
      kind: "subagent",
      label:
        compactBackgroundLabel(row.description) ??
        compactBackgroundLabel(row.agentType) ??
        "subagent",
      id: row.toolUseId,
    },
  }));
}

/** The unfinished tasks in the plan item a restart seals, as work entries. A
 *  plan item is per-turn, so its still-open tasks died with that turn. */
export function planTaskRestartWork(
  rows: ReadonlyArray<{ threadId: string; itemId: string; tasksJson: string | null }>,
): Array<{ threadId: string; work: RestartCancelledBackgroundWork }> {
  const out: Array<{ threadId: string; work: RestartCancelledBackgroundWork }> = [];
  for (const row of rows) {
    if (!row.tasksJson) continue;
    let tasks: PlanTask[];
    try {
      // SAFETY: tasks_json is written only by the plan-item event path, which
      // stores an array of resolved PlanTask snapshots.
      tasks = JSON.parse(row.tasksJson) as PlanTask[];
    } catch {
      continue;
    }
    if (!Array.isArray(tasks)) continue;
    tasks.forEach((task, index) => {
      if (!task || task.status === "completed") return;
      out.push({
        threadId: row.threadId,
        work: {
          kind: "task",
          label: compactBackgroundLabel(task.content) ?? "open task",
          id: `${row.itemId}:${task.id ?? index}`,
        },
      });
    });
  }
  return out;
}
