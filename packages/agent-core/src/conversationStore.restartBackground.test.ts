import { describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { setUserDataDir } from "./userDataDir.js";
import type { RuntimeItem } from "./types.js";

// The boot seal calls out the background work a restart is about to cancel —
// live subagents and the still-open tasks of a live plan item — so the
// dispatcher can tell the agent what will never report back. bun:sqlite stands
// in for the Electron built-in, and a second store over the same state dir is
// the next process on the same disk.

mock.module("./sqlite.js", () => ({ DatabaseSync: Database }));

const { ConversationStore } = await import("./ConversationStore.js");
type Store = InstanceType<typeof ConversationStore>;

let testUserDataDir = "";
function freshStore(): Store {
  testUserDataDir = mkdtempSync(path.join(tmpdir(), "kone-restart-bg-test-"));
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}
function reopenStore(): Store {
  setUserDataDir(testUserDataDir);
  return new ConversationStore();
}

const AT = 1_000;

/** The envelope every event in this file shares; each call spreads it and adds
 *  its own `type` and payload, so the object is a checked RuntimeEvent literal. */
function base(threadId: string, turnId: string) {
  return {
    threadId,
    provider: "claudeAgent" as const,
    at: AT,
    source: "kone.store" as const,
    turnId,
  };
}

function planItem(itemId: string, tasks: RuntimeItem["tasks"]): RuntimeItem {
  return { itemId, kind: "plan_text", status: "in-progress", text: "the plan", tasks };
}

describe("restart background work capture", () => {
  test("the boot seal captures live subagents and open tasks, once", () => {
    let store = freshStore();
    const threadId = "t-bg";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "claudeAgent" });
    store.applyEvent({ ...base(threadId, turnId), type: "turn.started" });
    store.applyEvent({
      ...base(threadId, turnId),
      type: "subagent.started",
      subagent: {
        toolUseId: "tool-1",
        taskId: "task-1",
        parentItemId: "call-1",
        agentType: "explore",
        description: "trace the callers",
        prompt: "trace them",
        model: "claude-haiku-4-5",
        status: "running",
        tokens: 0,
        toolUses: 0,
        startedAt: AT,
      },
    });
    store.applyEvent({
      ...base(threadId, turnId),
      type: "item.started",
      item: planItem("plan-1", [
        { id: "a", content: "done already", status: "completed" },
        { id: "b", content: "write the tests", status: "in-progress" },
      ]),
    });
    store.close();

    // The next process opens the same disk and seals the orphaned turn.
    store = reopenStore();
    const captured = store.takeRestartCancelledBackgroundWork();
    expect([...captured.keys()]).toEqual([threadId]);
    expect(captured.get(threadId)).toEqual([
      { kind: "subagent", label: "trace the callers", id: "tool-1" },
      { kind: "task", label: "write the tests", id: "plan-1:b" },
    ]);

    // Read-once: a later boot on the same process must not repeat the note.
    expect(store.takeRestartCancelledBackgroundWork().size).toBe(0);
  });

  test("a settled turn leaves nothing to report", () => {
    let store = freshStore();
    const threadId = "t-settled";
    const turnId = "turn-1";
    store.ensureThread({ threadId, projectPath: "/proj", provider: "claudeAgent" });
    store.applyEvent({ ...base(threadId, turnId), type: "turn.started" });
    store.applyEvent({
      ...base(threadId, turnId),
      type: "subagent.started",
      subagent: {
        toolUseId: "tool-2",
        taskId: "task-2",
        parentItemId: "call-2",
        agentType: "explore",
        description: "finished cleanly",
        prompt: "do it",
        model: "claude-haiku-4-5",
        status: "completed",
        tokens: 0,
        toolUses: 0,
        startedAt: AT,
        endedAt: AT + 5,
      },
    });
    store.close();

    store = reopenStore();
    expect(store.takeRestartCancelledBackgroundWork().size).toBe(0);
  });
});
