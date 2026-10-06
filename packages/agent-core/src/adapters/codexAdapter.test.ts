import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

// Sandbox copies of the adapter live inside the app tree (not the OS tmpdir)
// so bare-specifier workspace imports like @kone/protocol resolve via normal
// node_modules lookup from the copied module's location.
const SANDBOX_DIR = path.join(import.meta.dir, ".sandbox");

import { setUserDataDir } from "../userDataDir.js";
import { fileURLToPath, pathToFileURL } from "node:url";

import { Database } from "bun:sqlite";
import type { JsonRpcRequestHandler } from "../jsonRpc.js";
import { codexCommandView, object } from "./toolCalls.js";
import type { JsonObject, JsonValue } from "../lib-jsonValue.js";
import type { SubagentRunSnapshot } from "../types.js";

// Two hazards to dodge. First, the import chain reaches AttachmentStore →
// ConversationStore → node:sqlite (an Electron-runtime built-in this bun can't
// load), so the established repo pattern applies: stand node:sqlite in for
// bun:sqlite and point the agent layer's state dir at a throwaway dir. Second, bun
// keeps one mock.module registry per worker process, so suites like
// agentService.test.ts (which stubs CodexAdapter.js) can shadow this file —
// importing CodexAdapter.js here would return their stub, not the adapter.
// So the adapter is loaded from a temp copy of its source with every relative
// import rewritten to an absolute file URL: a resolved path no mock can
// intercept, evaluated by the same bun compiler as the real thing.
mock.module("../sqlite.js", () => ({
  DatabaseSync: Database,
}));
setUserDataDir(path.join(tmpdir(), "kone-codex-adapter-test"));

const CODEX_ADAPTER_SOURCE = fileURLToPath(new URL("./CodexAdapter.ts", import.meta.url));

async function loadRealCodexAdapter(): Promise<CodexAdapterHelpers> {
  const source = readFileSync(CODEX_ADAPTER_SOURCE, "utf8").replace(
    /from "(\.[^"]+?)\.js"/g,
    (_match, spec: string) => `from ${JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href)}`,
  );
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const dir = mkdtempSync(path.join(SANDBOX_DIR, "kone-codex-adapter-real-"));
  const copy = path.join(dir, "CodexAdapter.ts");
  writeFileSync(copy, source);
  // SAFETY: the copied module is CodexAdapter.ts itself, so its exports match CodexAdapterHelpers.
  return (await import(pathToFileURL(copy).href)) as CodexAdapterHelpers;
}

type CodexAdapterHelpers = typeof import("./CodexAdapter.js");
let helpers: CodexAdapterHelpers;

beforeAll(async () => {
  helpers = await loadRealCodexAdapter();
});

describe("CodexAdapter item detail scavenging", () => {
  test("joins multi-part summary/content arrays", () => {
    expect(helpers.joinedText(["part one", "part two"])).toBe("part one\n\npart two");
    expect(helpers.joinedText([" a ", "", " b "])).toBe("a\n\nb");
    expect(helpers.joinedText("not an array")).toBeUndefined();
    expect(helpers.joinedText(["   ", " "])).toBeUndefined();
  });

  test("itemDetail falls back to joined arrays when summary/content is an array", () => {
    expect(helpers.itemDetail({ summary: ["first", "second"] })).toBe("first\n\nsecond");
    expect(helpers.itemDetail({ content: ["hello", "world"] })).toBe("hello\n\nworld");
    expect(helpers.itemDetail({ command: "ls", content: ["ignored"] })).toBe("ls");
    expect(helpers.itemDetail({ result: { command: "npm test" } })).toBe("npm test");
    expect(helpers.itemDetail(undefined)).toBeUndefined();
  });
});

describe("CodexAdapter item status mapping", () => {
  test("maps declined completions to failed (kone has no declined state)", () => {
    expect(helpers.mapCodexItemStatus("completed", false)).toBe("completed");
    expect(helpers.mapCodexItemStatus("failed", false)).toBe("failed");
    expect(helpers.mapCodexItemStatus("declined", false)).toBe("failed");
    expect(helpers.mapCodexItemStatus(undefined, true)).toBe("failed");
    expect(helpers.mapCodexItemStatus(undefined, false)).toBe("completed");
  });
});

