import { randomUUID } from "node:crypto";
import { z } from "zod";

import {
  BOARD_ACCESS,
  BOARD_ROW_STATES,
  boardAccessCovers,
  type BoardAccess,
  type BoardRow,
  type BoardRule,
  type CrewBoard,
  type CrewBoardStore,
} from "../../crewBoard.js";
import { threadAgentName } from "../../senderHeader.js";
import type { EmitEvent } from "../../types.js";
import { GatewayToolError, type GatewayRecord, type GatewayToolContext, type GatewayToolResult, type ToolEntry } from "../schemas.js";
import { resolveAgentThread, type GrantToolStore } from "./grants.js";
import { isUpChain } from "./irc.js";

// The crew board's tools. The orchestrator makes a board for its crew and
// grants each member what it may do; members read it at the start of work and
// write the rows they own as their work moves. A rule that changes is put in
// front of every member's next turn as a held notice, so nobody is woken for
// it and nobody misses it.

/** What the board tools need of the store. */
export type BoardToolStore = CrewBoardStore & Pick<GrantToolStore, "threadMeta" | "threadLineage" | "listThreads" | "getThreadAgent" | "getAgent">;

/** Where a changed rule is announced: a held notice in a member's inbox. */
export interface BoardNotices {
  sendNotice(input: { to: string; projectPath: string; message: string; rings: boolean }): void;
}

export interface BoardToolInput {
  store: BoardToolStore;
  notices?: BoardNotices;
  emit?: EmitEvent;
}

const BOARD_TITLE_MAX = 120;
const BOARD_TEXT_MAX = 4000;

/** How far `threadId` may act on `board`: its owner is an admin; a member
 *  holds what it was granted; a worker reads what its parent may read. */
export function boardAccessOf(store: BoardToolStore, board: CrewBoard, threadId: string): BoardAccess | null {
  if (board.ownerThreadId === threadId) return "admin";
  const member = store.boardMember(board.boardId, threadId);
  if (member) return member.access;
  const lineage = store.threadLineage(threadId);
  if (lineage?.relationshipToParent === "subagent" && lineage.parentThreadId) {
    return boardAccessOf(store, board, lineage.parentThreadId) ? "read" : null;
  }
  return null;
}

/** The board a call names, or the one board the caller is on. */
function boardFor(store: BoardToolStore, ctx: GatewayToolContext, boardId: string | undefined): CrewBoard {
  if (boardId) {
    const board = store.crewBoard(boardId);
    if (!board || boardAccessOf(store, board, ctx.threadId) === null) {
      throw new GatewayToolError("not_found", `No board "${boardId}" you can read.`);
    }
    return board;
  }
  const readerId = readerOf(store, ctx.threadId);
  const boards = store.crewBoardsFor(readerId, ctx.cwd);
  if (boards.length === 1) return boards[0]!;
  if (boards.length === 0) throw new GatewayToolError("not_found", "You are on no board. The agent that handed you your work can add you.");
  throw new GatewayToolError(
    "invalid_input",
    `You are on ${boards.length} boards: ${boards.map((b) => `"${b.title}" (${b.boardId})`).join(", ")}. Name one with boardId.`,
  );
}

/** A worker reads its parent's boards. */
function readerOf(store: BoardToolStore, threadId: string): string {
  const lineage = store.threadLineage(threadId);
  return lineage?.relationshipToParent === "subagent" && lineage.parentThreadId ? lineage.parentThreadId : threadId;
}

function need(store: BoardToolStore, board: CrewBoard, threadId: string, access: BoardAccess, what: string): BoardAccess {
  const held = boardAccessOf(store, board, threadId);
  if (!boardAccessCovers(held, access)) {
    throw new GatewayToolError(
      "permission_denied",
      `${what} needs ${access} on "${board.title}"; you have ${held ?? "no access"}. Ask ${threadAgentName(store, board.ownerThreadId)}, who owns it.`,
    );
  }
  // SAFETY: boardAccessCovers is false for a null holding.
  return held as BoardAccess;
}

function renderRule(rule: BoardRule, seenRevision: number): string {
  const fresh = rule.changedAtRevision > seenRevision ? " (new since you last read it)" : "";
  return `- [${rule.ruleId} v${rule.version}]${fresh} ${rule.text}`;
}

function renderRow(store: BoardToolStore, row: BoardRow): string {
  const at = row.branch ? ` ${row.branch}${row.commit ? `@${row.commit.slice(0, 7)}` : ""}` : "";
  const next = row.nextStep ? ` → next: ${row.nextStep}` : "";
  return `- [${row.rowId} r${row.revision}] ${row.item} — ${threadAgentName(store, row.ownerThreadId)}${at} — ${row.state}${next}`;
}

