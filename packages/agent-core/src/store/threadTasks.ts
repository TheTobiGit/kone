import type { KoneTask, KoneTaskList } from "@kone/protocol/kone-tasks";

import type { ConversationDb } from "./ConversationDb.js";

// A thread's kone task list on disk: one row per thread, the list held whole
// as JSON. The list is small and always read and written whole, so a row per
// task would buy nothing but joins. `next_id` is the counter task ids are
// minted from, kept apart from the list so an id a write dropped is never
// handed to a different task later.

type ThreadTasksDbRow = {
  thread_id: string;
  tasks_json: string;
  next_id: number;
  revision: number;
  updated_at: number;
};

/** The list and the id counter a write starts from. */
export interface ThreadTasksDraft {
  tasks: KoneTask[];
  nextId: number;
}

function decodeTasks(json: string): KoneTask[] {
  try {
    const parsed: unknown = JSON.parse(json);
    // SAFETY: tasks_json is only ever written by writeThreadTasks below, from
    // a KoneTask[] the gateway has already validated.
    return Array.isArray(parsed) ? (parsed as KoneTask[]) : [];
  } catch {
    return [];
  }
}

export class ThreadTaskRepo {
  constructor(private readonly dbh: ConversationDb) {}

  private row(threadId: string): ThreadTasksDbRow | null {
    const db = this.dbh.handle();
    if (!db) return null;
    // SAFETY: `SELECT *` of thread_tasks is exactly ThreadTasksDbRow.
    const row = db.prepare(`SELECT * FROM thread_tasks WHERE thread_id = ?`).get(threadId) as
      | ThreadTasksDbRow
      | undefined;
    return row ?? null;
  }

  /** The thread's list, or null when it has never written one. */
  threadTaskList(threadId: string): KoneTaskList | null {
    try {
      const row = this.row(threadId);
      if (!row) return null;
      return { threadId, tasks: decodeTasks(row.tasks_json), revision: row.revision, updatedAt: row.updated_at };
    } catch (err) {
      console.error("[conversation-store] threadTaskList failed:", err);
      return null;
    }
  }

  /** Read the list, let `change` work out the next one, and write it, in one
   *  transaction: two writes to the same thread can never interleave. An
   *  error `change` throws rolls the write back and reaches the caller as is;
   *  null means the store itself could not be reached. */
  writeThreadTasks(threadId: string, change: (current: ThreadTasksDraft) => ThreadTasksDraft): KoneTaskList | null {
    const db = this.dbh.handle();
    if (!db) return null;
    db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.row(threadId);
      const next = change({ tasks: row ? decodeTasks(row.tasks_json) : [], nextId: row?.next_id ?? 1 });
      const revision = (row?.revision ?? 0) + 1;
      const now = Date.now();
      db.prepare(
        `INSERT INTO thread_tasks (thread_id, tasks_json, next_id, revision, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET
           tasks_json = excluded.tasks_json,
           next_id = excluded.next_id,
           revision = excluded.revision,
           updated_at = excluded.updated_at`,
      ).run(threadId, JSON.stringify(next.tasks), next.nextId, revision, now);
      db.exec("COMMIT");
      return { threadId, tasks: next.tasks, revision, updatedAt: now };
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
}
