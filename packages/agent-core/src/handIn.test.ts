import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Database } from "bun:sqlite";

class DatabaseSyncShim {
  private readonly db: Database;
  constructor(filePath: string, options?: { readOnly?: boolean }) {
    this.db = options?.readOnly
      ? new Database(filePath, { readonly: true })
      : new Database(filePath);
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
mock.module("./sqlite.js", () => ({ DatabaseSync: DatabaseSyncShim }));

import { setUserDataDir } from "./userDataDir.js";
import type { HandInSessions } from "./handIn.js";
import type { RuntimeEvent, Session, SessionStartInput } from "./types.js";

let tmpDir: string;

beforeEach(() => {
  tmpDir = mkdtempSync(path.join(tmpdir(), "kone-hand-in-test-"));
  setUserDataDir(tmpDir);
});

afterEach(async () => {
  const { resetConversationStoreForTests } = await import("./ConversationStore.js");
  resetConversationStoreForTests();
  if (tmpDir) rmSync(tmpDir, { recursive: true, force: true });
});

function turnStarted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.started", threadId, provider: "codex", at, source: "kone.store", turnId };
}

function turnCompleted(threadId: string, turnId: string, at: number): RuntimeEvent {
  return { type: "turn.completed", threadId, provider: "codex", at, source: "kone.store", turnId };
}

function textItem(threadId: string, turnId: string, itemId: string, text: string): RuntimeEvent {
  return {
    type: "item.updated",
    threadId,
    turnId,
    provider: "codex",
    at: 10,
    source: "kone.store",
    item: { itemId, kind: "assistant_text", status: "completed", text },
  };
}

/** A thread with one settled exchange, running on codex/gpt-x. */
async function seedThread(threadId = "t-live") {
  const { getConversationStore } = await import("./ConversationStore.js");
  const store = getConversationStore();
  store.ensureThread({ threadId, projectPath: "/p", provider: "codex", model: "gpt-x" });
  store.setTitle(threadId, "Fix the leak");
  store.recordUserBlock({ threadId, text: "first question", at: 100 });
  store.applyEvent(turnStarted(threadId, "turn-1", 110));
  store.applyEvent(textItem(threadId, "turn-1", "i-1", "first answer"));
  store.applyEvent(turnCompleted(threadId, "turn-1", 150));
  return store;
}

/** A stand-in for the provider layer that records the two calls a hand-in
 *  makes, so the operation can be checked without a live CLI. */
function recordingSessions(): HandInSessions & {
  stopped: string[];
  started: SessionStartInput[];
} {
  const stopped: string[] = [];
  const started: SessionStartInput[] = [];
  return {
    stopped,
    started,
    async stopSession(threadId: string): Promise<void> {
      stopped.push(threadId);
    },
    async startSession(input: SessionStartInput): Promise<Session> {
      started.push(input);
      const session: Session = { threadId: input.threadId, mode: "default" };
      if (input.model) session.model = input.model;
      return session;
    },
  };
}

describe("handInThread", () => {
  test("keeps the thread and records who it was handed from and to", async () => {
    const store = await seedThread();
    const { handInThread } = await import("./handIn.js");
    const sessions = recordingSessions();

    const result = await handInThread(sessions, {
      threadId: "t-live",
      target: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });

    // The same thread, not a new one: id, title and transcript all survive.
    expect(result.threadId).toBe("t-live");
    const thread = store.loadThread("t-live");
    expect(thread).not.toBeNull();
    expect(thread!.title).toBe("Fix the leak");
    expect(thread!.blocks.map((b) => b.role)).toEqual(["user", "assistant"]);
    // …and it now belongs to the target.
    expect(thread!.provider).toBe("claudeAgent");
    expect(store.threadMeta("t-live")?.model).toBe("claude-sonnet-5");

    const records = store.handInsForThread("t-live");
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      threadId: "t-live",
      fromProvider: "codex",
      fromModel: "gpt-x",
      toProvider: "claudeAgent",
      toModel: "claude-sonnet-5",
    });
    expect(records[0]!.at).toBeGreaterThan(0);
    expect(result.record).toEqual(records[0]!);
  });

  test("disposes the old session before starting the target's", async () => {
    await seedThread();
    const { handInThread } = await import("./handIn.js");
    const sessions = recordingSessions();

    await handInThread(sessions, { threadId: "t-live", target: { provider: "claudeAgent" } });

    expect(sessions.stopped).toEqual(["t-live"]);
    expect(sessions.started).toHaveLength(1);
    expect(sessions.started[0]).toMatchObject({
      threadId: "t-live",
      provider: "claudeAgent",
      cwd: "/p",
    });
  });

  test("the target is born with the thread's permission posture", async () => {
    const store = await seedThread();
    // Providers that take their permission mode as a spawn flag cannot be
    // talked into it afterwards, so a hand-in that dropped the thread's mode
    // would come up unable to adopt the posture it is running under.
    store.setThreadSelection("t-live", { mode: "full-access" });
    const { handInThread } = await import("./handIn.js");
    const sessions = recordingSessions();

    await handInThread(sessions, { threadId: "t-live", target: { provider: "claudeAgent" } });

    expect(sessions.started[0]?.mode).toBe("full-access");
  });

  test("an explicit target mode wins over the thread's stored one", async () => {
    const store = await seedThread();
    store.setThreadSelection("t-live", { mode: "full-access" });
    const { handInThread } = await import("./handIn.js");
    const sessions = recordingSessions();

    await handInThread(sessions, {
      threadId: "t-live",
      target: { provider: "claudeAgent", mode: "accept-edits" },
    });

    expect(sessions.started[0]?.mode).toBe("accept-edits");
  });

  test("refuses a hand-in to the hands the thread is already in", async () => {
    await seedThread();
    const { handInThread } = await import("./handIn.js");
    const sessions = recordingSessions();

    await expect(
      handInThread(sessions, { threadId: "t-live", target: { provider: "codex", model: "gpt-x" } }),
    ).rejects.toThrow(/different provider or model/);
    expect(sessions.stopped).toEqual([]);
  });

  test("the next turn replays the prior transcript exactly once", async () => {
    const store = await seedThread();
    const { handInThread } = await import("./handIn.js");
    const { sidechatBootstrapForTurn } = await import("./sidechat.js");
    await handInThread(recordingSessions(), {
      threadId: "t-live",
      target: { provider: "claudeAgent", model: "claude-sonnet-5" },
    });

    const preamble = sidechatBootstrapForTurn("t-live", "and now?");
    expect(preamble).not.toBeNull();
    expect(preamble).toContain("changed hands");
    expect(preamble).toContain("first question");
    expect(preamble).toContain("<latest_user_message>\nand now?");

    // The turn settling spends the one-shot replay.
    store.applyEvent(turnStarted("t-live", "turn-2", 300));
    store.applyEvent(textItem("t-live", "turn-2", "i-2", "second answer"));
    store.applyEvent(turnCompleted("t-live", "turn-2", 350));
    expect(store.pendingHandIn("t-live")).toBeNull();
    expect(sidechatBootstrapForTurn("t-live", "and after that?")).toBeNull();
  });
});
