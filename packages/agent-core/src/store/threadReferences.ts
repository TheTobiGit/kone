import type { ConversationDb } from "./ConversationDb.js";

export type ThreadReference = {
  ownerThreadId: string;
  targetThreadId: string;
  createdAt: number;
};

export class ThreadReferenceRepo {
  constructor(private readonly dbh: ConversationDb) {}

  list(ownerThreadId: string): string[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the SELECT projects exactly the one string column read below.
      const rows = db.prepare(`SELECT target_thread_id FROM thread_references WHERE owner_thread_id = ? ORDER BY created_at, target_thread_id`)
        .all(ownerThreadId) as Array<{ target_thread_id: string }>;
      return rows.map((row) => row.target_thread_id);
    } catch (err) {
      console.error("[conversation-store] thread reference list failed:", err);
      return [];
    }
  }

  attach(ownerThreadId: string, targetThreadId: string, createdAt = Date.now()): boolean {
    if (ownerThreadId === targetThreadId) return false;
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      // SAFETY: COUNT(*) aliases its single integer result as `count`.
      const endpoints = db.prepare(`SELECT count(*) AS count FROM threads WHERE thread_id IN (?, ?)`).get(ownerThreadId, targetThreadId) as { count: number } | undefined;
      if (endpoints?.count !== 2) return false;
      db.prepare(`INSERT INTO thread_references (owner_thread_id, target_thread_id, created_at) VALUES (?, ?, ?) ON CONFLICT(owner_thread_id, target_thread_id) DO NOTHING`)
        .run(ownerThreadId, targetThreadId, createdAt);
      return true;
    } catch (err) {
      console.error("[conversation-store] thread reference attach failed:", err);
      return false;
    }
  }

  detach(ownerThreadId: string, targetThreadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      db.prepare(`DELETE FROM thread_references WHERE owner_thread_id = ? AND target_thread_id = ?`).run(ownerThreadId, targetThreadId);
      return true;
    } catch (err) {
      console.error("[conversation-store] thread reference detach failed:", err);
      return false;
    }
  }
}