/** The board as a member reads it. */
export function renderBoard(store: BoardToolStore, board: CrewBoard, seenRevision: number): string {
  const rules = store.boardRules(board.boardId).filter((r) => !r.retired);
  const rows = store.boardRows(board.boardId);
  const fresh = rules.filter((r) => r.changedAtRevision > seenRevision).length;
  return [
    `Board "${board.title}" (${board.boardId}), revision ${board.revision}, owned by ${threadAgentName(store, board.ownerThreadId)}.`,
    fresh > 0 ? `${fresh} rule${fresh === 1 ? "" : "s"} new or changed since you last read it.` : null,
    "",
    "Brief:",
    board.brief.trim() || "(none yet)",
    "",
    "Standing rules:",
    rules.length > 0 ? rules.map((r) => renderRule(r, seenRevision)).join("\n") : "(none)",
    "",
    "Status:",
    rows.length > 0 ? rows.map((r) => renderRow(store, r)).join("\n") : "(no rows yet)",
  ]
    .filter((line) => line !== null)
    .join("\n");
}

const MemberSpecSchema = z.object({ agent: z.string().trim().min(1).max(200), access: z.enum(BOARD_ACCESS) });

const BoardCreateSchema = z.object({
  title: z.string().trim().min(1).max(BOARD_TITLE_MAX),
  brief: z.string().max(BOARD_TEXT_MAX).optional(),
  members: z.array(MemberSpecSchema).max(24).optional(),
});

const BoardGrantSchema = z
  .object({
    boardId: z.string().trim().min(1),
    agent: z.string().trim().min(1).max(200),
    access: z.enum(BOARD_ACCESS).optional(),
    revoke: z.boolean().optional(),
  })
  .refine((v) => v.revoke === true || v.access !== undefined, {
    message: "Say what access to grant (read, rows or admin), or set revoke to take the member off the board.",
  });

const BoardReadSchema = z.object({ boardId: z.string().trim().min(1).optional() });

const BoardWriteSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("brief"),
    boardId: z.string().trim().min(1),
    text: z.string().max(BOARD_TEXT_MAX),
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("rule"),
    boardId: z.string().trim().min(1),
    ruleId: z.string().trim().min(1).max(40).optional(),
    text: z.string().trim().min(1).max(BOARD_TEXT_MAX),
    retire: z.boolean().optional(),
    expectedRevision: z.number().int().positive(),
  }),
  z.object({
    kind: z.literal("row"),
    boardId: z.string().trim().min(1),
    rowId: z.string().trim().min(1).max(40).optional(),
    item: z.string().trim().min(1).max(BOARD_TITLE_MAX),
    state: z.enum(BOARD_ROW_STATES),
    branch: z.string().trim().min(1).max(200).optional(),
    commit: z.string().trim().min(4).max(64).optional(),
    nextStep: z.string().trim().min(1).max(400).optional(),
    owner: z.string().trim().min(1).max(200).optional(),
    expectedRevision: z.number().int().positive().optional(),
  }),
]);

const ACCESS_DESCRIPTION =
  "read: read the board. rows: also write the status rows it owns. admin: also the brief, the rules, any row, and who is on the board.";

const BOARD_CREATE_JSON_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string", description: "What the crew is doing, in a few words." },
    brief: { type: "string", description: "The plan and scope, in a few lines. Change it later with board_write." },
    members: {
      type: "array",
      description: `Agents to put on the board, by name or thread id as agent_list shows them. ${ACCESS_DESCRIPTION}`,
      items: {
        type: "object",
        properties: { agent: { type: "string" }, access: { type: "string", enum: [...BOARD_ACCESS] } },
        required: ["agent", "access"],
      },
    },
  },
  required: ["title"],
} satisfies GatewayRecord;

const BOARD_GRANT_JSON_SCHEMA = {
  type: "object",
  properties: {
    boardId: { type: "string" },
    agent: { type: "string", description: "The agent, by name or thread id. It must work for the board's owner." },
    access: { type: "string", enum: [...BOARD_ACCESS], description: ACCESS_DESCRIPTION },
    revoke: { type: "boolean", description: "Take the agent off the board." },
  },
  required: ["boardId", "agent"],
} satisfies GatewayRecord;

