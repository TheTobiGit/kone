import { z } from "zod";

import {
  KONE_TASK_STATUSES,
  settleKoneTasks,
  type KoneSubtask,
  type KoneTask,
  type KoneTaskList,
  type KoneTaskStatus,
} from "@kone/protocol/kone-tasks";

import type { ThreadTasksDraft } from "../../store/threadTasks.js";
import type { EmitEvent } from "../../types.js";
import { GatewayToolError, type GatewayRecord, type GatewayToolContext, type GatewayToolResult, type ToolEntry } from "../schemas.js";

// kone tasks: the checklist a thread keeps through the gateway rather than
// through its provider's own todo or plan tool. kone holds it, so the thread's
// dock shows it the same whichever model wrote it and it carries over a switch
// of provider. A task may split into subtasks, one level deep; a task with
// subtasks takes its status from them, so the agent only ever ticks leaves.
//
// The list is the calling thread's own. Every write publishes the whole list,
// so the dock never has to read it back.

/** What the task tools need of the store. */
export interface TaskToolStore {
  threadTaskList(threadId: string): KoneTaskList | null;
  writeThreadTasks(threadId: string, change: (current: ThreadTasksDraft) => ThreadTasksDraft): KoneTaskList | null;
}

export interface TaskToolInput {
  store: TaskToolStore;
  emit?: EmitEvent;
}

const MAX_TASKS = 40;
const MAX_SUBTASKS = 25;
const TEXT_MAX = 300;
const ID_MAX = 40;

const StatusSchema = z.enum(KONE_TASK_STATUSES);
const IdSchema = z.string().trim().min(1).max(ID_MAX);
const TextSchema = z.string().trim().min(1).max(TEXT_MAX);

const SubtaskInputSchema = z.object({
  id: IdSchema.optional(),
  content: TextSchema,
  activeForm: TextSchema.optional(),
  status: StatusSchema.optional(),
});

const TaskInputSchema = SubtaskInputSchema.extend({
  subtasks: z.array(SubtaskInputSchema).max(MAX_SUBTASKS).optional(),
});

const TasksWriteSchema = z.object({ tasks: z.array(TaskInputSchema).max(MAX_TASKS) });

const TasksUpdateSchema = z
  .object({
    updates: z
      .array(
        z.object({
          id: IdSchema,
          status: StatusSchema.optional(),
          content: TextSchema.optional(),
          activeForm: TextSchema.optional(),
        }),
      )
      .max(MAX_TASKS)
      .optional(),
    add: z
      .array(
        z.object({
          parent: IdSchema.optional(),
          content: TextSchema,
          activeForm: TextSchema.optional(),
          status: StatusSchema.optional(),
        }),
      )
      .max(MAX_SUBTASKS)
      .optional(),
  })
  .refine((v) => (v.updates?.length ?? 0) + (v.add?.length ?? 0) > 0, {
    message: "Say what changes: updates for rows already on the list, add for new ones.",
  });

const TasksReadSchema = z.object({});

const STATUS_DESCRIPTION = "pending, in-progress or completed. Default pending.";

const ROW_PROPERTIES = {
  id: {
    type: "string",
    description:
      "The id kone gave the row, to keep it the same row. Omit for a new row: kone gives it one, or keeps the id of the row with the same words. An id kone did not give is ignored.",
  },
  content: { type: "string", description: 'What the row is, in the imperative: "Add the store".' },
  activeForm: { type: "string", description: 'How it reads while under way: "Adding the store".' },
  status: { type: "string", enum: [...KONE_TASK_STATUSES], description: STATUS_DESCRIPTION },
} satisfies GatewayRecord;

const TASKS_WRITE_JSON_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      description: "The whole list, in order. It replaces the list you had; an empty array clears it.",
      items: {
        type: "object",
        properties: {
          ...ROW_PROPERTIES,
          status: {
            type: "string",
            enum: [...KONE_TASK_STATUSES],
            description: `${STATUS_DESCRIPTION} Ignored on a task with subtasks: it follows them.`,
          },
          subtasks: {
            type: "array",
            description: "The steps this task splits into. One level only: a subtask has none of its own.",
            items: { type: "object", properties: ROW_PROPERTIES, required: ["content"] },
          },
        },
        required: ["content"],
      },
    },
  },
  required: ["tasks"],
} satisfies GatewayRecord;

const TASKS_UPDATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    updates: {
      type: "array",
      description:
        "Rows to change, by id: tick one off, start the next, reword one. A task with subtasks takes its status from them, so tick its subtasks instead.",
      items: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string", enum: [...KONE_TASK_STATUSES] },
          content: { type: "string" },
          activeForm: { type: "string" },
        },
        required: ["id"],
      },
    },
    add: {
      type: "array",
      description: "New rows, appended: a task, or with parent a subtask under that task.",
      items: {
        type: "object",
        properties: {
          parent: { type: "string", description: "The task to add it under. Omit to add a top-level task." },
          content: ROW_PROPERTIES.content,
          activeForm: ROW_PROPERTIES.activeForm,
          status: ROW_PROPERTIES.status,
        },
        required: ["content"],
      },
    },
  },
} satisfies GatewayRecord;

