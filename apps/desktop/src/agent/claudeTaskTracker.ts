// Tracks Claude Code's TaskCreate / TaskUpdate / TaskList / TaskGet tools into a
// live checklist — the surface Claude actually uses for its working task list
// (TodoWrite is the older/alternate path).

import type { PlanTask, PlanTaskStatus } from "./types.js";

type ClaudeTrackedTaskStatus = "pending" | "in_progress" | "completed";

export type ClaudeTrackedTask = {
  id: string;
  subject: string;
  description?: string;
  activeForm?: string;
  status: ClaudeTrackedTaskStatus;
  owner?: string;
  blockedBy: string[];
};

type ClaudeTaskToolCall = {
  toolName: string;
  input: Record<string, unknown>;
};

function readTaskString(input: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
  }
  return undefined;
}

function readTaskId(input: Record<string, unknown>): string | undefined {
  for (const key of ["taskId", "id", "task_id"]) {
    const value = input[key];
    if (typeof value === "string" && value.trim().length > 0) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

function readTrackedTaskStatus(value: unknown): ClaudeTrackedTaskStatus | "deleted" | undefined {
  return value === "pending" || value === "in_progress" || value === "completed" || value === "deleted"
    ? value
    : undefined;
}

function readStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0);
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  // SAFETY: the typeof-object/null/array checks on this line are the narrowing itself.
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

// A tool result is opaque JSON text; this unwraps it one level. What it holds is
// the caller's to narrow — there is no single domain type at this layer.
// eslint-disable-next-line anti-slop/no-unknown-returns
function parseToolResultValue(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return undefined;
    }
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const parsed = parseToolResultValue(entry);
      if (parsed !== undefined) return parsed;
    }
    return undefined;
  }
  const record = asRecord(value);
  if (!record) return undefined;
  if (record.type === "text" && typeof record.text === "string") {
    return parseToolResultValue(record.text);
  }
  return record;
}

function parseToolResultRecord(block: Record<string, unknown>): Record<string, unknown> | undefined {
  return asRecord(parseToolResultValue(block.content));
}

function trackedTaskFromRecord(
  record: Record<string, unknown>,
  previous?: ClaudeTrackedTask,
): ClaudeTrackedTask | undefined {
  const id = readTaskId(record);
  const subject = readTaskString(record, "subject") ?? previous?.subject;
  if (!id || !subject) return undefined;

  const status = readTrackedTaskStatus(record.status);
  if (status === "deleted") return undefined;

  return {
    id,
    subject,
    description: readTaskString(record, "description") ?? previous?.description,
    activeForm: readTaskString(record, "activeForm", "active_form") ?? previous?.activeForm,
    status: status ?? previous?.status ?? "pending",
    owner: readTaskString(record, "owner") ?? previous?.owner,
    blockedBy:
      record.blockedBy !== undefined || record.blocked_by !== undefined
        ? readStringArray(record.blockedBy ?? record.blocked_by)
        : (previous?.blockedBy ?? []),
  };
}

function mergeTaskUpdate(existing: ClaudeTrackedTask, input: Record<string, unknown>): ClaudeTrackedTask {
  const status = readTrackedTaskStatus(input.status);
  const addedBlockedBy = readStringArray(input.addBlockedBy ?? input.add_blocked_by);
  return {
    ...existing,
    subject: readTaskString(input, "subject") ?? existing.subject,
    description: readTaskString(input, "description") ?? existing.description,
    activeForm: readTaskString(input, "activeForm", "active_form") ?? existing.activeForm,
    status: status && status !== "deleted" ? status : existing.status,
    owner: readTaskString(input, "owner") ?? existing.owner,
    blockedBy:
      addedBlockedBy.length > 0
        ? Array.from(new Set([...existing.blockedBy, ...addedBlockedBy]))
        : existing.blockedBy,
  };
}

/** TaskUpdate often omits `status` on the input — the new value is only on the
 *  structured tool_use_result's statusChange.to field. */
function taskUpdateInput(
  input: Record<string, unknown>,
  result: Record<string, unknown> | undefined,
): Record<string, unknown> {
  if (input.status !== undefined) return input;
  const change = asRecord(result?.statusChange);
  if (!change) return input;
  const to = readTrackedTaskStatus(change.to);
  if (!to || to === "deleted") return input;
  return { ...input, status: to };
}

function normalizeClaudeTaskToolName(toolName: string): string {
  switch (toolName.toLowerCase()) {
    case "taskcreate":
      return "TaskCreate";
    case "taskupdate":
      return "TaskUpdate";
    case "tasklist":
      return "TaskList";
    case "taskget":
      return "TaskGet";
    default:
      return toolName;
  }
}