describe("CodexAdapter resume error formatting", () => {
  test("explains how to resolve an active-writer conflict", () => {
    const formatted = helpers.formatCodexThreadResumeError(
      new Error("thread/resume failed: thread external-thread already has an active writer"),
      "external-thread",
    );
    expect(formatted.message).toContain("external-thread");
    expect(formatted.message).toContain("another Codex client");
    expect(formatted.cause).toBeInstanceOf(Error);
  });

  test("passes non-active-writer errors through unchanged", () => {
    const original = new Error("thread/resume failed: thread not found");
    expect(helpers.formatCodexThreadResumeError(original, "t-1")).toBe(original);
    expect(helpers.formatCodexThreadResumeError("raw string", "t-1").message).toBe("raw string");
  });
});

describe("CodexAdapter mode → approval/sandbox mapping", () => {
  test("ask runs untrusted approvals inside a read-only sandbox", () => {
    expect(helpers.mapModeToThreadOverrides("ask")).toEqual({
      approvalPolicy: "untrusted",
      sandbox: "read-only",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("ask")).toEqual({
      approvalPolicy: "untrusted",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "readOnly" },
    });
  });

  test("accept-edits auto-runs inside workspace-write but still asks outside it", () => {
    expect(helpers.mapModeToThreadOverrides("accept-edits")).toEqual({
      approvalPolicy: "on-request",
      sandbox: "workspace-write",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("accept-edits")).toEqual({
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "workspaceWrite" },
    });
  });

  test("full-access runs everything without asking in danger-full-access", () => {
    expect(helpers.mapModeToThreadOverrides("full-access")).toEqual({
      approvalPolicy: "never",
      sandbox: "danger-full-access",
      approvalsReviewer: "user",
    });
    expect(helpers.mapModeToTurnOverrides("full-access")).toEqual({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  test("an unknown mode falls back to the accept-edits rung, never something wider", () => {
    // The adapter treats the middle rung as the default everywhere else
    // (startSession/sendTurn both do `?? "accept-edits"`), so a stray value
    // must land there too — thread and turn spellings alike.
    // SAFETY: deliberately out-of-vocabulary inputs; the cast only routes them
    // through the typed parameter so the default branch can be observed.
    expect(helpers.mapModeToThreadOverrides("mystery" as never)).toEqual(helpers.mapModeToThreadOverrides("accept-edits"));
    // SAFETY: deliberately out-of-vocabulary inputs; the cast only routes them
    // through the typed parameter so the default branch can be observed.
    expect(helpers.mapModeToTurnOverrides("mystery" as never)).toEqual(helpers.mapModeToTurnOverrides("accept-edits"));
  });
});

describe("CodexAdapter approval replies", () => {
  const PERMISSION_PARAMS = {
    cwd: "/proj",
    permissions: { fileSystem: { write: ["/proj/out"] }, network: { enabled: true } },
    reason: "needs to export",
  };

  test("command/file asks answer the decision vocabulary", () => {
    expect(helpers.buildApprovalReply("command", "allow-once", {})).toEqual({ decision: "accept" });
    expect(helpers.buildApprovalReply("command", "allow-always", {})).toEqual({ decision: "acceptForSession" });
    expect(helpers.buildApprovalReply("file-change", "reject-once", {})).toEqual({ decision: "decline" });
    expect(helpers.buildApprovalReply("file-read", "reject-and-stop", {})).toEqual({ decision: "cancel" });
  });

  test("permission asks answer permissions+scope — echoing exactly what was granted", () => {
    expect(helpers.buildApprovalReply("permission", "allow-once", PERMISSION_PARAMS)).toEqual({
      permissions: PERMISSION_PARAMS.permissions,
      scope: "turn",
    });
    expect(helpers.buildApprovalReply("permission", "allow-always", PERMISSION_PARAMS)).toEqual({
      permissions: PERMISSION_PARAMS.permissions,
      scope: "session",
    });
  });

  test("a refused permission grant echoes no permissions at all", () => {
    expect(helpers.buildApprovalReply("permission", "reject-once", PERMISSION_PARAMS)).toEqual({
      permissions: {},
      scope: "turn",
    });
    expect(helpers.buildApprovalReply("permission", "reject-and-stop", PERMISSION_PARAMS)).toEqual({
      permissions: {},
      scope: "turn",
    });
  });

  test("fail-closed declines use each kind's own refusal shape", () => {
    expect(helpers.declinedApprovalReply("command")).toEqual({ decision: "decline" });
    expect(helpers.declinedApprovalReply("file-change")).toEqual({ decision: "decline" });
    expect(helpers.declinedApprovalReply("permission")).toEqual({ permissions: {}, scope: "turn" });
  });
});

describe("CodexAdapter permission ask normalization", () => {
  test("describes write/read paths and network from the requested profile", () => {
    expect(
      helpers.describePermissionProfile({
        fileSystem: { write: ["/a"], read: ["/b"] },
        network: { enabled: true },
      }),
    ).toBe("write: /a · read: /b · network");
  });

  test("handles entry-style profiles and returns nothing for an empty one", () => {
    expect(
      helpers.describePermissionProfile({ fileSystem: { entries: [{ access: "write", path: { text: "/c" } }] } }),
    ).toBe("write /c");
    expect(helpers.describePermissionProfile({})).toBeUndefined();
    expect(helpers.describePermissionProfile(undefined)).toBeUndefined();
  });
});
describe("CodexAdapter steerTurn", () => {
  test("steer with no session falls back to sendTurn, which rejects", async () => {
    const events: unknown[] = [];
    const adapter = new helpers.CodexAdapter((e) => events.push(e));
    await expect(
      adapter.steerTurn({ threadId: "missing-thread", input: "hello" }),
    ).rejects.toThrow("No Codex session for thread missing-thread");
  });
});

describe("CodexAdapter turn input with invoked skills", () => {
  test("a native skill rides as a skill item beside a $mention-led text item", async () => {
    const skillPath = "/home/u/.agents/skills/deploy/SKILL.md";
    const items = await helpers.buildCodexTurnInputItems({
      threadId: "t",
      input: "  ship it  ",
      skills: [{ name: "deploy", path: skillPath }],
    });
    expect(items).toEqual([
      { type: "text", text: "$deploy ship it", text_elements: [] },
      { type: "skill", name: "deploy", path: skillPath },
    ]);
  });

  test("a skill-only turn is valid and a foreign-root skill is inlined, not sent as an item", async () => {
    const root = mkdtempSync(path.join(SANDBOX_DIR, "kone-codex-skill-"));
    const skillDir = path.join(root, ".claude", "skills", "review");
    mkdirSync(skillDir, { recursive: true });
    writeFileSync(path.join(skillDir, "SKILL.md"), "Review with care.");
    const items = await helpers.buildCodexTurnInputItems({
      threadId: "t",
      input: "",
      skills: [{ name: "review", path: path.join(skillDir, "SKILL.md") }],
    });
    expect(items).toHaveLength(1);
    const [only] = items;
    if (only?.type !== "text") throw new Error("expected a single text item");
    expect(only.text).toStartWith("<invoked_skills>");
    expect(only.text).toContain("Review with care.");
  });

  test("a turn with nothing in it still refuses", async () => {
    await expect(helpers.buildCodexTurnInputItems({ threadId: "t", input: "   " })).rejects.toThrow(
      "Turn input must include text or an attachment.",
    );
  });
});

// Codex streams a spawned subagent's notifications over the parent's own
// app-server connection, each stamped with the child conversation's `threadId`.
// These drive the adapter's real notification handlers with a stand-in RPC.
type NotificationHandler = (params: JsonValue | null | undefined) => void;

function wiredCodexSession(conversationId: string) {
  const events: Array<{
    type: string;
    turnId?: string;
    requestId?: string;
    subagentToolUseId?: string;
    item?: import("../types.js").RuntimeItem;
    subagent?: SubagentRunSnapshot;
  }> = [];
  const adapter = new helpers.CodexAdapter((event) => {
    // SAFETY: the test only reads the type/turnId/item fields every runtime event shape it asserts on carries.
    events.push(event as (typeof events)[number]);
  });
  const notifications = new Map<string, NotificationHandler>();
  const requests = new Map<string, JsonRpcRequestHandler>();
  const calls: Array<{ method: string; params: JsonValue }> = [];
  const rpc = {
    onNotification: (method: string, handler: NotificationHandler) => notifications.set(method, handler),
    onRequest: (method: string, handler: JsonRpcRequestHandler) => requests.set(method, handler),
    onExit: () => undefined,
    kill: async () => undefined,
    call: async (method: string, params: JsonValue) => {
      calls.push({ method, params });
      return {};
    },
  };
  const session = {
    threadId: "kone-thread",
    cwd: "/tmp",
    mode: "accept-edits",
    conversationId,
    rpc,
    liveTurnIds: new Set<string>(),
    items: new Map(),
    pendingUserInputs: new Map(),
    pendingApprovals: new Map(),
    subagentRuns: new Map(),
    childLiveTurns: new Map<string, string>(),
  };
  // SAFETY: `session` carries every CodexSession field the notification and
  // request handlers read; the stand-in rpc implements the four methods they call.
  const wired = session as never;
  adapter["sessions"].set(session.threadId, wired);
  adapter["wireNotifications"](wired);
  adapter["wireRequests"](wired);
  const notify = (method: string, params: JsonValue) => {
    const handler = notifications.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    handler(params);
  };
  const request = (method: string, params: JsonValue) => {
    const handler = requests.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    return handler(params);
  };
  return { adapter, events, session, notify, request, calls };
}

describe("CodexAdapter subagent (spawn_agent) notifications", () => {
  const PARENT = "parent-conv";
  const CHILD = "child-conv";
  const PARENT_TURN = "parent-turn";
  const CHILD_TURN = "child-turn";

  function agentMessage(threadId: string, turnId: string, id: string, lifecycle: "item/started" | "item/completed", text = "") {
    return [lifecycle, { threadId, turnId, item: { type: "agentMessage", id, text } }] as const;
  }

  test("a child's turn and items never touch the parent's turn, and the parent's final answer lands", async () => {
    const { adapter, events, session, notify } = wiredCodexSession(PARENT);

    notify("turn/started", { threadId: PARENT, turn: { id: PARENT_TURN, status: "inProgress" } });
    notify(...agentMessage(PARENT, PARENT_TURN, "p-intro", "item/started"));
    notify("item/agentMessage/delta", { threadId: PARENT, turnId: PARENT_TURN, itemId: "p-intro", delta: "Spawning reviewers." });
    notify(...agentMessage(PARENT, PARENT_TURN, "p-intro", "item/completed", "Spawning reviewers."));

    // The child runs a whole turn of its own while the parent's turn is live.
    notify("turn/started", { threadId: CHILD, turn: { id: CHILD_TURN, status: "inProgress" } });
    notify(...agentMessage(CHILD, CHILD_TURN, "c-msg", "item/started"));
    notify("item/agentMessage/delta", { threadId: CHILD, turnId: CHILD_TURN, itemId: "c-msg", delta: "Child partial" });
    notify(...agentMessage(CHILD, CHILD_TURN, "c-msg", "item/completed", "Child partial"));
    notify("thread/tokenUsage/updated", { threadId: CHILD, turnId: CHILD_TURN, tokenUsage: { total: { totalTokens: 1 }, last: { totalTokens: 1 } } });
    notify("turn/completed", { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } });

    // The parent is still running after its child finished.
    expect(session.activeTurnId).toBe(PARENT_TURN);
    expect((await adapter.listSessions())[0]?.status).toBe("running");

    notify(...agentMessage(PARENT, PARENT_TURN, "p-final", "item/started"));
    notify("item/agentMessage/delta", { threadId: PARENT, turnId: PARENT_TURN, itemId: "p-final", delta: "Final answer." });
    notify(...agentMessage(PARENT, PARENT_TURN, "p-final", "item/completed", "Final answer."));
    notify("turn/completed", { threadId: PARENT, turn: { id: PARENT_TURN, status: "completed" } });

    const lifecycle = events.filter((e) => e.type.startsWith("turn."));
    expect(lifecycle.map((e) => [e.type, e.turnId])).toEqual([
      ["turn.started", PARENT_TURN],
      ["turn.completed", PARENT_TURN],
    ]);
    const final = events.filter((e) => e.type === "item.completed" && e.item?.itemId === "p-final");
    expect(final).toHaveLength(1);
    expect(final[0]?.turnId).toBe(PARENT_TURN);
    expect(final[0]?.item?.text).toBe("Final answer.");
    // Nothing from the child is filed as the parent's own transcript or usage.
    expect(events.some((e) => e.item?.itemId === "c-msg")).toBe(false);
    expect(events.some((e) => e.type === "thread.token-usage.updated")).toBe(false);
    expect(session.activeTurnId).toBeUndefined();
  });

  test("a child's fatal error neither aborts the parent's turn nor flips the session to error", () => {
    const { events, session, notify } = wiredCodexSession(PARENT);
    notify("turn/started", { threadId: PARENT, turn: { id: PARENT_TURN, status: "inProgress" } });
    notify("error", { threadId: CHILD, turnId: CHILD_TURN, willRetry: false, error: { message: "child blew up" } });
    expect(session.activeTurnId).toBe(PARENT_TURN);
    expect(events.some((e) => e.type === "turn.aborted" || e.type === "session.state.changed")).toBe(false);
  });

  test("a child's approval request still parks for the user, filed under the parent's live turn", async () => {
    const { events, notify, request, adapter } = wiredCodexSession(PARENT);
    notify("turn/started", { threadId: PARENT, turn: { id: PARENT_TURN, status: "inProgress" } });
    const reply = request("item/commandExecution/requestApproval", {
      threadId: CHILD,
      turnId: CHILD_TURN,
      itemId: "c-cmd",
      command: "ls",
    });
    const asked = events.find((e) => e.type === "approval.requested");
    expect(asked?.turnId).toBe(PARENT_TURN);
    const requestId = asked?.requestId;
    if (!requestId) throw new Error("approval.requested carried no requestId");
    await adapter.respondToRequest("kone-thread", requestId, "allow-once");
    expect(await reply).toBeDefined();
  });
});

describe("CodexAdapter nests spawned subagents under the parent turn", () => {
  const PARENT = "parent-conv";
  const CHILD = "child-conv";
  const PARENT_TURN = "parent-turn";
  const CHILD_TURN = "child-turn";
  const NATIVE_SPAWN = "call_spawn";
  const SPAWN = `${NATIVE_SPAWN}:child:${CHILD}`;

  function spawnActivity(kind: "started" | "interacted" | "interrupted" | "completed", id = NATIVE_SPAWN) {
    return {
      threadId: PARENT,
      turnId: PARENT_TURN,
      item: { type: "subAgentActivity", id, kind, agentThreadId: CHILD, agentPath: "/root/composer_review" },
    };
  }

  function startParentAndSpawn() {
    const wired = wiredCodexSession(PARENT);
    wired.notify("turn/started", { threadId: PARENT, turn: { id: PARENT_TURN, status: "inProgress" } });
    wired.notify("item/completed", spawnActivity("started"));
    return wired;
  }

  test("a spawn opens a run on a subagent tool call, and the child's items land inside it", () => {
    const { events, notify } = startParentAndSpawn();

    const spawnIndex = events.findIndex((e) => e.type === "item.started" && e.item?.itemId === SPAWN);
    const runIndex = events.findIndex((e) => e.type === "subagent.started");
    expect(spawnIndex).toBeGreaterThanOrEqual(0);
    // The run attaches to its tool call, so the call has to exist first.
    expect(runIndex).toBeGreaterThan(spawnIndex);
    const spawn = events[spawnIndex];
    expect(spawn?.turnId).toBe(PARENT_TURN);
    expect(spawn?.item).toMatchObject({ kind: "tool_call", name: "agent", text: "composer_review", status: "in-progress" });
    expect(events[runIndex]?.turnId).toBe(PARENT_TURN);
    expect(events[runIndex]?.subagent).toMatchObject({
      toolUseId: SPAWN,
      parentItemId: SPAWN,
      description: "composer_review",
      status: "running",
    });

    notify("turn/started", { threadId: CHILD, turn: { id: CHILD_TURN, status: "inProgress" } });
    notify("item/started", { threadId: CHILD, turnId: CHILD_TURN, item: { type: "commandExecution", id: "c-cmd", command: "ls" } });
    notify("item/started", { threadId: CHILD, turnId: CHILD_TURN, item: { type: "agentMessage", id: "c-msg", text: "" } });
    notify("item/agentMessage/delta", { threadId: CHILD, turnId: CHILD_TURN, itemId: "c-msg", delta: "Child report" });
    notify("item/completed", { threadId: CHILD, turnId: CHILD_TURN, item: { type: "agentMessage", id: "c-msg", text: "Child report" } });
    notify("turn/completed", { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } });

    const childItems = events.filter((e) => e.item?.itemId === "c-msg" || e.item?.itemId === "c-cmd");
    expect(childItems.length).toBeGreaterThan(0);
    for (const e of childItems) {
      expect(e.turnId).toBe(PARENT_TURN);
      expect(e.subagentToolUseId).toBe(SPAWN);
    }
    expect(childItems.find((e) => e.type === "item.completed" && e.item?.itemId === "c-msg")?.item?.text).toBe("Child report");
    // The child's tool use shows as live progress on the run.
    expect(events.some((e) => e.type === "subagent.updated" && e.subagent?.lastToolName === "run" && e.subagent.toolUses === 1)).toBe(true);
    // Still no child turn lifecycle on the parent.
    expect(events.filter((e) => e.type.startsWith("turn.")).map((e) => e.turnId)).toEqual([PARENT_TURN]);
  });

  test("the parent's completion notice settles the run with the child's last message and closes the spawn call", () => {
    const { events, notify } = startParentAndSpawn();
    notify("turn/started", { threadId: CHILD, turn: { id: CHILD_TURN, status: "inProgress" } });
    notify("item/completed", { threadId: CHILD, turnId: CHILD_TURN, item: { type: "agentMessage", id: "c-msg", text: "Child report" } });
    notify("turn/completed", { threadId: CHILD, turn: { id: CHILD_TURN, status: "completed" } });
    notify("item/completed", spawnActivity("completed", "subagent-completed-1"));

    const settled = events.filter((e) => e.type === "subagent.completed");
    expect(settled).toHaveLength(1);
    expect(settled[0]?.turnId).toBe(PARENT_TURN);
    expect(settled[0]?.subagent).toMatchObject({ toolUseId: SPAWN, status: "completed", summary: "Child report" });
    expect(settled[0]?.subagent?.endedAt).toBeNumber();
    const closed = events.filter((e) => e.type === "item.completed" && e.item?.itemId === SPAWN);
    expect(closed).toHaveLength(1);
    expect(closed[0]?.item?.status).toBe("completed");
    // The completion notice is bookkeeping, not a transcript entry.
    expect(events.some((e) => e.item?.itemId === "subagent-completed-1")).toBe(false);

    // A settled run takes no more traffic.
    const before = events.length;
    notify("item/completed", { threadId: CHILD, turnId: CHILD_TURN, item: { type: "agentMessage", id: "late", text: "late" } });
    expect(events.length).toBe(before);
  });

  test("a collabAgentToolCall spawn opens the run with its prompt and model, once", () => {
    const { events, notify } = wiredCodexSession(PARENT);
    notify("turn/started", { threadId: PARENT, turn: { id: PARENT_TURN, status: "inProgress" } });
    notify("item/started", {
      threadId: PARENT,
      turnId: PARENT_TURN,
      item: {
        type: "collabAgentToolCall",
        id: NATIVE_SPAWN,
        tool: "spawnAgent",
        status: "inProgress",
        senderThreadId: PARENT,
        receiverThreadIds: [CHILD],
        prompt: "Review the composer",
        model: "gpt-6.1-sol",
        reasoningEffort: "high",
        agentsStates: {},
      },
    });
    notify("item/completed", spawnActivity("started"));

    expect(events.filter((e) => e.type === "subagent.started")).toHaveLength(1);
    const run = events.find((e) => e.type === "subagent.started")?.subagent;
    expect(run).toMatchObject({ toolUseId: SPAWN, parentItemId: SPAWN, prompt: "Review the composer", model: "gpt-6.1-sol", effort: "high" });
    expect(events.find((e) => e.type === "item.started" && e.item?.itemId === SPAWN)?.item?.name).toBe("agent");
    expect(events.filter((e) => e.type === "item.started" && e.item?.itemId === SPAWN)).toHaveLength(1);
  });

  test("a known child's approval is scoped to its run", () => {
    const { events, request } = startParentAndSpawn();
    void request("item/commandExecution/requestApproval", { threadId: CHILD, turnId: CHILD_TURN, itemId: "c-cmd", command: "ls" });
    const asked = events.find((e) => e.type === "approval.requested");
    expect(asked?.turnId).toBe(PARENT_TURN);
    expect(asked?.subagentToolUseId).toBe(SPAWN);
  });

  test("interrupting the parent interrupts every child turn still running, then the parent", async () => {
    const { adapter, notify, calls } = startParentAndSpawn();
    notify("turn/started", { threadId: CHILD, turn: { id: CHILD_TURN, status: "inProgress" } });
    notify("turn/started", { threadId: "other-child", turn: { id: "other-turn", status: "inProgress" } });
    notify("turn/completed", { threadId: "other-child", turn: { id: "other-turn", status: "completed" } });

    await adapter.interruptTurn("kone-thread");

    const interrupts = calls.filter((c) => c.method === "turn/interrupt").map((c) => c.params);
    expect(interrupts).toEqual([
      { threadId: CHILD, turnId: CHILD_TURN },
      { threadId: PARENT, turnId: PARENT_TURN },
    ]);
  });

  test("a parent turn that ends interrupted settles its live runs as stopped", () => {
    const { events, notify } = startParentAndSpawn();
    notify("turn/completed", { threadId: PARENT, turn: { id: PARENT_TURN, status: "interrupted" } });
    const settled = events.find((e) => e.type === "subagent.completed");
    expect(settled?.subagent).toMatchObject({ toolUseId: SPAWN, status: "stopped" });
    expect(events.find((e) => e.type === "item.completed" && e.item?.itemId === SPAWN)).toBeDefined();
    // The run settles before the turn it belongs to closes.
    const settledAt = events.findIndex((e) => e.type === "subagent.completed");
    const abortedAt = events.findIndex((e) => e.type === "turn.aborted");
    expect(settledAt).toBeLessThan(abortedAt);
  });
});

describe("CodexAdapter blocking Kone question history", () => {
  test("keeps the question and tool result inside the original assistant turn", () => {
    const { events, notify } = wiredCodexSession("blocking-question-thread");
    notify("turn/started", { threadId: "blocking-question-thread", turn: { id: "blocking-turn" } });
    const item = { type: "mcpToolCall", id: "question-call", server: "kone", tool: "ask_question",
      arguments: { questions: [{ question: "Which color?", options: ["Blue", "Green"] }] } };
    notify("item/started", { threadId: "blocking-question-thread", turnId: "blocking-turn", item });
    notify("item/completed", { threadId: "blocking-question-thread", turnId: "blocking-turn", item: {
      ...item, status: "completed", result: { content: [{ type: "text", text: "Blue" }] },
    } });
    const completed = events.find((e) => e.type === "item.completed");
    expect(completed).toMatchObject({ turnId: "blocking-turn", item: { name: "ask_question", kind: "tool_call", text: "" } });
    expect(completed?.item?.detail).toContain("Which color?");
    expect(completed?.item?.detail).toContain('"text": "Blue"');
    expect(events.filter((e) => e.type === "turn.started")).toHaveLength(1);
  });

  test("names every kone tool canonically and keeps its arguments over streamed output", () => {
    const { events, notify } = wiredCodexSession("kone-tool-thread");
    notify("turn/started", { threadId: "kone-tool-thread", turn: { id: "kone-turn" } });
    // Served under a former name, through the deferred-tools server.
    const item = { type: "mcpToolCall", id: "message-call", server: "kone_extra", tool: "kone_irc_send",
      arguments: { to: "main", message: "done" } };
    notify("item/started", { threadId: "kone-tool-thread", turnId: "kone-turn", item });
    const started = events.find((e) => e.type === "item.started");
    expect(started?.item).toMatchObject({ name: "agent_message", text: "" });
    expect(JSON.parse(started?.item?.detail ?? "")).toEqual({ to: "main", message: "done" });
    notify("item/mcpToolCall/progress", { threadId: "kone-tool-thread", turnId: "kone-turn", itemId: "message-call", delta: "sending" });
    notify("item/completed", { threadId: "kone-tool-thread", turnId: "kone-turn", item: {
      ...item, status: "failed", error: { message: "no such agent" }, result: null,
    } });
    const completed = events.find((e) => e.type === "item.completed");
    expect(completed?.item).toMatchObject({ name: "agent_message", status: "failed", text: "" });
    expect(JSON.parse(completed?.item?.detail ?? "")).toEqual({
      arguments: { to: "main", message: "done" }, result: null, error: { message: "no such agent" },
    });
  });

  test("another server's MCP call retains server and tool identity", () => {
    const { events, notify } = wiredCodexSession("foreign-mcp-thread");
    notify("turn/started", { threadId: "foreign-mcp-thread", turn: { id: "foreign-turn" } });
    const item = { type: "mcpToolCall", id: "foreign-call", server: "github", tool: "ask_question",
      title: "github: ask_question", arguments: { q: "x" } };
    notify("item/started", { threadId: "foreign-mcp-thread", turnId: "foreign-turn", item });
    notify("item/completed", { threadId: "foreign-mcp-thread", turnId: "foreign-turn", item: {
      ...item, status: "completed", result: { output: "fetched" },
    } });
    const started = events.find((e) => e.type === "item.started");
    expect(started?.item).toMatchObject({ name: "mcp__github__ask_question", text: "github: ask_question" });
    expect(started?.item?.detail).toBeUndefined();
    const completed = events.find((e) => e.type === "item.completed");
    expect(completed?.item).toMatchObject({ name: "mcp__github__ask_question", text: "github: ask_question", detail: "fetched" });
  });
});


describe("captured Codex tool calls", () => {
  const captures = readFileSync(path.join(import.meta.dir, "fixtures/toolCalls/codex-app-server.jsonl"), "utf8")
    .trim().split("\n").map((line) => {
      // SAFETY: repository-owned capture fixtures have label/frame envelopes; item fields are probed below.
      return JSON.parse(line) as { label: string; frame: { method?: string; params?: JsonObject } };
    });

  test("real completions surface output, structured files, web targets and MCP results", () => {
    for (const capture of captures.filter((c) => c.frame.method === "item/completed")) {
      const p = capture.frame.params;
      const raw = object(p?.item);
      if (!raw || !["commandExecution", "fileChange", "mcpToolCall", "webSearch"].includes(String(raw.type))) continue;
      const { events, notify } = wiredCodexSession(String(p!.threadId));
      notify("turn/started", { threadId: p!.threadId, turn: { id: p!.turnId } });
      notify("item/completed", p);
      const item = events.find((e) => e.type === "item.completed")?.item;
      expect(item).toBeDefined();
      if (raw.type === "commandExecution") {
        expect(item?.detail).toBe(raw.aggregatedOutput);
        expect(item?.status).toBe(raw.status);
        // A whole-script read (`cat /etc/hostname`) reads as a read; the rest run.
        const view = codexCommandView(raw)!;
        expect(item?.tool?.action).toBe(view.action);
        expect(item?.tool?.target).toBe(view.target);
        expect(item?.text).toBe(view.target);
        expect(item?.text.startsWith("/bin/bash")).toBe(false);
      } else if (raw.type === "fileChange") {
        expect(item?.fileChanges?.length).toBe(Array.isArray(raw.changes) ? raw.changes.length : 0);
        expect(item?.fileChanges?.every((c) => c.applied)).toBe(true);
        expect(item?.detail).toContain("@@");
      } else if (raw.type === "mcpToolCall") {
        expect(item?.tool?.transport).toEqual({ server: raw.server, tool: raw.tool });
        expect(JSON.parse(item?.detail ?? "")).toEqual(raw.result);
      } else {
        expect(item?.tool?.target).toBe(raw.query);
        expect(item?.detail).toBeDefined();
      }
    }
  });

  test("a final snapshot replaces partial stdout, and a late delta cannot reopen it", () => {
    const { events, notify } = wiredCodexSession("snapshot-thread");
    notify("turn/started", { threadId: "snapshot-thread", turn: { id: "snapshot-turn" } });
    const item = { id: "command", type: "commandExecution", command: "echo hello" };
    notify("item/started", { threadId: "snapshot-thread", turnId: "snapshot-turn", item });
    notify("item/commandExecution/outputDelta", { threadId: "snapshot-thread", turnId: "snapshot-turn", itemId: "command", delta: "hel" });
    notify("item/completed", { threadId: "snapshot-thread", turnId: "snapshot-turn", item: { ...item, status: "completed", aggregatedOutput: "hello\n" } });
    notify("item/commandExecution/outputDelta", { threadId: "snapshot-thread", turnId: "snapshot-turn", itemId: "command", delta: "lo\n" });
    expect(events.filter((e) => e.item?.itemId === "command").at(-1)?.item).toMatchObject({ status: "completed", detail: "hello\n" });
  });

  test("one spawn with multiple receivers creates distinct child rows", () => {
    const { events, notify } = wiredCodexSession("fanout-thread");
    notify("turn/started", { threadId: "fanout-thread", turn: { id: "fanout-turn" } });
    const raw = { id: "spawn", type: "collabAgentToolCall", tool: "spawnAgent", receiverThreadIds: ["a", "b"] };
    notify("item/started", { threadId: "fanout-thread", turnId: "fanout-turn", item: raw });
    notify("item/completed", { threadId: "fanout-thread", turnId: "fanout-turn", item: { ...raw, status: "completed" } });
    expect(events.filter((e) => e.type === "subagent.started").map((e) => e.subagent?.toolUseId)).toEqual(["spawn:child:a", "spawn:child:b"]);
    expect(events.find((e) => e.type === "item.completed" && e.item?.itemId === "spawn")?.item?.status).toBe("completed");
    expect(events.filter((e) => e.type === "subagent.completed")).toHaveLength(0);
  });
});
