import type { ConversationDb } from "./ConversationDb.js";
import type { AgentGrant, GrantAccess } from "../agentAccess.js";

// Grants: who may reach an agent beyond its own chain. One row per holder and
// agent — a new grant replaces the old one's level — and a revoke deletes it.
// Rows go with either thread.

type GrantDbRow = {
  grantee_thread_id: string;
  target_thread_id: string;
  access: GrantAccess;
  granted_by_thread_id: string;
  created_at: number;
};

function rowToGrant(row: GrantDbRow): AgentGrant {
  return {
    granteeThreadId: row.grantee_thread_id,
    targetThreadId: row.target_thread_id,
    access: row.access,
    grantedByThreadId: row.granted_by_thread_id,
    createdAt: row.created_at,
  };
}

const GRANT_COLUMNS = `grantee_thread_id, target_thread_id, access, granted_by_thread_id, created_at`;

export class AgentGrantRepo {
  constructor(private readonly dbh: ConversationDb) {}

  /** Give `grantee` this access to `target`, replacing any it held. False
   *  when the store could not write it, or either thread is missing. */
  setAgentGrant(grant: AgentGrant): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      db.prepare(
        `INSERT INTO agent_grants (${GRANT_COLUMNS}) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (grantee_thread_id, target_thread_id)
         DO UPDATE SET access = excluded.access, granted_by_thread_id = excluded.granted_by_thread_id,
                       created_at = excluded.created_at`,
      ).run(grant.granteeThreadId, grant.targetThreadId, grant.access, grant.grantedByThreadId, grant.createdAt);
      return true;
    } catch (err) {
      console.error("[conversation-store] setAgentGrant failed:", err);
      return false;
    }
  }

  /** Take a grant back. False when there was none to take. */
  revokeAgentGrant(granteeThreadId: string, targetThreadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db
        .prepare(`DELETE FROM agent_grants WHERE grantee_thread_id = ? AND target_thread_id = ?`)
        .run(granteeThreadId, targetThreadId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] revokeAgentGrant failed:", err);
      return false;
    }
  }

  /** What `grantee` was granted on `target`, or null for nothing. */
  agentGrant(granteeThreadId: string, targetThreadId: string): AgentGrant | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: the projection is the column list GrantDbRow is declared from.
      const row = db
        .prepare(`SELECT ${GRANT_COLUMNS} FROM agent_grants WHERE grantee_thread_id = ? AND target_thread_id = ?`)
        .get(granteeThreadId, targetThreadId) as GrantDbRow | undefined;
      return row ? rowToGrant(row) : null;
    } catch (err) {
      console.error("[conversation-store] agentGrant failed:", err);
      return null;
    }
  }

  /** Every grant on one agent, oldest first. */
  agentGrantsOn(targetThreadId: string): AgentGrant[] {
    return this.list(`target_thread_id = ?`, targetThreadId);
  }

  /** Every grant one agent holds, oldest first. */
  agentGrantsHeldBy(granteeThreadId: string): AgentGrant[] {
    return this.list(`grantee_thread_id = ?`, granteeThreadId);
  }

  private list(where: string, threadId: string): AgentGrant[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: the projection is the column list GrantDbRow is declared from.
      const rows = db
        .prepare(`SELECT ${GRANT_COLUMNS} FROM agent_grants WHERE ${where} ORDER BY created_at ASC, rowid ASC`)
        .all(threadId) as GrantDbRow[];
      return rows.map(rowToGrant);
    } catch (err) {
      console.error("[conversation-store] agent grants read failed:", err);
      return [];
    }
  }
}
