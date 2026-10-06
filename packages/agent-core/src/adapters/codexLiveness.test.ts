import { beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Database } from "bun:sqlite";

import { setUserDataDir } from "../userDataDir.js";
import type { JsonValue } from "../lib-jsonValue.js";

// The wedge watchdog's liveness hook on Codex: a turn-scoped progress
// notification for the running turn says the turn is moving; the same for
// another turn, or another conversation, does not. Loaded from a temp copy of
// the adapter for the reasons codexAdapter.test.ts gives.

const SANDBOX_DIR = path.join(import.meta.dir, ".sandbox");
mock.module("../sqlite.js", () => ({ DatabaseSync: Database }));
setUserDataDir(path.join(tmpdir(), "kone-codex-liveness-test"));

type CodexAdapterModule = typeof import("./CodexAdapter.js");
let codex: CodexAdapterModule;

beforeAll(async () => {
  const source = readFileSync(fileURLToPath(new URL("./CodexAdapter.ts", import.meta.url)), "utf8").replace(
    /from "(\.[^"]+?)\.js"/g,
    (_match, spec: string) => `from ${JSON.stringify(new URL(`${spec}.ts`, import.meta.url).href)}`,
  );
  mkdirSync(SANDBOX_DIR, { recursive: true });
  const copy = path.join(mkdtempSync(path.join(SANDBOX_DIR, "kone-codex-liveness-")), "CodexAdapter.ts");
  writeFileSync(copy, source);
  // SAFETY: the copied module is CodexAdapter.ts itself.
  codex = (await import(pathToFileURL(copy).href)) as CodexAdapterModule;
});

type NotificationHandler = (params: JsonValue | null | undefined) => void;

function wired(conversationId: string) {
  const adapter = new codex.CodexAdapter(() => {});
  const alive: string[] = [];
  adapter.setLivenessHook((threadId) => alive.push(threadId));
  const notifications = new Map<string, NotificationHandler>();
  const rpc = {
    onNotification: (method: string, handler: NotificationHandler) => notifications.set(method, handler),
    onRequest: () => undefined,
    onExit: () => undefined,
    kill: async () => undefined,
    call: async () => ({}),
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
  // SAFETY: `session` carries every CodexSession field the notification
  // handlers read; the stand-in rpc implements the methods they call.
  const handle = session as never;
  adapter["sessions"].set(session.threadId, handle);
  adapter["wireNotifications"](handle);
  const notify = (method: string, params: JsonValue) => {
    const handler = notifications.get(method);
    if (!handler) throw new Error(`no handler for ${method}`);
    handler(params);
  };
  return { alive, notify };
}

describe("Codex liveness", () => {
  const CONV = "conv-1";
  const TURN = "turn-1";

  test("progress on the running turn keeps it alive", () => {
    const { alive, notify } = wired(CONV);
    notify("turn/started", { threadId: CONV, turn: { id: TURN, status: "inProgress" } });
    notify("item/mcpToolCall/progress", { threadId: CONV, turnId: TURN, itemId: "m-1", message: "indexing" });
    notify("item/reasoning/summaryPartAdded", { threadId: CONV, turnId: TURN, itemId: "r-1", summaryIndex: 1 });
    notify("turn/diff/updated", { threadId: CONV, turnId: TURN, diff: "" });
    expect(alive).toEqual(["kone-thread", "kone-thread", "kone-thread"]);
  });

  test("progress on another turn, or before any turn, does not", () => {
    const { alive, notify } = wired(CONV);
    notify("item/mcpToolCall/progress", { threadId: CONV, turnId: TURN, itemId: "m-1", message: "indexing" });
    notify("turn/started", { threadId: CONV, turn: { id: TURN, status: "inProgress" } });
    notify("item/mcpToolCall/progress", { threadId: CONV, turnId: "an-older-turn", itemId: "m-1", message: "late" });
    expect(alive).toEqual([]);
  });
});
