import type { ConversationDb } from "./ConversationDb.js";
import type { DatabaseSync } from "../sqlite.js";
import type {
  BoardAccess,
  BoardMember,
  BoardRow,
  BoardRowState,
  BoardRule,
  BoardWrite,
  CrewBoard,
  CrewBoardStore,
} from "../crewBoard.js";

// Crew boards on disk. Each revision-checked write reads and writes in one
// transaction, so a check and the write it guards can never be split by
// another writer.

type BoardDbRow = {
  board_id: string;
  owner_thread_id: string;
  project_path: string;
  title: string;
  brief: string;
  revision: number;
  created_at: number;
  updated_at: number;
};

type MemberDbRow = {
  board_id: string;
  thread_id: string;
  access: BoardAccess;
  granted_by_thread_id: string;
  rules_seen_revision: number;
};

type RuleDbRow = {
  board_id: string;
  rule_id: string;
  text: string;
  version: number;
  changed_at_revision: number;
  retired: number;
  updated_at: number;
};

type RowDbRow = {
  board_id: string;
  row_id: string;
  item: string;
  owner_thread_id: string;
  branch: string | null;
  commit_sha: string | null;
  state: BoardRowState;
  next_step: string | null;
  revision: number;
  updated_at: number;
  updated_by_thread_id: string;
};