export function isClaudeTaskTool(toolName: string | undefined): boolean {
  if (!toolName) return false;
  const normalized = toolName.toLowerCase();
  return (
    normalized === "taskcreate" ||
    normalized === "taskupdate" ||
    normalized === "tasklist" ||
    normalized === "taskget"
  );
}

export function applyClaudeTaskToolResult(
  tasks: Map<string, ClaudeTrackedTask>,
  tool: ClaudeTaskToolCall,
  resultBlock: Record<string, unknown>,
  structuredResult: unknown,
  isError: boolean,
): boolean {
  if (isError) return false;

  const toolName = normalizeClaudeTaskToolName(tool.toolName);
  // `structuredResult` may already be an object, but the Claude SDK also hands it
  // back as a JSON-encoded string. Run it through parseToolResultValue() so a
  // string payload is decoded before we interpret it — otherwise TaskCreate is
  // dropped and TaskUpdate misses statusChange.to, leaving the checklist stale.
  const result = asRecord(parseToolResultValue(structuredResult)) ?? parseToolResultRecord(resultBlock);

  switch (toolName) {
    case "TaskCreate": {
      const resultTask = asRecord(result?.task);
      if (!resultTask) return false;
      const id = readTaskId(resultTask);
      const subject = readTaskString(resultTask, "subject") ?? readTaskString(tool.input, "subject");
      if (!id || !subject) return false;
      tasks.set(id, {
        id,
        subject,
        description: readTaskString(tool.input, "description"),
        activeForm: readTaskString(tool.input, "activeForm", "active_form"),
        status: "pending",
        blockedBy: [],
      });
      return true;
    }

    case "TaskUpdate": {
      if (result?.success === false) return false;
      const taskId = readTaskId(tool.input) ?? (result ? readTaskId(result) : undefined);
      if (!taskId) return false;
      const effectiveInput = taskUpdateInput(tool.input, result);
      const status = readTrackedTaskStatus(effectiveInput.status);
      if (status === "deleted") return tasks.delete(taskId);
      const existing = tasks.get(taskId);
      if (!existing) {
        const subject = readTaskString(effectiveInput, "subject");
        if (!subject) return false;
        tasks.set(taskId, {
          id: taskId,
          subject,
          description: readTaskString(effectiveInput, "description"),
          activeForm: readTaskString(effectiveInput, "activeForm", "active_form"),
          status: status ?? "pending",
          owner: readTaskString(effectiveInput, "owner"),
          blockedBy: readStringArray(effectiveInput.addBlockedBy ?? effectiveInput.add_blocked_by),
        });
        return true;
      }
      tasks.set(taskId, mergeTaskUpdate(existing, effectiveInput));
      return true;
    }

    case "TaskGet": {
      if (!result || !("task" in result)) return false;
      const requestedTaskId = readTaskId(tool.input);
      if (result.task === null) return requestedTaskId ? tasks.delete(requestedTaskId) : false;
      const taskRecord = asRecord(result.task);
      if (!taskRecord) return false;
      const taskId = readTaskId(taskRecord);
      const task = trackedTaskFromRecord(taskRecord, taskId ? tasks.get(taskId) : undefined);
      if (!task) return false;
      tasks.set(task.id, task);
      return true;
    }

    case "TaskList": {
      if (!result || !Array.isArray(result.tasks)) return false;
      const snapshot = new Map<string, ClaudeTrackedTask>();
      for (const entry of result.tasks) {
        const record = asRecord(entry);
        if (!record) continue;
        const taskId = readTaskId(record);
        const task = trackedTaskFromRecord(record, taskId ? tasks.get(taskId) : undefined);
        if (task) snapshot.set(task.id, task);
      }
      tasks.clear();
      for (const [taskId, task] of snapshot) tasks.set(taskId, task);
      return true;
    }

    default:
      return false;
  }
}

function toPlanStatus(status: ClaudeTrackedTaskStatus): PlanTaskStatus {
  return status === "in_progress" ? "in-progress" : status;
}

/** Convert tracked Claude tasks to kone PlanTask rows for the dock. */
export function planTasksFromClaudeTracked(tasks: ReadonlyMap<string, ClaudeTrackedTask>): PlanTask[] {
  return Array.from(tasks.values(), (task) => {
    const entry: PlanTask = {
      id: task.id,
      content: task.subject,
      status: toPlanStatus(task.status),
    };
    if (task.activeForm) entry.activeForm = task.activeForm;
    return entry;
  });
}
