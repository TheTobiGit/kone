import { describe, expect, test } from "bun:test";
import { useAgent, type UserBlock } from "./useAgent";
import type { RuntimeEvent } from "~/types/desktop";

// The durable turn-queue slice (AgentService): a send while a turn runs is
// durably enqueued and announced on the runtime stream. These tests drive the
// session reducer with the queue events and assert the chips/badges state the
// composer and thread view read.

let seq = 0;
function harness() {
  // A unique cwd per harness — the session registry is keyed by project path,
  // so each test gets a fresh blank thread.
  const agent = useAgent({ provider: "codex", cwd: `/tmp/kone-queue-test-${seq++}`, rehydrate: false });
  const session = agent.sessions.value[0]!;
  return { agent, session };
}

function queuedEvent(
  threadId: string,
  type: "turn.queued" | "turn.queued-cancelled" | "turn.promoted" | "turn.steered",
  extra: Record<string, unknown> = {},
): RuntimeEvent {
  return {
    threadId,
    provider: "codex",
    at: Date.now(),
    source: "kone.store",
    type,
    ...extra,
  } as RuntimeEvent;
}

function userBlock(id: string, text = "follow-up"): UserBlock {
  return { id, role: "user", text, at: Date.now() };
}

describe("useAgent durable turn queue", () => {
  test("turn.queued parks a chip anchored to the store block by userBlockId", () => {
    const { session } = harness();
    const block = userBlock("store-block-1", "do the thing");
    session.blocks.value = [...session.blocks.value, block];

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q1",
        userBlockId: "store-block-1",
        dispatchMode: "queue",
        position: 2,
      }),
    );

    expect(session.queuedTurns.value).toHaveLength(1);
    const entry = session.queuedTurns.value[0]!;
    expect(entry).toMatchObject({
      queueId: "q1",
      userBlockId: "store-block-1",
      blockId: "store-block-1",
      input: "do the thing",
      position: 1, // no live turn → the line starts at 1
    });
  });

  test("a live turn is slot 1 — queued chips read 2, 3 in arrival order", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    session.blocks.value = [
      ...session.blocks.value,
      userBlock("b-a"),
      userBlock("b-b"),
    ];

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-a",
        userBlockId: "b-a",
        dispatchMode: "queue",
        position: 2,
      }),
    );
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-b",
        userBlockId: "b-b",
        dispatchMode: "steer",
        position: 3,
      }),
    );

    expect(session.queuedTurns.value.map((q) => [q.queueId, q.position])).toEqual([
      ["q-a", 2],
      ["q-b", 3],
    ]);
  });

  test("an unanchored row (no matching block) still parks a chip, from its own input", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-x",
        userBlockId: "unknown-block",
        dispatchMode: "queue",
        position: 2,
      }),
    );
    const entry = session.queuedTurns.value[0]!;
    expect(entry).toMatchObject({
      queueId: "q-x",
      input: "",
    });
    expect(entry.blockId).toBeUndefined();
  });

  test("turn.queued-cancelled (user) removes one chip; (stop) clears the line", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    for (const [queueId, blockId] of [
      ["q-1", "b-1"],
      ["q-2", "b-2"],
      ["q-3", "b-3"],
    ] as const) {
      session.blocks.value = [...session.blocks.value, userBlock(blockId)];
      session.reduce(
        queuedEvent(session.threadId.value, "turn.queued", {
          queueId,
          userBlockId: blockId,
          dispatchMode: "queue",
          position: 2,
        }),
      );
    }
    expect(session.queuedTurns.value).toHaveLength(3);

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-cancelled", {
        queueId: "q-2",
        reason: "user",
      }),
    );
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-1", "q-3"]);

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-cancelled", {
        queueId: "q-1",
        reason: "stop",
      }),
    );
    // reason "stop" clears the whole line regardless of the one queueId.
    expect(session.queuedTurns.value).toHaveLength(0);
  });

  test("turn.promoted consumes the chip by queueId", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    for (const [queueId, blockId] of [
      ["q-a", "b-a"],
      ["q-b", "b-b"],
    ] as const) {
      session.blocks.value = [...session.blocks.value, userBlock(blockId)];
      session.reduce(
        queuedEvent(session.threadId.value, "turn.queued", {
          queueId,
          userBlockId: blockId,
          dispatchMode: "queue",
          position: 2,
        }),
      );
    }

    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", { queueId: "q-a", turnId: "t-1" }),
    );
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-b"]);
  });

  test("turn.steered is a no-op for the queue (the live turn took the nudge)", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.steered", { turnId: "t-live", message: "nudge" }),
    );
    expect(session.queuedTurns.value).toHaveLength(0);
    expect(session.error.value).toBeNull();
  });

  test("a send while busy parks a chip anchored to the pushed user block (browser dev)", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    const before = session.blocks.value.length;
    void session.send("do this next");

    expect(session.blocks.value.length).toBe(before + 1);
    const block = session.blocks.value[session.blocks.value.length - 1]!;
    expect(block.role).toBe("user");
    // The mock queue hands the renderer's own block id back as userBlockId,
    // so the chip anchors to the very block just pushed.
    const entry = session.queuedTurns.value[0]!;
    expect(entry.userBlockId).toBe(block.id);
    expect(entry.blockId).toBe(block.id);
    expect(entry.position).toBe(2);
  });

  test("events for other threads are ignored", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent("some-other-thread", "turn.queued", {
        queueId: "q-foreign",
        userBlockId: "b-x",
        dispatchMode: "queue",
        position: 2,
      }),
    );
    expect(session.queuedTurns.value).toHaveLength(0);
  });
});