const BOARD_READ_JSON_SCHEMA = {
  type: "object",
  properties: { boardId: { type: "string", description: "Omit when you are on one board only." } },
} satisfies GatewayRecord;

const BOARD_WRITE_JSON_SCHEMA = {
  type: "object",
  properties: {
    kind: { type: "string", enum: ["brief", "rule", "row"], description: "What you are writing." },
    boardId: { type: "string" },
    text: { type: "string", description: "brief: the new brief. rule: the rule's words." },
    ruleId: { type: "string", description: "rule: the rule to change or retire; omit to add one." },
    retire: { type: "boolean", description: "rule: retire it; it stays on record, off the board." },
    rowId: { type: "string", description: "row: the row to change; omit to add one." },
    item: { type: "string", description: "row: the work item." },
    state: { type: "string", enum: [...BOARD_ROW_STATES], description: "row: where the item stands." },
    branch: { type: "string" },
    commit: { type: "string" },
    nextStep: { type: "string", description: "row: what happens next, and who does it." },
    owner: { type: "string", description: "row, admin only: whose row it is, by name or thread id. Default: you." },
    expectedRevision: {
      type: "integer",
      description:
        "The revision you read: the board's revision for brief and rule, the row's for a row (omit for a new row). A write against a revision that moved is refused with what is there now.",
    },
  },
  required: ["kind", "boardId"],
} satisfies GatewayRecord;

