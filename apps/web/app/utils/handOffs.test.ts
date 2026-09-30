import { describe, expect, test } from "bun:test";

import type { SpawnedThread, StoredThreadMeta } from "~/types/desktop";
import { deriveDelegates, isWorkerThread } from "./subagentRuns";
import { summarizeSession } from "./sessionList";
import { decisionTextOf, renderGroups } from "./conversationSegments";

// Where each kind of hand-off shows up: a worker in its agent's Subagents dock
// and nowhere in the thread lists; a delegate or contractor as a thread of its
// own, labelled with who handed it the work.

function spawned(threadId: string, handOff?: SpawnedThread["handOff"]): SpawnedThread {
  const thread: SpawnedThread = {
    threadId,
    parentThreadId: "lead",
    title: threadId,
    provider: "claudeAgent",
    status: "working",
    terminal: false,
    createdAt: 1,
    updatedAt: 1,
  };
  if (handOff) thread.handOff = handOff;
  return thread;
}

function meta(overrides: Partial<StoredThreadMeta>): StoredThreadMeta {
  return { threadId: "t", projectPath: "/repo", provider: "codex", createdAt: 1, updatedAt: 2, ...overrides };
}

describe("the Subagents dock", () => {
  test("holds workers — including snapshots from before kinds — and never an agent", () => {
    expect(isWorkerThread(spawned("w"))).toBe(true);
    expect(isWorkerThread(spawned("w", "worker"))).toBe(true);
    expect(isWorkerThread(spawned("d", "delegation"))).toBe(false);
    expect(isWorkerThread(spawned("c", "contract"))).toBe(false);
    const rows = deriveDelegates([], [
      spawned("worker", "worker"),
      spawned("ada", "delegation"),
      spawned("frontend", "contract"),
    ]).rows;
    expect(rows.map((r) => r.id)).toEqual(["thread:worker"]);
  });
});

describe("thread summaries", () => {
  test("a worker is marked so the lists leave it out", () => {
    const summary = summarizeSession(
      meta({ lineage: { parentThreadId: "lead", relationshipToParent: "subagent", rootThreadId: "lead" } }),
      false,
    );
    expect(summary.worker).toBe(true);
    expect(summary.handOff).toBeUndefined();
  });

  test("a delegate says who delegated to it", () => {
    const summary = summarizeSession(
      meta({ lineage: { parentThreadId: "lead", relationshipToParent: "delegation", rootThreadId: "lead" } }),
      false,
    );
    expect(summary.handOff).toEqual({ kind: "delegation", fromThreadId: "lead" });
    expect(summary.worker).toBeUndefined();
  });

  test("a contractor says who contracted it, and as what", () => {
    const summary = summarizeSession(
      meta({
        lineage: { parentThreadId: "lead", relationshipToParent: "delegation", rootThreadId: "lead" },
        contract: {
          name: "Frontend Auth",
          role: "Frontend auth specialist",
          instructions: "i",
          scope: "s",
          deliverable: "d",
          doneCriteria: "c",
        },
      }),
      false,
    );
    expect(summary.handOff).toEqual({ kind: "contract", fromThreadId: "lead", role: "Frontend auth specialist" });
  });

  test("a thread nobody handed over carries neither", () => {
    const summary = summarizeSession(meta({}), false);
    expect(summary.handOff).toBeUndefined();
    expect(summary.worker).toBeUndefined();
  });
});

describe("a stop decision in the reply", () => {
  test("reads as its own line, like a hand-off, not a step", () => {
    const item = {
      itemId: "k",
      kind: "tool_call" as const,
      status: "completed" as const,
      name: "agent_keep_or_stop",
      text: "agent_keep_or_stop: 2 agents",
      detail: "Kept Frontend Auth running · stopped Ada.",
    };
    expect(decisionTextOf(item)).toBe("Kept Frontend Auth running · stopped Ada.");
    const groups = renderGroups({
      id: "b",
      role: "assistant",
      turnId: "t",
      state: "completed",
      at: 1,
      items: [item],
    });
    expect(groups.map((g) => g.kind)).toEqual(["decision"]);
    expect(decisionTextOf({ ...item, status: "in-progress" })).toBeNull();
    expect(decisionTextOf({ ...item, name: "agent_wait" })).toBeNull();
  });
});