type RowInput = z.infer<typeof SubtaskInputSchema>;

const GLYPH = { pending: "○", "in-progress": "→", completed: "✓" } satisfies Record<KoneTaskStatus, string>;

function line(row: KoneSubtask, indent: string, suffix = ""): string {
  return `${indent}- [${row.id}] ${GLYPH[row.status]} ${row.content}${suffix}`;
}

/** The list as an agent reads it back: ids first, so the next tick can name one. */
export function renderTaskList(tasks: readonly KoneTask[]): string {
  if (tasks.length === 0) return "Your task list is empty.";
  const done = tasks.filter((t) => t.status === "completed").length;
  const rows: string[] = [`Your tasks, ${done} of ${tasks.length} done:`];
  for (const task of tasks) {
    const subDone = task.subtasks.filter((s) => s.status === "completed").length;
    rows.push(line(task, "", task.subtasks.length > 0 ? ` (${subDone}/${task.subtasks.length})` : ""));
    for (const sub of task.subtasks) rows.push(line(sub, "  "));
  }
  return rows.join("\n");
}

/** Mints row ids from the thread's counter, skipping any id in `reserved`. */
function idMinter(nextId: number, reserved: Set<string>) {
  let next = nextId;
  return {
    mint(): string {
      let id = `t${next++}`;
      while (reserved.has(id)) id = `t${next++}`;
      reserved.add(id);
      return id;
    },
    get nextId() {
      return next;
    },
  };
}

function row(input: RowInput, id: string): KoneSubtask {
  const out: KoneSubtask = { id, content: input.content, status: input.status ?? "pending" };
  if (input.activeForm) out.activeForm = input.activeForm;
  return out;
}

/** The next list for a whole-list write. A row without an id keeps the id of
 *  the prior row with the same words at the same place in the tree, so
 *  rewriting the list does not renumber what was already on it. */
export function replaceTasks(current: ThreadTasksDraft, input: z.infer<typeof TasksWriteSchema>["tasks"]): ThreadTasksDraft {
  const onList = new Set(current.tasks.flatMap((t) => [t.id, ...t.subtasks.map((s) => s.id)]));
  // An id is kept only when it names a row already on the list. A new row
  // always gets a fresh one, so no id ever comes back for a different row and
  // a tick sent against an old list cannot land on a new one.
  const kept = (id: string | undefined) => (id && onList.has(id) ? id : undefined);
  const used = new Set<string>();
  const name = (id: string | undefined) => {
    if (!id) return;
    if (used.has(id)) throw new GatewayToolError("invalid_input", `Two rows share the id "${id}". Give each row its own, or leave it out.`);
    used.add(id);
  };
  for (const task of input) {
    name(kept(task.id));
    for (const sub of task.subtasks ?? []) name(kept(sub.id));
  }

  // Fresh ids skip every id on the list, even one this write drops.
  const minter = idMinter(current.nextId, new Set(onList));
  const match = <T extends KoneSubtask>(pool: readonly T[], content: string): T | undefined => {
    const found = pool.find((p) => !used.has(p.id) && p.content === content);
    if (found) used.add(found.id);
    return found;
  };

  const tasks = input.map((task): KoneTask => {
    const taskId = kept(task.id);
    const prior = taskId ? current.tasks.find((t) => t.id === taskId) : match(current.tasks, task.content);
    const parent = row(task, taskId ?? prior?.id ?? minter.mint());
    const subtasks = (task.subtasks ?? []).map((sub) =>
      row(sub, kept(sub.id) ?? match(prior?.subtasks ?? [], sub.content)?.id ?? minter.mint()),
    );
    return { ...parent, subtasks };
  });
  return { tasks: settleKoneTasks(tasks), nextId: minter.nextId };
}

type Located = { kind: "task"; task: KoneTask } | { kind: "subtask"; subtask: KoneSubtask; parent: KoneTask };