export function createBoardTools(input: BoardToolInput): ToolEntry[] {
  const { store } = input;

  const changed = (ctx: GatewayToolContext, board: CrewBoard, part: "board" | "members" | "rule" | "row") => {
    input.emit?.({
      type: "board.updated",
      threadId: ctx.threadId,
      provider: ctx.provider,
      at: Date.now(),
      source: "kone.store",
      boardId: board.boardId,
      projectPath: board.projectPath,
      part,
    });
  };

  /** A member is anyone working for the board's owner, never a worker. */
  const memberFor = (ctx: GatewayToolContext, board: CrewBoard, nameOrId: string): string => {
    const threadId = resolveAgentThread(store, ctx.cwd, nameOrId);
    if (threadId === board.ownerThreadId) throw new GatewayToolError("invalid_input", "The board's owner is on it already, as its admin.");
    if (!isUpChain(store, board.ownerThreadId, threadId)) {
      throw new GatewayToolError(
        "permission_denied",
        `${threadAgentName(store, threadId)} does not work for ${threadAgentName(store, board.ownerThreadId)}: a board is its owner's crew's alone.`,
      );
    }
    return threadId;
  };

  const createHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = BoardCreateSchema.parse(args);
    const board = store.createCrewBoard({
      boardId: `board_${randomUUID()}`,
      ownerThreadId: ctx.threadId,
      projectPath: ctx.cwd,
      title: parsed.title,
      brief: parsed.brief ?? "",
      createdAt: Date.now(),
    });
    if (!board) throw new GatewayToolError("internal", "kone could not store the board.");
    const added: string[] = [];
    const refused: string[] = [];
    for (const spec of parsed.members ?? []) {
      try {
        const threadId = memberFor(ctx, board, spec.agent);
        if (!store.setBoardMember({ boardId: board.boardId, threadId, access: spec.access, grantedByThreadId: ctx.threadId })) {
          throw new GatewayToolError("internal", "kone could not store the membership.");
        }
        added.push(`${threadAgentName(store, threadId)}: ${spec.access}`);
      } catch (err) {
        refused.push(`${spec.agent}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    changed(ctx, board, "board");
    const text = [
      `Board "${board.title}" is ${board.boardId}, revision 1. You own it.`,
      added.length > 0 ? `On it: ${added.join("; ")}.` : null,
      refused.length > 0 ? `Not added: ${refused.join("; ")}` : null,
      "Write the standing rules with board_write kind rule; members write their rows with kind row.",
    ]
      .filter(Boolean)
      .join(" ");
    return { content: [{ type: "text", text }], structuredContent: { board: { ...board } } };
  };

  const grantHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = BoardGrantSchema.parse(args);
    const board = boardFor(store, ctx, parsed.boardId);
    need(store, board, ctx.threadId, "admin", "Changing who is on the board");
    const threadId = memberFor(ctx, board, parsed.agent);
    const name = threadAgentName(store, threadId);
    if (parsed.revoke === true) {
      const removed = store.removeBoardMember(board.boardId, threadId);
      if (removed) changed(ctx, board, "members");
      const text = removed ? `${name} is off "${board.title}".` : `${name} was not on "${board.title}".`;
      return { content: [{ type: "text", text }], structuredContent: { removed, threadId } };
    }
    // SAFETY: the schema's refine guarantees access when revoke is not set.
    const access = parsed.access as BoardAccess;
    if (!store.setBoardMember({ boardId: board.boardId, threadId, access, grantedByThreadId: ctx.threadId })) {
      throw new GatewayToolError("internal", "kone could not store the membership.");
    }
    changed(ctx, board, "members");
    return {
      content: [{ type: "text", text: `${name} now has ${access} on "${board.title}".` }],
      structuredContent: { member: { boardId: board.boardId, threadId, access } },
    };
  };

  const readHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = BoardReadSchema.parse(args);
    const board = boardFor(store, ctx, parsed.boardId);
    const seen = store.boardMember(board.boardId, ctx.threadId)?.rulesSeenRevision ?? (board.ownerThreadId === ctx.threadId ? board.revision : 0);
    const text = renderBoard(store, board, seen);
    store.markBoardRulesSeen(board.boardId, ctx.threadId, board.revision);
    return {
      content: [{ type: "text", text }],
      structuredContent: {
        board: { ...board },
        access: boardAccessOf(store, board, ctx.threadId),
        rules: store.boardRules(board.boardId).filter((r) => !r.retired).map((r) => ({ ...r })),
        rows: store.boardRows(board.boardId).map((r) => ({ ...r })),
      },
    };
  };

  /** Tell every member but the writer, before its next turn, that a rule
   *  changed. Held: nobody is woken for it. */
  const announceRule = (ctx: GatewayToolContext, board: CrewBoard, rule: BoardRule) => {
    if (!input.notices) return;
    const readers = [board.ownerThreadId, ...store.boardMembers(board.boardId).map((m) => m.threadId)].filter(
      (id) => id !== ctx.threadId,
    );
    const what = rule.retired ? `retired rule ${rule.ruleId}` : rule.version === 1 ? `added rule ${rule.ruleId}` : `changed rule ${rule.ruleId} (v${rule.version})`;
    const message = `${threadAgentName(store, ctx.threadId)} ${what} on the board "${board.title}"${rule.retired ? "" : `: ${rule.text}`}. Read the board with board_read before acting on anything it covers.`;
    for (const to of readers) {
      try {
        input.notices.sendNotice({ to, projectPath: board.projectPath, message, rings: false });
      } catch (err) {
        console.warn(`[board] could not tell ${to} of a rule change:`, err);
      }
    }
  };

  const writeHandler = async (ctx: GatewayToolContext, args: GatewayRecord): Promise<GatewayToolResult> => {
    const parsed = BoardWriteSchema.parse(args);
    const board = boardFor(store, ctx, parsed.boardId);
    const stale = (what: string, revision: number, current: string) =>
      new GatewayToolError(
        "revision_conflict",
        `${what} moved since you read it: it is at revision ${revision} now. Read it again and write against that.\n${current}`,
      );

    if (parsed.kind === "brief") {
      need(store, board, ctx.threadId, "admin", "Writing the brief");
      const result = store.writeBoardBrief(board.boardId, parsed.text, parsed.expectedRevision);
      if (!result.ok) {
        if (result.reason === "stale") throw stale("The board", result.current.revision, renderBoard(store, result.current, 0));
        throw new GatewayToolError("internal", "kone could not write the brief.");
      }
      changed(ctx, result.value, "board");
      return {
        content: [{ type: "text", text: `Brief written; the board is at revision ${result.value.revision}.` }],
        structuredContent: { board: { ...result.value } },
      };
    }

    if (parsed.kind === "rule") {
      need(store, board, ctx.threadId, "admin", "Writing a rule");
      const ruleId = parsed.ruleId ?? `r${store.boardRules(board.boardId).length + 1}`;
      const result = store.writeBoardRule(
        { boardId: board.boardId, ruleId, text: parsed.text, retired: parsed.retire === true },
        parsed.expectedRevision,
      );
      if (!result.ok) {
        if (result.reason === "stale" || result.reason === "missing") {
          const now = store.crewBoard(board.boardId) ?? board;
          throw stale("The board", now.revision, renderBoard(store, now, 0));
        }
        throw new GatewayToolError("internal", "kone could not write the rule.");
      }
      announceRule(ctx, board, result.value);
      changed(ctx, board, "rule");
      return {
        content: [
          {
            type: "text",
            text: `Rule ${result.value.ruleId} is at v${result.value.version}${result.value.retired ? ", retired" : ""}; the board is at revision ${result.value.changedAtRevision}. Every other member hears of it before its next turn.`,
          },
        ],
        structuredContent: { rule: { ...result.value } },
      };
    }

    // A row: its owner writes it, or an admin.
    const access = need(store, board, ctx.threadId, "rows", "Writing a status row");
    const existing = parsed.rowId ? store.boardRows(board.boardId).find((r) => r.rowId === parsed.rowId) : undefined;
    if (existing && existing.ownerThreadId !== ctx.threadId && access !== "admin") {
      throw new GatewayToolError(
        "permission_denied",
        `Row ${existing.rowId} is ${threadAgentName(store, existing.ownerThreadId)}'s; only its owner or an admin writes it.`,
      );
    }
    if (parsed.owner && access !== "admin") {
      throw new GatewayToolError("permission_denied", "Only an admin sets whose row it is; leave owner out to own it yourself.");
    }
    const ownerThreadId = parsed.owner ? resolveAgentThread(store, ctx.cwd, parsed.owner) : (existing?.ownerThreadId ?? ctx.threadId);
    const result = store.writeBoardRow(
      {
        boardId: board.boardId,
        rowId: parsed.rowId ?? `w${store.boardRows(board.boardId).length + 1}`,
        item: parsed.item,
        ownerThreadId,
        branch: parsed.branch ?? null,
        commit: parsed.commit ?? null,
        state: parsed.state,
        nextStep: parsed.nextStep ?? null,
        updatedByThreadId: ctx.threadId,
      },
      existing ? (parsed.expectedRevision ?? -1) : null,
    );
    if (!result.ok) {
      if (result.reason === "stale") throw stale(`Row ${result.current.rowId}`, result.current.revision, renderRow(store, result.current));
      if (result.reason === "missing") throw new GatewayToolError("not_found", `No row "${parsed.rowId}" on "${board.title}".`);
      throw new GatewayToolError("internal", "kone could not write the row.");
    }
    changed(ctx, board, "row");
    return {
      content: [{ type: "text", text: `Row ${result.value.rowId} is at revision ${result.value.revision}: ${renderRow(store, result.value).slice(2)}` }],
      structuredContent: { row: { ...result.value } },
    };
  };

  return [
    {
      name: "board_create",
      description: `Make a board for the crew you are coordinating: a brief, standing rules every member must follow, and one status row per work item. You own it. Put agents working for you on it with members, or later with board_grant. ${ACCESS_DESCRIPTION} It holds state, not conversation: questions and anything needing a reply still go through agent_message.`,
      inputSchema: BoardCreateSchema,
      jsonSchema: BOARD_CREATE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      onDemand: true,
      promptSnippet: "Make a board for your crew: a brief, standing rules and status rows, shared with the agents you name.",
      handler: createHandler,
    },
    {
      name: "board_grant",
      description: `Put an agent working for the board's owner on a board, change what it may do, or take it off (revoke). Owner and admins only. ${ACCESS_DESCRIPTION} A worker reads the boards its parent may read without being added.`,
      inputSchema: BoardGrantSchema,
      jsonSchema: BOARD_GRANT_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      onDemand: true,
      promptSnippet: "Add an agent to your crew's board, change its access, or take it off.",
      handler: grantHandler,
    },
    {
      name: "board_read",
      description:
        "Read your crew's board: the brief, the standing rules (marked when new since you last read it), and the status rows with each item's owner, branch, state and next step. Read it when you start work and when kone tells you a rule changed; it never wakes anyone.",
      inputSchema: BoardReadSchema,
      jsonSchema: BOARD_READ_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: false,
      onDemand: true,
      promptSnippet: "Read your crew's board: its brief, standing rules and status rows.",
      handler: readHandler,
    },
    {
      name: "board_write",
      description:
        "Write to your crew's board, naming the revision you read (expectedRevision) so nobody's write is lost. kind row: the status of a work item you own — item, state (building, gated, in-review, changes-needed, approved, merged, blocked), branch, commit, next step; omit rowId to add one. kind rule (admin): add, change or retire a standing rule; every other member hears of it before its next turn. kind brief (admin): the plan and scope. Writing a row wakes nobody.",
      inputSchema: BoardWriteSchema,
      jsonSchema: BOARD_WRITE_JSON_SCHEMA,
      permission: "allow",
      requiresActiveTurn: true,
      agentsOnly: true,
      onDemand: true,
      promptSnippet: "Write your status row, or (as an admin) a standing rule or the brief, on your crew's board.",
      handler: writeHandler,
    },
  ];
}