function toBoard(row: BoardDbRow): CrewBoard {
  return {
    boardId: row.board_id,
    ownerThreadId: row.owner_thread_id,
    projectPath: row.project_path,
    title: row.title,
    brief: row.brief,
    revision: row.revision,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function toMember(row: MemberDbRow): BoardMember {
  return {
    boardId: row.board_id,
    threadId: row.thread_id,
    access: row.access,
    grantedByThreadId: row.granted_by_thread_id,
    rulesSeenRevision: row.rules_seen_revision,
  };
}

function toRule(row: RuleDbRow): BoardRule {
  return {
    boardId: row.board_id,
    ruleId: row.rule_id,
    text: row.text,
    version: row.version,
    changedAtRevision: row.changed_at_revision,
    retired: row.retired !== 0,
    updatedAt: row.updated_at,
  };
}

function toRow(row: RowDbRow): BoardRow {
  return {
    boardId: row.board_id,
    rowId: row.row_id,
    item: row.item,
    ownerThreadId: row.owner_thread_id,
    branch: row.branch,
    commit: row.commit_sha,
    state: row.state,
    nextStep: row.next_step,
    revision: row.revision,
    updatedAt: row.updated_at,
    updatedByThreadId: row.updated_by_thread_id,
  };
}

/** Run `write` in one immediate transaction; whatever it returns, or null when
 *  it threw (rolled back). */
function inTransaction<T>(db: DatabaseSync, label: string, write: () => T): T | null {
  try {
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = write();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  } catch (err) {
    console.error(`[conversation-store] ${label} failed:`, err);
    return null;
  }
}

export class CrewBoardRepo implements CrewBoardStore {
  constructor(private readonly dbh: ConversationDb) {}

  createCrewBoard(board: Omit<CrewBoard, "revision" | "updatedAt">): CrewBoard | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      db.prepare(
        `INSERT INTO crew_boards (board_id, owner_thread_id, project_path, title, brief, revision, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, ?, ?)`,
      ).run(board.boardId, board.ownerThreadId, board.projectPath, board.title, board.brief, board.createdAt, board.createdAt);
      return { ...board, revision: 1, updatedAt: board.createdAt };
    } catch (err) {
      console.error("[conversation-store] createCrewBoard failed:", err);
      return null;
    }
  }

  crewBoard(boardId: string): CrewBoard | null {
    const db = this.dbh.handle();
    if (!db) return null;
    return this.readBoard(db, boardId);
  }

  crewBoardsFor(threadId: string, projectPath: string): CrewBoard[] {
    return this.boards(
      `project_path = ? AND (owner_thread_id = ? OR board_id IN (SELECT board_id FROM crew_board_members WHERE thread_id = ?))`,
      [projectPath, threadId, threadId],
    );
  }

  crewBoardsInProject(projectPath: string): CrewBoard[] {
    return this.boards(`project_path = ?`, [projectPath]);
  }

  setBoardMember(member: Omit<BoardMember, "rulesSeenRevision">): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      db.prepare(
        `INSERT INTO crew_board_members (board_id, thread_id, access, granted_by_thread_id)
         VALUES (?, ?, ?, ?)
         ON CONFLICT (board_id, thread_id)
         DO UPDATE SET access = excluded.access, granted_by_thread_id = excluded.granted_by_thread_id`,
      ).run(member.boardId, member.threadId, member.access, member.grantedByThreadId);
      return true;
    } catch (err) {
      console.error("[conversation-store] setBoardMember failed:", err);
      return false;
    }
  }

  removeBoardMember(boardId: string, threadId: string): boolean {
    const db = this.dbh.handle();
    if (!db) return false;
    try {
      const result = db.prepare(`DELETE FROM crew_board_members WHERE board_id = ? AND thread_id = ?`).run(boardId, threadId);
      return Number(result.changes) > 0;
    } catch (err) {
      console.error("[conversation-store] removeBoardMember failed:", err);
      return false;
    }
  }

  boardMember(boardId: string, threadId: string): BoardMember | null {
    const db = this.dbh.handle();
    if (!db) return null;
    try {
      // SAFETY: `SELECT *` of crew_board_members is exactly MemberDbRow.
      const row = db.prepare(`SELECT * FROM crew_board_members WHERE board_id = ? AND thread_id = ?`).get(boardId, threadId) as
        | MemberDbRow
        | undefined;
      return row ? toMember(row) : null;
    } catch (err) {
      console.error("[conversation-store] boardMember failed:", err);
      return null;
    }
  }

  boardMembers(boardId: string): BoardMember[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of crew_board_members is exactly MemberDbRow.
      const rows = db.prepare(`SELECT * FROM crew_board_members WHERE board_id = ? ORDER BY rowid ASC`).all(boardId) as MemberDbRow[];
      return rows.map(toMember);
    } catch (err) {
      console.error("[conversation-store] boardMembers failed:", err);
      return [];
    }
  }

  markBoardRulesSeen(boardId: string, threadId: string, revision: number): void {
    const db = this.dbh.handle();
    if (!db) return;
    try {
      db.prepare(
        `UPDATE crew_board_members SET rules_seen_revision = MAX(rules_seen_revision, ?) WHERE board_id = ? AND thread_id = ?`,
      ).run(revision, boardId, threadId);
    } catch (err) {
      console.error("[conversation-store] markBoardRulesSeen failed:", err);
    }
  }

  writeBoardBrief(boardId: string, brief: string, expectedRevision: number): BoardWrite<CrewBoard> {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "failed" };
    const now = Date.now();
    const result = inTransaction(db, "writeBoardBrief", (): BoardWrite<CrewBoard> => {
      const board = this.readBoard(db, boardId);
      if (!board) return { ok: false, reason: "missing" };
      if (board.revision !== expectedRevision) return { ok: false, reason: "stale", current: board };
      db.prepare(`UPDATE crew_boards SET brief = ?, revision = revision + 1, updated_at = ? WHERE board_id = ?`).run(brief, now, boardId);
      return { ok: true, value: { ...board, brief, revision: board.revision + 1, updatedAt: now } };
    });
    return result ?? { ok: false, reason: "failed" };
  }

  writeBoardRule(
    input: { boardId: string; ruleId: string; text: string; retired?: boolean },
    expectedRevision: number,
  ): BoardWrite<BoardRule> {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "failed" };
    const now = Date.now();
    const result = inTransaction(db, "writeBoardRule", (): BoardWrite<BoardRule> => {
      const board = this.readBoard(db, input.boardId);
      if (!board) return { ok: false, reason: "missing" };
      const existing = this.readRule(db, input.boardId, input.ruleId);
      if (board.revision !== expectedRevision) {
        // The rule as it stands is what the writer has to reconcile with.
        return existing ? { ok: false, reason: "stale", current: existing } : { ok: false, reason: "missing" };
      }
      const revision = board.revision + 1;
      db.prepare(`UPDATE crew_boards SET revision = ?, updated_at = ? WHERE board_id = ?`).run(revision, now, input.boardId);
      const rule: BoardRule = {
        boardId: input.boardId,
        ruleId: input.ruleId,
        text: input.text,
        version: (existing?.version ?? 0) + 1,
        changedAtRevision: revision,
        retired: input.retired === true,
        updatedAt: now,
      };
      db.prepare(
        `INSERT INTO crew_board_rules (board_id, rule_id, text, version, changed_at_revision, retired, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (board_id, rule_id) DO UPDATE SET text = excluded.text, version = excluded.version,
           changed_at_revision = excluded.changed_at_revision, retired = excluded.retired, updated_at = excluded.updated_at`,
      ).run(rule.boardId, rule.ruleId, rule.text, rule.version, rule.changedAtRevision, rule.retired ? 1 : 0, rule.updatedAt);
      return { ok: true, value: rule };
    });
    return result ?? { ok: false, reason: "failed" };
  }

  boardRules(boardId: string): BoardRule[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of crew_board_rules is exactly RuleDbRow.
      const rows = db.prepare(`SELECT * FROM crew_board_rules WHERE board_id = ? ORDER BY rowid ASC`).all(boardId) as RuleDbRow[];
      return rows.map(toRule);
    } catch (err) {
      console.error("[conversation-store] boardRules failed:", err);
      return [];
    }
  }

  writeBoardRow(row: Omit<BoardRow, "revision" | "updatedAt">, expectedRevision: number | null): BoardWrite<BoardRow> {
    const db = this.dbh.handle();
    if (!db) return { ok: false, reason: "failed" };
    const now = Date.now();
    const result = inTransaction(db, "writeBoardRow", (): BoardWrite<BoardRow> => {
      if (!this.readBoard(db, row.boardId)) return { ok: false, reason: "missing" };
      // SAFETY: `SELECT *` of crew_board_rows is exactly RowDbRow.
      const existing = db.prepare(`SELECT * FROM crew_board_rows WHERE board_id = ? AND row_id = ?`).get(row.boardId, row.rowId) as
        | RowDbRow
        | undefined;
      if (existing && existing.revision !== expectedRevision) return { ok: false, reason: "stale", current: toRow(existing) };
      if (!existing && expectedRevision !== null) return { ok: false, reason: "missing" };
      const written: BoardRow = { ...row, revision: (existing?.revision ?? 0) + 1, updatedAt: now };
      db.prepare(
        `INSERT INTO crew_board_rows (board_id, row_id, item, owner_thread_id, branch, commit_sha, state, next_step,
                                      revision, updated_at, updated_by_thread_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (board_id, row_id) DO UPDATE SET item = excluded.item, owner_thread_id = excluded.owner_thread_id,
           branch = excluded.branch, commit_sha = excluded.commit_sha, state = excluded.state, next_step = excluded.next_step,
           revision = excluded.revision, updated_at = excluded.updated_at, updated_by_thread_id = excluded.updated_by_thread_id`,
      ).run(
        written.boardId,
        written.rowId,
        written.item,
        written.ownerThreadId,
        written.branch,
        written.commit,
        written.state,
        written.nextStep,
        written.revision,
        written.updatedAt,
        written.updatedByThreadId,
      );
      return { ok: true, value: written };
    });
    return result ?? { ok: false, reason: "failed" };
  }

  boardRows(boardId: string): BoardRow[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of crew_board_rows is exactly RowDbRow.
      const rows = db.prepare(`SELECT * FROM crew_board_rows WHERE board_id = ? ORDER BY rowid ASC`).all(boardId) as RowDbRow[];
      return rows.map(toRow);
    } catch (err) {
      console.error("[conversation-store] boardRows failed:", err);
      return [];
    }
  }

  private readBoard(db: DatabaseSync, boardId: string): CrewBoard | null {
    try {
      // SAFETY: `SELECT *` of crew_boards is exactly BoardDbRow.
      const row = db.prepare(`SELECT * FROM crew_boards WHERE board_id = ?`).get(boardId) as BoardDbRow | undefined;
      return row ? toBoard(row) : null;
    } catch (err) {
      console.error("[conversation-store] crewBoard failed:", err);
      return null;
    }
  }

  private readRule(db: DatabaseSync, boardId: string, ruleId: string): BoardRule | null {
    // SAFETY: `SELECT *` of crew_board_rules is exactly RuleDbRow.
    const row = db.prepare(`SELECT * FROM crew_board_rules WHERE board_id = ? AND rule_id = ?`).get(boardId, ruleId) as
      | RuleDbRow
      | undefined;
    return row ? toRule(row) : null;
  }

  private boards(where: string, params: string[]): CrewBoard[] {
    const db = this.dbh.handle();
    if (!db) return [];
    try {
      // SAFETY: `SELECT *` of crew_boards is exactly BoardDbRow.
      const rows = db.prepare(`SELECT * FROM crew_boards WHERE ${where} ORDER BY created_at DESC, rowid DESC`).all(...params) as BoardDbRow[];
      return rows.map(toBoard);
    } catch (err) {
      console.error("[conversation-store] crew boards read failed:", err);
      return [];
    }
  }
}
