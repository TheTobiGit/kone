// The crew board: a shared, structured workspace one orchestrator's crew
// reads and writes. It is to agents what the scratchpad is to the user — but
// never the user's scratchpad, and never free text: standing rules, versioned,
// and status rows, each owned. State lives here; the conversation stays in the
// inbox.
//
// Access is granted by the board's owner (the orchestrator) or its admins:
// `read`; `rows`, to write the rows one owns; `admin`, for the brief, the
// rules and any row. A worker reads the board its parent may read. Every write
// names the revision it read, so two writers never silently overwrite each
// other.

export const BOARD_ACCESS = ["read", "rows", "admin"] as const;
export type BoardAccess = (typeof BOARD_ACCESS)[number];

/** Where one work item stands. */
export const BOARD_ROW_STATES = [
  "building",
  "gated",
  "in-review",
  "changes-needed",
  "approved",
  "merged",
  "blocked",
] as const;
export type BoardRowState = (typeof BOARD_ROW_STATES)[number];

export interface CrewBoard {
  boardId: string;
  /** The orchestrator whose crew this is. Always an admin. */
  ownerThreadId: string;
  projectPath: string;
  title: string;
  /** The plan and scope, in a few lines. */
  brief: string;
  /** Bumped by every change to the brief or the rules. */
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface BoardMember {
  boardId: string;
  threadId: string;
  access: BoardAccess;
  grantedByThreadId: string;
  /** The board revision whose rules this member was last told of. */
  rulesSeenRevision: number;
}

export interface BoardRule {
  boardId: string;
  ruleId: string;
  text: string;
  /** 1 when written, +1 each time it changes. */
  version: number;
  /** The board revision that last changed it. */
  changedAtRevision: number;
  retired: boolean;
  updatedAt: number;
}

export interface BoardRow {
  boardId: string;
  rowId: string;
  item: string;
  ownerThreadId: string;
  branch: string | null;
  commit: string | null;
  state: BoardRowState;
  nextStep: string | null;
  /** 1 when written, +1 on each write: what a write names to land. */
  revision: number;
  updatedAt: number;
  updatedByThreadId: string;
}

/** What a revision-checked write came to. */
export type BoardWrite<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "stale"; current: T }
  | { ok: false; reason: "missing" | "failed" };

/** The board store, as the tools use it. */
export interface CrewBoardStore {
  createCrewBoard(board: Omit<CrewBoard, "revision" | "updatedAt">): CrewBoard | null;
  crewBoard(boardId: string): CrewBoard | null;
  /** Boards a thread owns or is a member of, in a project, newest first. */
  crewBoardsFor(threadId: string, projectPath: string): CrewBoard[];
  /** Every board in a project, newest first: the user's view. */
  crewBoardsInProject(projectPath: string): CrewBoard[];
  setBoardMember(member: Omit<BoardMember, "rulesSeenRevision">): boolean;
  removeBoardMember(boardId: string, threadId: string): boolean;
  boardMember(boardId: string, threadId: string): BoardMember | null;
  boardMembers(boardId: string): BoardMember[];
  markBoardRulesSeen(boardId: string, threadId: string, revision: number): void;
  /** Change the brief, if the board is still at `expectedRevision`. */
  writeBoardBrief(boardId: string, brief: string, expectedRevision: number): BoardWrite<CrewBoard>;
  /** Add, change or retire a rule, if the board is still at `expectedRevision`. */
  writeBoardRule(
    input: { boardId: string; ruleId: string; text: string; retired?: boolean },
    expectedRevision: number,
  ): BoardWrite<BoardRule>;
  boardRules(boardId: string): BoardRule[];
  /** Write a row. A new row (no `expectedRevision`) must not exist; an
   *  existing one must still be at `expectedRevision`. */
  writeBoardRow(
    row: Omit<BoardRow, "revision" | "updatedAt">,
    expectedRevision: number | null,
  ): BoardWrite<BoardRow>;
  boardRows(boardId: string): BoardRow[];
}

/** Whether holding `held` covers `need`. */
export function boardAccessCovers(held: BoardAccess | null, need: BoardAccess): boolean {
  if (!held) return false;
  return BOARD_ACCESS.indexOf(held) >= BOARD_ACCESS.indexOf(need);
}
