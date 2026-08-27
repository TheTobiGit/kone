import { describe, expect, test } from "bun:test";
import { useAgent, type UserBlock } from "./useAgent";
import type { AgentBaseEvent, RuntimeEvent } from "~/types/desktop";

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

type QueueEventType = "turn.queued" | "turn.queued-cancelled" | "turn.promoted" | "turn.steered";

function queuedEvent<T extends QueueEventType>(
  threadId: string,
  type: T,
  extra: Omit<Extract<RuntimeEvent, { type: T }>, keyof AgentBaseEvent | "type">,
): Extract<RuntimeEvent, { type: T }> {
  // SAFETY: test fixture — `extra` supplies every non-envelope field of the
  // one union member `T` names; the literals above pin the AgentBaseEvent half.
  return {
    threadId,
    provider: "codex",
    at: Date.now(),
    source: "kone.store",
    ...extra,
    type,
  } as Extract<RuntimeEvent, { type: T }>;
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

describe("useAgent single blank thread invariant", () => {
  test("newThread twice in a row leaves exactly one blank session", async () => {
    const { agent, session: initialBlank } = harness();
    expect(agent.sessions.value).toHaveLength(1);

    await agent.newThread();
    await agent.newThread();

    expect(agent.sessions.value).toHaveLength(1);
    expect(agent.sessions.value[0]?.key).toBe(initialBlank.key);
    expect(agent.activeKey.value).toBe(initialBlank.key);
  });

  test("newThread when active is non-blank creates exactly one blank and subsequent calls reuse it", async () => {
    const { agent, session: s0 } = harness();
    s0.blocks.value = [userBlock("b0", "first conversation")];

    await agent.newThread();
    expect(agent.sessions.value).toHaveLength(2);
    const blank = agent.sessions.value[1]!;
    expect(agent.activeKey.value).toBe(blank.key);

    await agent.newThread();
    expect(agent.sessions.value).toHaveLength(2);
    expect(agent.sessions.value[1]?.key).toBe(blank.key);
    expect(agent.activeKey.value).toBe(blank.key);
  });

  test("newThreadAt called while a blank exists at another position relocates it without spawning", async () => {
    const { agent, session: s0 } = harness();
    s0.blocks.value = [userBlock("b0", "thread 0")];

    // Create a non-blank second thread
    const s1Key = await agent.newThreadAt(1);
    const s1 = agent.sessions.value.find((s) => s.key === s1Key)!;
    s1.blocks.value = [userBlock("b1", "thread 1")];

    // Spawn a blank thread at index 2 -> [s0, s1, blank]
    const blankKey = await agent.newThreadAt(2);
    expect(agent.sessions.value).toHaveLength(3);
    expect(agent.sessions.value[2]?.key).toBe(blankKey);

    // Call newThreadAt(0) -> relocates blank to index 0: [blank, s0, s1]
    const relocatedKey = await agent.newThreadAt(0);
    expect(relocatedKey).toBe(blankKey);
    expect(agent.sessions.value).toHaveLength(3);
    expect(agent.sessions.value[0]?.key).toBe(blankKey);
    expect(agent.sessions.value[1]?.key).toBe(s0.key);
    expect(agent.sessions.value[2]?.key).toBe(s1.key);
    expect(agent.activeKey.value).toBe(blankKey);
  });

  test("a state seeded with two blank sessions collapses to one after newThread", async () => {
    const { agent, session: b1 } = harness();
    const { session: b2 } = harness();
    agent.sessions.value = [b1, b2];
    agent.activeKey.value = b1.key;
    expect(agent.sessions.value).toHaveLength(2);

    await agent.newThread();

    expect(agent.sessions.value).toHaveLength(1);
    expect(agent.sessions.value[0]?.key).toBe(b1.key);
    expect(agent.activeKey.value).toBe(b1.key);
  });

  test("a state seeded with two blank sessions collapses to one after newThreadAt", async () => {
    const { agent, session: s0 } = harness();
    s0.blocks.value = [userBlock("b0", "non-blank")];
    const { session: b1 } = harness();
    const { session: b2 } = harness();
    // Seed [s0, b1, b2]
    agent.sessions.value = [s0, b1, b2];
    agent.activeKey.value = s0.key;
    expect(agent.sessions.value).toHaveLength(3);

    // Calling newThreadAt(0) relocates b1 to index 0 and evicts b2
    const key = await agent.newThreadAt(0);
    expect(key).toBe(b1.key);
    expect(agent.sessions.value).toHaveLength(2);
    expect(agent.sessions.value[0]?.key).toBe(b1.key);
    expect(agent.sessions.value[1]?.key).toBe(s0.key);
    expect(agent.activeKey.value).toBe(b1.key);
  });

  test("two blank sessions pinned to studio panes both survive the blank collapse", async () => {
    const { agent, session: b1 } = harness();
    const { session: b2 } = harness();
    agent.sessions.value = [b1, b2];
    agent.activeKey.value = b1.key;
    agent.pinToPane(b1.key);
    agent.pinToPane(b2.key);

    await agent.newThread();

    expect(agent.sessions.value).toHaveLength(2);
    expect(agent.sessions.value.map((s) => s.key).sort()).toEqual([b1.key, b2.key].sort());
  });

  test("a pane-bound blank survives collapse while a genuinely orphaned blank is still pruned", async () => {
    const { agent, session: b1 } = harness();
    const { session: b2 } = harness();
    const { session: b3 } = harness();
    agent.sessions.value = [b1, b2, b3];
    agent.activeKey.value = b1.key;
    agent.pinToPane(b1.key);
    agent.pinToPane(b2.key);
    // b3 sits in no pane at all — nothing on screen references it.

    await agent.newThread();

    const keys = agent.sessions.value.map((s) => s.key);
    expect(keys).toContain(b1.key);
    expect(keys).toContain(b2.key);
    expect(keys).not.toContain(b3.key);
  });

  test("unpinning a blank makes it prunable again by a later collapse", async () => {
    const { agent, session: b1 } = harness();
    const { session: b2 } = harness();
    agent.sessions.value = [b1, b2];
    agent.activeKey.value = b1.key;
    agent.pinToPane(b2.key);

    await agent.newThread();
    expect(agent.sessions.value).toHaveLength(2);

    agent.unpinFromPane(b2.key);
    await agent.newThread();

    expect(agent.sessions.value).toHaveLength(1);
    expect(agent.sessions.value[0]?.key).toBe(b1.key);
  });

  test("non-blank sessions survive untouched across newThread and newThreadAt", async () => {
    const { agent, session: s0 } = harness();
    s0.blocks.value = [userBlock("b0", "important data")];
    s0.setModel("custom-model");
    s0.setMode("accept-edits");

    await agent.newThread();
    expect(agent.sessions.value).toHaveLength(2);
    expect(s0.blocks.value).toHaveLength(1);
    // SAFETY: s0.blocks was seeded with userBlock above
    expect((s0.blocks.value[0] as UserBlock)?.text).toBe("important data");
    expect(s0.model.value).toBe("custom-model");
    expect(s0.mode.value).toBe("accept-edits");

    await agent.newThreadAt(0);
    expect(agent.sessions.value).toHaveLength(2);
    expect(s0.blocks.value).toHaveLength(1);
    // SAFETY: s0.blocks was seeded with userBlock above
    expect((s0.blocks.value[0] as UserBlock)?.text).toBe("important data");
  });

  test("newThread inherits settings from previously-active non-blank session", async () => {
    const { agent, session: s0 } = harness();
    s0.blocks.value = [userBlock("b0", "first")];
    s0.setProvider("codex");
    s0.setModel("gpt-5-preview");
    s0.setMode("accept-edits");
    s0.setReasoning("high");

    await agent.newThread();
    const blank = agent.sessions.value.find((s) => s.key === agent.activeKey.value)!;
    expect(blank.provider.value).toBe("codex");
    expect(blank.model.value).toBe("gpt-5-preview");
    expect(blank.mode.value).toBe("accept-edits");
    expect(blank.reasoning.value).toBe("high");
  });
});