/** The next list for a set of ticks, rewordings and additions. */
export function updateTasks(current: ThreadTasksDraft, input: z.infer<typeof TasksUpdateSchema>): ThreadTasksDraft {
  const tasks: KoneTask[] = current.tasks.map((t) => ({ ...t, subtasks: t.subtasks.map((s) => ({ ...s })) }));
  const find = (id: string): Located | null => {
    for (const task of tasks) {
      if (task.id === id) return { kind: "task", task };
      const subtask = task.subtasks.find((s) => s.id === id);
      if (subtask) return { kind: "subtask", subtask, parent: task };
    }
    return null;
  };
  const missing = (id: string) =>
    new GatewayToolError("not_found", `No row "${id}" on your task list.\n${renderTaskList(current.tasks)}`);

  for (const change of input.updates ?? []) {
    const hit = find(change.id);
    if (!hit) throw missing(change.id);
    const target = hit.kind === "task" ? hit.task : hit.subtask;
    if (change.status) {
      if (hit.kind === "task" && hit.task.subtasks.length > 0) {
        throw new GatewayToolError(
          "invalid_input",
          `Task ${change.id} has subtasks, so its status follows them. Tick its subtasks instead.`,
        );
      }
      target.status = change.status;
    }
    if (change.content) target.content = change.content;
    if (change.activeForm) target.activeForm = change.activeForm;
  }

  const reserved = new Set(tasks.flatMap((t) => [t.id, ...t.subtasks.map((s) => s.id)]));
  const minter = idMinter(current.nextId, reserved);
  for (const addition of input.add ?? []) {
    if (!addition.parent) {
      if (tasks.length >= MAX_TASKS) throw new GatewayToolError("invalid_input", `A list holds ${MAX_TASKS} tasks at most.`);
      tasks.push({ ...row(addition, minter.mint()), subtasks: [] });
      continue;
    }
    const hit = find(addition.parent);
    if (!hit) throw missing(addition.parent);
    if (hit.kind === "subtask") {
      throw new GatewayToolError("invalid_input", `${addition.parent} is a subtask; a subtask has none of its own.`);
    }
    if (hit.task.subtasks.length >= MAX_SUBTASKS) {
      throw new GatewayToolError("invalid_input", `A task holds ${MAX_SUBTASKS} subtasks at most.`);
    }
    hit.task.subtasks.push(row(addition, minter.mint()));
  }
  return { tasks: settleKoneTasks(tasks), nextId: minter.nextId };
}

function rowRecord(row: KoneSubtask): GatewayRecord {
  const out: GatewayRecord = { id: row.id, content: row.content, status: row.status };
  if (row.activeForm) out.activeForm = row.activeForm;
  return out;
}

/** The list as plain data for a tool result. */
function taskRecords(tasks: readonly KoneTask[]): GatewayRecord[] {
  return tasks.map((task) => ({ ...rowRecord(task), subtasks: task.subtasks.map(rowRecord) }));
}

export function createTaskTools(input: TaskToolInput): ToolEntry[] {
  const { store } = input;

  const write = (ctx: GatewayToolContext, change: (current: ThreadTasksDraft) => ThreadTasksDraft): GatewayToolResult => {
    const list = store.writeThreadTasks(ctx.threadId, change);
    if (!list) throw new GatewayToolError("internal", "kone could not store the task list.");
    input.emit?.({
      type: "thread.tasks-updated",
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      tasks: list.tasks,
      revision: list.revision,
      updatedAt: list.updatedAt,
    });
    return {
      content: [{ type: "text", text: renderTaskList(list.tasks) }],
      structuredContent: { tasks: taskRecords(list.tasks), revision: list.revision },
    };
  };

  const writeHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = TasksWriteSchema.parse(args);
    return write(ctx, (current) => replaceTasks(current, parsed.tasks));
  };

  const updateHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = TasksUpdateSchema.parse(args);
    return write(ctx, (current) => updateTasks(current, parsed));
  };

  const readHandler = async (ctx: GatewayToolContext): Promise<GatewayToolResult> => {
    const list = store.threadTaskList(ctx.threadId);
    return {
      content: [{ type: "text", text: renderTaskList(list?.tasks ?? []) }],
      structuredContent: { tasks: taskRecords(list?.tasks ?? []), revision: list?.revision ?? 0 },
    };
  };

  return [
    {
      name: "tasks_write",
      description:
        "Set your task list for this thread: the whole list, in order, replacing the one you had. A task may split into subtasks (one level only); a task with subtasks is done when they all are, so you tick the subtasks, never the task. Each row has content (imperative), an optional activeForm (how it reads while under way) and a status: pending, in-progress or completed. kone shows the list in the thread's dock and keeps it across a switch of provider. Keep a row's id to keep it the same row; kone answers with every id. Use it for work of three steps or more, and keep one row in progress at a time.",
      inputSchema: TasksWriteSchema,
      jsonSchema: TASKS_WRITE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet: "Lay out your plan as a task list, with subtasks under a task where it splits; the user watches it in the thread's dock.",
      promptGuidelines: [
        "Track multi-step work with kone's task list (tasks_write, then tasks_update as you go) rather than your provider's own todo or plan tool: kone's is the list the user sees in the thread's dock, and it survives a switch of provider. Tick a row the moment it is done, not in a batch at the end.",
      ],
      handler: writeHandler,
    },
    {
      name: "tasks_update",
      description:
        "Change rows on your task list without sending it whole: updates ticks, starts or rewords rows by id; add appends new tasks, or subtasks under a task with parent. A task with subtasks takes its status from them, so tick the subtasks. Answers with the whole list.",
      inputSchema: TasksUpdateSchema,
      jsonSchema: TASKS_UPDATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      promptSnippet: "Tick off, start, reword or add rows on your task list as the work moves.",
      handler: updateHandler,
    },
    {
      name: "tasks_read",
      description:
        "Read your task list for this thread, with each row's id and status. You get the whole list back from every tasks_write and tasks_update, so read it only when you have lost track of it, after your context was compacted, say.",
      inputSchema: TasksReadSchema,
      jsonSchema: { type: "object", properties: {} },
      permission: "allow",
      requiresActiveTurn: false,
      onDemand: true,
      promptSnippet: "Read your task list back, after your context was compacted.",
      handler: readHandler,
    },
  ];
}
