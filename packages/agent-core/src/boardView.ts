import type { BoardMember, BoardRow, BoardRule, CrewBoard, CrewBoardStore } from "./crewBoard.js";
import { threadAgentName, type SenderIdentitySource } from "./senderHeader.js";

// The crew boards as the app shows them: every board in a project, with who is
// on it, its live rules and its rows, each thread named as its agent is.

export interface BoardView {
  board: CrewBoard;
  ownerName: string;
  members: Array<BoardMember & { name: string }>;
  /** Live rules only; a retired rule stays on record, off the board. */
  rules: BoardRule[];
  rows: Array<BoardRow & { ownerName: string }>;
}

export function boardsView(store: CrewBoardStore & SenderIdentitySource, projectPath: string): BoardView[] {
  return store.crewBoardsInProject(projectPath).map((board) => ({
    board,
    ownerName: threadAgentName(store, board.ownerThreadId),
    members: store.boardMembers(board.boardId).map((m) => ({ ...m, name: threadAgentName(store, m.threadId) })),
    rules: store.boardRules(board.boardId).filter((r) => !r.retired),
    rows: store.boardRows(board.boardId).map((r) => ({ ...r, ownerName: threadAgentName(store, r.ownerThreadId) })),
  }));
}
