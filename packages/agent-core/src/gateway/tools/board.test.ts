import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "../../userDataDir.js";
import type { RuntimeEvent } from "../../types.js";
import { createRegistry } from "../registry.js";
import type { GatewayRecord, GatewayToolContext } from "../schemas.js";
import { boardsView } from "../../boardView.js";
import { createBoardTools } from "./board.js";

// The crew board on a real store, for the crew it was built for:
//
//   chalk ─┬─ iris   (the lead, contracted)
//          ├─ rowan  (the reviewer, contracted)
//          └─ dara   (an implementer, contracted) ─── lint (dara's worker)
//   peer            (an agent on the project outside the crew)

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly ? new Database(filePath, { readonly: true }) : new Database(filePath);
  }
  prepare(sql: string) {
    return this.db.prepare(sql);
  }
  exec(sql: string) {
    this.db.exec(sql);
  }
  close() {
    this.db.close();
  }
}

mock.module("../../sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

type Store = import("../../ConversationStore.js").ConversationStore;
let ConversationStoreCtor: typeof import("../../ConversationStore.js").ConversationStore;

beforeAll(async () => {
  ConversationStoreCtor = (await import("../../ConversationStore.js")).ConversationStore;
});

const PROJECT = "/repo";
const terms = (name: string) => ({ name, role: "r", instructions: "i", scope: "s", deliverable: "d", doneCriteria: "c" });

let store: Store;
let notices: Array<{ to: string; message: string; rings: boolean }>;
let events: RuntimeEvent[];
let registry: ReturnType<typeof createRegistry>;

beforeEach(() => {
  const dir = mkdtempSync(path.join(tmpdir(), "kone-board-test-"));
  setUserDataDir(dir);
  store = new ConversationStoreCtor(dir);
  store.ensureThread({ threadId: "chalk", projectPath: PROJECT, provider: "codex" });
  store.ensureThread({ threadId: "peer", projectPath: PROJECT, provider: "codex" });
  for (const name of ["iris", "rowan", "dara"]) {
    store.writeSpawnedThread({
      threadId: name,
      projectPath: PROJECT,
      provider: "codex",
      createdAt: 1,
      title: name,
      lineage: { parentThreadId: "chalk", relationshipToParent: "delegation", rootThreadId: "chalk" },
      contract: terms(name[0]!.toUpperCase() + name.slice(1)),
    });
  }
  store.writeSpawnedThread({
    threadId: "lint",
    projectPath: PROJECT,
    provider: "codex",
    createdAt: 1,
    title: "lint",
    lineage: { parentThreadId: "dara", relationshipToParent: "subagent", rootThreadId: "chalk" },
  });
  // Every thread the roster lists has spoken: a spawned one has its brief.
  for (const threadId of ["chalk", "peer", "iris", "rowan", "dara", "lint"]) {
    store.recordUserBlock({ threadId, text: "brief" });
  }
  notices = [];
  events = [];
  registry = createRegistry(
    createBoardTools({
      store,
      notices: { sendNotice: (n) => void notices.push(n) },
      emit: (event) => events.push(event),
    }),
  );
});

const ctxFor = (threadId: string): GatewayToolContext => ({ threadId, turnId: "turn-1", provider: "codex", cwd: PROJECT, requestId: 1 });
const call = (from: string, tool: string, args: GatewayRecord) => registry.call(ctxFor(from), tool, args);
const textOf = (result: Awaited<ReturnType<typeof call>>) => result.content.map((c) => ("text" in c ? c.text : "")).join("\n");

async function makeBoard(): Promise<string> {
  const made = await call("chalk", "board_create", {
    title: "t3code parity",
    brief: "Nine phases.",
    members: [
      { agent: "Iris", access: "admin" },
      { agent: "Rowan", access: "rows" },
      { agent: "Dara", access: "rows" },
      { agent: "peer", access: "read" },
    ],
  });
  expect(textOf(made)).toContain("Not added: peer");
  // SAFETY: board_create's structured result always carries the board.
  return (made.structuredContent as { board: { boardId: string } }).board.boardId;
}

describe("the crew board", () => {
  test("the orchestrator makes it for its crew only, and members read it", async () => {
    const boardId = await makeBoard();
    expect(store.boardMembers(boardId).map((m) => [m.threadId, m.access])).toEqual([
      ["iris", "admin"],
      ["rowan", "rows"],
      ["dara", "rows"],
    ]);
    const read = await call("rowan", "board_read", {});
    expect(textOf(read)).toContain('Board "t3code parity"');
    expect(textOf(read)).toContain("Nine phases.");
    expect(textOf(await call("peer", "board_read", { boardId }))).toContain("No board");
    // A worker reads its parent's board without being added.
    expect(textOf(await call("lint", "board_read", {}))).toContain("Nine phases.");
  });

  test("a rule is admin's, versioned, revision-checked, and every other member hears of it before its next turn", async () => {
    const boardId = await makeBoard();
    expect(textOf(await call("rowan", "board_write", { kind: "rule", boardId, text: "Use the gate lock.", expectedRevision: 1 }))).toContain(
      "needs admin",
    );
    const added = await call("iris", "board_write", { kind: "rule", boardId, text: "Use the gate lock.", expectedRevision: 1 });
    expect(added.structuredContent).toMatchObject({ rule: { ruleId: "r1", version: 1, changedAtRevision: 2 } });
    expect(notices.map((n) => [n.to, n.rings])).toEqual([
      ["chalk", false],
      ["rowan", false],
      ["dara", false],
    ]);
    expect(notices[0]?.message).toContain('added rule r1 on the board "t3code parity": Use the gate lock.');

    // A write against the revision it read before is refused with what is there.
    const stale = await call("chalk", "board_write", { kind: "rule", boardId, ruleId: "r1", text: "Never rebase.", expectedRevision: 1 });
    expect(stale.structuredContent).toMatchObject({ error: { code: "revision_conflict" } });
    expect(textOf(stale)).toContain("revision 2 now");

    const changed = await call("chalk", "board_write", { kind: "rule", boardId, ruleId: "r1", text: "Use the gate lock, always.", expectedRevision: 2 });
    expect(changed.structuredContent).toMatchObject({ rule: { version: 2 } });

    // A member that has not read since is told what is new; reading clears it.
    expect(textOf(await call("dara", "board_read", {}))).toContain("1 rule new or changed since you last read it");
    expect(textOf(await call("dara", "board_read", {}))).not.toContain("new or changed");
  });

  test("a row is its owner's, and two writers never overwrite each other", async () => {
    const boardId = await makeBoard();
    const made = await call("dara", "board_write", { kind: "row", boardId, item: "p3 limits", state: "building", branch: "p3-limits" });
    expect(made.structuredContent).toMatchObject({ row: { rowId: "w1", ownerThreadId: "dara", revision: 1 } });

    expect(textOf(await call("rowan", "board_write", { kind: "row", boardId, rowId: "w1", item: "p3 limits", state: "approved", expectedRevision: 1 }))).toContain(
      "only its owner or an admin",
    );
    const moved = await call("dara", "board_write", {
      kind: "row",
      boardId,
      rowId: "w1",
      item: "p3 limits",
      state: "in-review",
      commit: "4c1e9a0",
      nextStep: "Rowan reviews",
      expectedRevision: 1,
    });
    expect(moved.structuredContent).toMatchObject({ row: { state: "in-review", revision: 2 } });
    // The lead writes against the revision it read: refused, row unchanged.
    const stale = await call("iris", "board_write", { kind: "row", boardId, rowId: "w1", item: "p3 limits", state: "blocked", expectedRevision: 1 });
    expect(stale.structuredContent).toMatchObject({ error: { code: "revision_conflict" } });
    expect(store.boardRows(boardId)[0]).toMatchObject({ state: "in-review", revision: 2 });
    // Rows wake nobody.
    expect(notices).toEqual([]);
  });

  test("only the owner or an admin changes who is on it, and the app sees every change", async () => {
    const boardId = await makeBoard();
    expect(textOf(await call("dara", "board_grant", { boardId, agent: "rowan", revoke: true }))).toContain("needs admin");
    await call("iris", "board_grant", { boardId, agent: "rowan", access: "admin" });
    expect(store.boardMember(boardId, "rowan")?.access).toBe("admin");
    await call("chalk", "board_grant", { boardId, agent: "dara", revoke: true });
    expect(store.boardMember(boardId, "dara")).toBeNull();
    expect(events.map((e) => (e.type === "board.updated" ? e.part : e.type))).toEqual(["board", "members", "members"]);

    const [view] = boardsView(store, PROJECT);
    expect(view).toMatchObject({ board: { ownerThreadId: "chalk" }, members: [{ threadId: "iris", name: "Iris" }, { threadId: "rowan", name: "Rowan" }] });
  });
});
