import { beforeAll, describe, expect, test } from "bun:test";
import {
  clearOrphanApprovals,
  clearOrphanUserInputs,
  dropOrphanApproval,
  dropOrphanUserInput,
  normalizeComposerDraft,
  normalizeTurnDraft,
  parseQueuedAttachments,
  serializeQueuedAttachments,
  stashOrphanApproval,
  stashOrphanUserInput,
  takeOrphanApprovals,
  takeOrphanUserInputs,
  turnLabel,
  useAgent,
  type UserBlock,
} from "./useAgent";
import type { AgentBaseEvent, ChatAttachment, RuntimeEvent, Session } from "~/types/desktop";
import { createDevBridge } from "~/lib/devBridge";
import { installDevBridge } from "~/utils/desktopBridge";

// Sends with no bridge run on the dev bridge's scripted turn runner.
beforeAll(() => installDevBridge(createDevBridge()));

// The durable turn-queue slice (AgentService): a send while a turn runs is
// durably enqueued and announced on the runtime stream. These tests drive the
// session reducer with the queue events and assert the strip/timeline state the
// composer and thread view read.

let seq = 0;
function harness() {
  // A unique cwd per harness — the session registry is keyed by project path,
  // so each test gets a fresh blank thread.
  const agent = useAgent({ provider: "codex", cwd: `/tmp/kone-queue-test-${seq++}`, rehydrate: false });
  const session = agent.sessions.value[0]!;
  return { agent, session };
}

type QueueEventType =
  | "turn.queued"
  | "turn.queued-updated"
  | "turn.queued-cancelled"
  | "turn.promoted"
  | "turn.steered"
  | "turn.queued-reordered";

function queuedEvent<T extends QueueEventType>(
  threadId: string,
  type: T,
  extra: Omit<Extract<RuntimeEvent, { type: T }>, keyof AgentBaseEvent | "type">,
): Extract<RuntimeEvent, { type: T }> {
  // SAFETY: test fixture — `extra` supplies every non-envelope field of the
  // one union member `T` names; the literals above pin the AgentBaseEvent half.
  const event = {
    threadId,
    provider: "codex",
    at: Date.now(),
    source: "kone.store",
    ...extra,
    type,
  } as Extract<RuntimeEvent, { type: T }>;
  // The store says who wrote every queued row it announces; these rows are
  // the user's own sends unless a test says otherwise.
  const runtime: RuntimeEvent = event;
  if (runtime.type === "turn.queued" && !runtime.sender) runtime.sender = { kind: "user" };
  return event;
}

function userBlock(id: string, text = "follow-up"): UserBlock {
  return { id, role: "user", text, at: Date.now() };
}

describe("useAgent durable turn queue", () => {
  test("turn.queued parks a row anchored to the store block by userBlockId", () => {
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

  test("queued rows read 1, 2 in arrival order", () => {
    const { session } = harness();
    session.sessionState.value = "running";
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
      ["q-a", 1],
      ["q-b", 2],
    ]);
  });

  test("reorderQueuedTurns updates order in queuedTurns", async () => {
    const { session } = harness();
    session.sessionState.value = "running";
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-1",
        userBlockId: "b-1",
        dispatchMode: "queue",
        position: 1,
        input: "first",
      }),
    );
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-2",
        userBlockId: "b-2",
        dispatchMode: "queue",
        position: 2,
        input: "second",
      }),
    );

    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-1", "q-2"]);
    expect(session.queuedTurns.value.map((q) => q.position)).toEqual([1, 2]);

    await session.reorderQueuedTurns(["q-2", "q-1"]);

    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-2", "q-1"]);
    expect(session.queuedTurns.value.map((q) => q.position)).toEqual([1, 2]);
    expect(session.queuedTurns.value.map((q) => q.input)).toEqual(["second", "first"]);
  });

  test("a late turn.queued with a stale position appends after a reorder", async () => {
    const { session } = harness();
    session.sessionState.value = "running";
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-1",
        userBlockId: "b-1",
        dispatchMode: "queue",
        position: 1,
        input: "first",
      }),
    );
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-2",
        userBlockId: "b-2",
        dispatchMode: "queue",
        position: 2,
        input: "second",
      }),
    );

    await session.reorderQueuedTurns(["q-2", "q-1"]);
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-2", "q-1"]);

    // A late arrival carrying a stale backend position (1 — salvaged from
    // before the reorder) must not jump ahead of the reordered line: arrival
    // order wins, and the display computed renumbers from array order.
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-3",
        userBlockId: "b-3",
        dispatchMode: "queue",
        position: 1,
        input: "third",
      }),
    );
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-2", "q-1", "q-3"]);
    expect(session.queuedTurns.value.map((q) => q.position)).toEqual([1, 2, 3]);

    // The shared order helper drives the backend's reordered event too: ids
    // missing from the order list sort last and keep their relative order.
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-reordered", {
        queueIds: ["q-3", "q-1"],
      }),
    );
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-3", "q-1", "q-2"]);
  });

  test("an unanchored row (no matching block) still parks, from its own input", () => {
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

  test("turn.queued-cancelled (user) removes one row; (stop) clears the line", () => {
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

  test("turn.promoted consumes the row by queueId and reveals its block", () => {
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
    // The promoted prompt joins the visible timeline; the still-queued one stays out.
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-a"]);
  });

  test("a queued follow-up stays out of the timeline until it promotes", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    session.blocks.value = [...session.blocks.value, userBlock("b-live", "live turn")];
    session.blocks.value = [...session.blocks.value, userBlock("b-q", "queued follow-up")];
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-1",
        userBlockId: "b-q",
        dispatchMode: "queue",
        position: 2,
      }),
    );

    // The strip owns the waiting state — the thread only shows started turns.
    expect(session.blocks.value.map((b) => b.id)).toEqual(["b-live", "b-q"]);
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-live"]);

    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", { queueId: "q-1", turnId: "t-1" }),
    );
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-live", "b-q"]);
  });

  test("cancelling a queued follow-up drops its optimistic block with it", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    session.blocks.value = [...session.blocks.value, userBlock("b-live", "live turn")];
    session.blocks.value = [...session.blocks.value, userBlock("b-q", "queued follow-up")];
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-1",
        userBlockId: "b-q",
        dispatchMode: "queue",
        position: 2,
      }),
    );

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-cancelled", {
        queueId: "q-1",
        reason: "user",
      }),
    );
    // A prompt that never ran must not pop into the thread on cancel.
    expect(session.blocks.value.map((b) => b.id)).toEqual(["b-live"]);
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-live"]);
  });

  test("turn.steered is a no-op for the queue (the live turn took the nudge)", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.steered", { turnId: "t-live", message: "nudge" }),
    );
    expect(session.queuedTurns.value).toHaveLength(0);
    expect(session.error.value).toBeNull();
  });

  test("a send while busy parks a row anchored to the pushed user block (browser dev)", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    const before = session.blocks.value.length;
    void session.send("do this next");

    // A queued turn stays out of blocks.value until promoted, so it cannot interleave
    // ahead of running or previous assistant turns.
    expect(session.blocks.value.length).toBe(before);
    const entry = session.queuedTurns.value[0]!;
    expect(entry.input).toBe("do this next");
    expect(entry.position).toBe(1);
    expect(session.timelineBlocks.value.map((b) => b.id)).not.toContain(entry.userBlockId);

    // On promotion, unhides in timeline
    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: entry.queueId,
        turnId: "t-promoted",
      }),
    );
    expect(session.timelineBlocks.value.map((b) => b.id)).toContain(entry.userBlockId);
    expect(session.queuedTurns.value).toHaveLength(0);
  });

  test("live turn.queued skills ride the row and land on the promoted block", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    const skills = [{ name: "animate-text", path: "/home/u/.codex/skills/animate-text/SKILL.md" }];
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-sk",
        userBlockId: "ub-sk",
        dispatchMode: "queue",
        position: 1,
        input: "",
        skills,
      }),
    );
    expect(session.queuedTurns.value[0]?.skills).toEqual(skills);

    session.reduce(queuedEvent(session.threadId.value, "turn.promoted", { queueId: "q-sk", turnId: "t-1" }));
    const block = session.timelineBlocks.value.find((b) => b.id === "ub-sk");
    expect(block?.role).toBe("user");
    if (block?.role === "user") {
      expect(block.text).toBe("");
      expect(block.skills).toEqual(skills);
    }
  });

  test("a queued turn without skills promotes without the field", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-plain",
        userBlockId: "ub-plain",
        dispatchMode: "queue",
        position: 1,
        input: "plain",
        skills: [],
      }),
    );
    expect(session.queuedTurns.value[0]?.skills).toBeUndefined();
    session.reduce(queuedEvent(session.threadId.value, "turn.promoted", { queueId: "q-plain", turnId: "t-1" }));
    const block = session.timelineBlocks.value.find((b) => b.id === "ub-plain");
    expect(block?.role === "user" ? block.skills : "not a user block").toBeUndefined();
  });

  test("live turn.queued attachments survive promotion", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    const attachmentsJson = JSON.stringify([
      { type: "file", id: "a1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 },
    ]);
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-att",
        userBlockId: "ub-att",
        dispatchMode: "queue",
        position: 1,
        input: "with file",
        attachmentsJson,
      }),
    );
    const entry = session.queuedTurns.value[0]!;
    expect(entry.attachments?.map((a) => a.id)).toEqual(["a1"]);
    // Nothing was ever pushed to blocks — the row is the only copy.
    expect(session.blocks.value.map((b) => b.id)).not.toContain("ub-att");

    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: "q-att",
        turnId: "t-1",
      }),
    );
    const block = session.timelineBlocks.value.find((b) => b.id === "ub-att")!;
    expect(block?.role).toBe("user");
    if (block?.role === "user") {
      expect(block.attachments?.map((a) => a.id)).toEqual(["a1"]);
      expect(block.text).toBe("with file");
    }
  });

  test("busy send with attachments parks them on the live row (browser dev)", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    void session.send("with file", [
      { type: "file", id: "a2", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 },
    ]);
    const entry = session.queuedTurns.value[0]!;
    expect(entry.input).toBe("with file");
    expect(entry.attachments?.map((a) => a.id)).toEqual(["a2"]);

    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: entry.queueId,
        turnId: "t-promoted",
      }),
    );
    const block = session.timelineBlocks.value.find((b) => b.id === entry.userBlockId)!;
    expect(block?.role).toBe("user");
    if (block?.role === "user") {
      expect(block.attachments?.map((a) => a.id)).toEqual(["a2"]);
    }
  });

  test("spamming queued messages preserves strict turn-by-turn timeline order", () => {
    const { session } = harness();
    // Turn 1 is active
    session.blocks.value = [userBlock("b-1", "prompt 1")];
    session.sessionState.value = "running";
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.started",
      turnId: "turn-1",
    });

    // While Turn 1 is running, user spams prompt 2 and prompt 3
    void session.send("😂😂");
    void session.send("😂");

    expect(session.queuedTurns.value).toHaveLength(2);
    expect(session.queuedTurns.value.map((q) => q.input)).toEqual(["😂😂", "😂"]);

    // At this moment, blocks.value has only prompt 1 and turn-1 assistant
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual([
      session.blocks.value[0]!.id,
      "turn-1",
    ]);

    // Turn 1 completes
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.completed",
      turnId: "turn-1",
    });

    // Prompt 2 promotes and starts
    const q2 = session.queuedTurns.value[0]!;
    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: q2.queueId,
        turnId: "turn-2",
      }),
    );
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.started",
      turnId: "turn-2",
    });

    // Turn 2 completes
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.completed",
      turnId: "turn-2",
    });

    // Prompt 3 promotes and starts
    const q3 = session.queuedTurns.value[0]!;
    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: q3.queueId,
        turnId: "turn-3",
      }),
    );
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.started",
      turnId: "turn-3",
    });

    // Check alternating user/assistant sequence in both blocks and timelineBlocks
    const roles = session.timelineBlocks.value.map((b) => b.role);
    expect(roles).toEqual(["user", "assistant", "user", "assistant", "user", "assistant"]);

    const texts = session.timelineBlocks.value
      .filter((b): b is Extract<typeof b, { role: "user" }> => b.role === "user")
      .map((b) => b.text);
    expect(texts).toEqual(["prompt 1", "😂😂", "😂"]);
  });

  test("idle-push race: turn.started lands before an already-queued follow-up", () => {
    const { session } = harness();
    // Two rapid idle sends: the second pushes before the first turn's
    // turn.started folds (busy still reads idle — dispatch cleared, no running
    // state yet). The backend queues the second push behind the first turn,
    // then the first turn starts while the queued block is still in blocks.
    session.blocks.value = [
      ...session.blocks.value,
      userBlock("b-first", "first"),
      userBlock("b-second", "second"),
    ];
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-second",
        userBlockId: "b-second",
        dispatchMode: "queue",
        position: 2,
        input: "second",
      }),
    );
    // The follow-up hides until it promotes.
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-first"]);

    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "turn.started",
      turnId: "turn-1",
    });

    // The running turn's assistant belongs to the active turn: after its own
    // prompt, before the follow-up that has not run yet. A plain append would
    // leave ["b-first", "b-second", "turn-1"].
    expect(session.blocks.value.map((b) => b.id)).toEqual(["b-first", "turn-1", "b-second"]);
    expect(session.timelineBlocks.value.map((b) => b.id)).toEqual(["b-first", "turn-1"]);
  });


  test("turn.queued follows the backend's run order, not arrival", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-plain",
        userBlockId: "b-plain",
        dispatchMode: "queue",
        position: 1,
        input: "plain",
      }),
    );
    // A steer row claims ahead of plain follow-ups, so it lands first.
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q-steer",
        userBlockId: "b-steer",
        dispatchMode: "steer",
        position: 2,
        input: "steer",
        order: ["q-steer", "q-plain"],
      }),
    );
    expect(session.queuedTurns.value.map((q) => q.queueId)).toEqual(["q-steer", "q-plain"]);
  });

  test("turn.queued-updated moves a row's status without moving the row", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q1",
        userBlockId: "b1",
        dispatchMode: "queue",
        position: 1,
        input: "hello",
      }),
    );
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-updated", {
        queueId: "q1",
        state: "queued",
        attemptCount: 1,
        retryAt: 123,
        error: "provider is down",
      }),
    );
    expect(session.queuedTurns.value[0]).toMatchObject({ state: "queued", retryAt: 123, error: "provider is down" });

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-updated", { queueId: "q1", state: "promoting", attemptCount: 2 }),
    );
    const claimed = session.queuedTurns.value[0]!;
    expect(claimed.state).toBe("promoting");
    expect(claimed.retryAt).toBeUndefined();
    expect(claimed.error).toBeUndefined();

    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued-updated", {
        queueId: "q1",
        state: "failed",
        attemptCount: 4,
        error: "provider is down",
      }),
    );
    expect(session.queuedTurns.value.map((q) => [q.queueId, q.state])).toEqual([["q1", "failed"]]);
  });

  test("a Stop hands the queued messages back for the composer, in queue order", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    const file = { type: "file" as const, id: "a1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 3 };
    const skill = { name: "review", path: "/skills/review/SKILL.md" };
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q1",
        userBlockId: "b1",
        dispatchMode: "queue",
        position: 1,
        input: "first thing",
        attachmentsJson: JSON.stringify([file]),
      }),
    );
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q2",
        userBlockId: "b2",
        dispatchMode: "queue",
        position: 2,
        input: "second thing",
        skills: [skill],
      }),
    );
    for (const queueId of ["q1", "q2"]) {
      session.reduce(queuedEvent(session.threadId.value, "turn.queued-cancelled", { queueId, reason: "stop" }));
    }

    expect(session.queuedTurns.value).toHaveLength(0);
    expect(session.queueReturn.value).toMatchObject({
      text: "first thing\n\nsecond thing",
      attachments: [file],
      skills: [skill],
    });
  });

  test("a user removal hands nothing back", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q1",
        userBlockId: "b1",
        dispatchMode: "queue",
        position: 1,
        input: "gone",
      }),
    );
    session.reduce(queuedEvent(session.threadId.value, "turn.queued-cancelled", { queueId: "q1", reason: "user" }));
    expect(session.queueReturn.value).toBeNull();
  });

  test("a busy steer puts its block in the transcript at once (browser dev)", () => {
    const { session } = harness();
    session.sessionState.value = "running";
    void session.steerTurn("look at the tests too");
    // The dev runner has no live steer channel, so this one fell back to the
    // queue: its block is there under the row's id, hidden until it runs.
    const row = session.queuedTurns.value[0]!;
    expect(row.dispatchMode).toBe("steer");
    const pushed = session.blocks.value.find((b) => b.id === row.userBlockId)!;
    expect(pushed.role === "user" && pushed.text).toBe("look at the tests too");
    expect(session.timelineBlocks.value.map((b) => b.id)).not.toContain(pushed.id);
  });

  test("turn.steered marks the block the provider took into the live turn", () => {
    const { session } = harness();
    session.blocks.value = [...session.blocks.value, userBlock("ub-steer", "nudge")];
    session.reduce(
      queuedEvent(session.threadId.value, "turn.steered", { turnId: "t-live", message: "nudge", userBlockId: "ub-steer" }),
    );
    const marked = session.timelineBlocks.value.find((b) => b.id === "ub-steer")!;
    expect(marked.role === "user" && marked.steered).toBe(true);
  });

  test("a queued row sent now into the live turn promotes as a steered block", () => {
    const { session } = harness();
    session.reduce(
      queuedEvent(session.threadId.value, "turn.queued", {
        queueId: "q1",
        userBlockId: "ub-1",
        dispatchMode: "queue",
        position: 1,
        input: "sent now",
      }),
    );
    // The adapter announces the steer before the service settles the row.
    session.reduce(
      queuedEvent(session.threadId.value, "turn.steered", { turnId: "t-live", message: "sent now", userBlockId: "ub-1" }),
    );
    session.reduce(queuedEvent(session.threadId.value, "turn.promoted", { queueId: "q1", turnId: "t-live" }));

    const block = session.timelineBlocks.value.find((b) => b.id === "ub-1")!;
    expect(block.role === "user" && block.steered).toBe(true);
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

describe("useAgent: a session that ends on its own", () => {
  /** A session the provider brought up, as start() would have kept it. */
  function live(threadId: string): Session {
    return { threadId, provider: "codex", cwd: "/tmp", status: "ready", mode: "ask" };
  }
  function exited(threadId: string): RuntimeEvent {
    return { type: "session.exited", threadId, provider: "codex", at: Date.now(), source: "codex.rpc.lifecycle", code: 1 };
  }

  test("the next send starts it again instead of going to the dead one", () => {
    const { session } = harness();
    session.session.value = live(session.threadId.value);

    session.reduce(exited(session.threadId.value));

    // Kept, ensureStarted() was a no-op and every send went to a session
    // nothing would answer from.
    expect(session.session.value).toBeNull();
    expect(session.unstarted.value).toBe(true);
    expect(session.sessionState.value).toBe("stopped");
  });

  test("an exit from another provider leaves the live session up", () => {
    const { session } = harness();
    session.session.value = live(session.threadId.value);
    session.sessionState.value = "ready";

    // A Claude session this thread was handed off from, ending late.
    session.reduce({ ...exited(session.threadId.value), provider: "claudeAgent", source: "claude.sdk.lifecycle" });

    expect(session.session.value).not.toBeNull();
    expect(session.unstarted.value).toBe(false);
    expect(session.sessionState.value).toBe("ready");
  });

  test("an exit naming a conversation the session left leaves the live session up", () => {
    const { session } = harness();
    session.session.value = { ...live(session.threadId.value), conversationId: "conv-now" };

    session.reduce({ ...exited(session.threadId.value), refs: { conversationId: "conv-before" } });

    expect(session.session.value).not.toBeNull();
    expect(session.unstarted.value).toBe(false);
  });

  test("a disposed thread is not re-armed by its own stop", async () => {
    const { session } = harness();
    await session.dispose();
    session.session.value = live(session.threadId.value);

    session.reduce(exited(session.threadId.value));

    expect(session.unstarted.value).toBe(false);
  });
});

describe("useAgent token usage reducer", () => {
  test("compacted boundary resets contextUsed to afterTokens, preserving window and total", () => {
    const { session } = harness();
    session.tokenUsage.value = {
      total: 120000,
      contextUsed: 95000,
      contextWindow: 200000,
      compactsAutomatically: true,
    };

    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "thread.state.changed",
      state: "compacted",
      beforeTokens: 95000,
      afterTokens: 8000,
    });

    expect(session.tokenUsage.value).toMatchObject({
      total: 120000,
      contextUsed: 8000,
      contextWindow: 200000,
      compactsAutomatically: true,
    });
  });

  test("compacted boundary without counts leaves contextUsed unknown with window preserved", () => {
    const { session } = harness();
    session.tokenUsage.value = {
      total: 50000,
      contextUsed: 60000,
      contextWindow: 128000,
    };

    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "thread.state.changed",
      state: "compacted",
    });

    // Unknown stays unknown — the store reports an uncounted compaction as
    // NULL, and the meter hides its ring then instead of lying 0%.
    expect(session.tokenUsage.value).toMatchObject({
      total: 50000,
      contextWindow: 128000,
    });
    expect(session.tokenUsage.value?.contextUsed).toBeUndefined();
  });

  test("total keeps the seeded lifetime across a smaller per-turn update", () => {
    const { session } = harness();
    session.tokenUsage.value = {
      total: 120000,
      contextUsed: 40000,
      contextWindow: 200000,
    };

    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "thread.token-usage.updated",
      usage: { total: 900, contextUsed: 41000 },
    });

    // The per-turn tally merges its fields but must not pull the lifetime down.
    expect(session.tokenUsage.value).toMatchObject({
      total: 120000,
      contextUsed: 41000,
      contextWindow: 200000,
    });

    // A growing running total still advances.
    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "thread.token-usage.updated",
      usage: { total: 130000 },
    });
    expect(session.tokenUsage.value?.total).toBe(130000);
  });

  test("per-turn reporters accumulate onto the seeded lifetime", () => {
    const { session } = harness();
    session.tokenUsage.value = {
      total: 120000,
      contextUsed: 40000,
      contextWindow: 200000,
    };

    session.reduce({
      threadId: session.threadId.value,
      provider: "claudeAgent",
      at: Date.now(),
      source: "kone.store",
      type: "thread.token-usage.updated",
      usage: { total: 900, contextUsed: 41000 },
    });

    // Claude reports one turn's spend — the lifetime grows by it instead of
    // taking the max, which would pin the total at the seeded value forever.
    expect(session.tokenUsage.value).toMatchObject({
      total: 120900,
      contextUsed: 41000,
      contextWindow: 200000,
    });
  });

  test("compacted boundary appends a timeline marker", () => {
    const { session } = harness();
    expect(session.compactions.value).toEqual([]);

    session.reduce({
      threadId: session.threadId.value,
      provider: "codex",
      at: 1710000000000,
      source: "kone.store",
      type: "thread.state.changed",
      state: "compacted",
      beforeTokens: 95000,
      afterTokens: 8000,
    });

    expect(session.compactions.value).toEqual([
      {
        threadId: session.threadId.value,
        at: 1710000000000,
        beforeTokens: 95000,
        afterTokens: 8000,
      },
    ]);
  });
});

describe("orphaned user-input recovery (reload race)", () => {
  function asked(
    threadId: string,
    requestId: string,
  ): Extract<RuntimeEvent, { type: "user-input.requested" }> {
    return {
      threadId,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "user-input.requested",
      requestId,
      questions: [],
    };
  }

  test("a replayed ask stashed before its thread is claimed drains on take", () => {
    stashOrphanUserInput(asked("thread-reload-1", "r1"));
    // The delayed second replay pass re-sends the same ask — it replaces.
    stashOrphanUserInput(asked("thread-reload-1", "r1"));
    const drained = takeOrphanUserInputs("thread-reload-1");
    expect(drained).toHaveLength(1);
    expect(takeOrphanUserInputs("thread-reload-1")).toHaveLength(0);
  });

  test("a resolve arriving before the claim drops the stashed ask", () => {
    stashOrphanUserInput(asked("thread-reload-2", "r1"));
    dropOrphanUserInput("thread-reload-2", "r1");
    expect(takeOrphanUserInputs("thread-reload-2")).toHaveLength(0);
  });

  test("an aborted turn clears the stashed ask", () => {
    stashOrphanUserInput(asked("thread-reload-3", "r1"));
    clearOrphanUserInputs("thread-reload-3");
    expect(takeOrphanUserInputs("thread-reload-3")).toHaveLength(0);
  });
});

describe("orphaned approval recovery (reload race)", () => {
  function gate(
    threadId: string,
    requestId: string,
  ): Extract<RuntimeEvent, { type: "approval.requested" }> {
    return {
      threadId,
      provider: "codex",
      at: Date.now(),
      source: "kone.store",
      type: "approval.requested",
      requestId,
      approval: { kind: "command", title: "rm -rf /tmp/stale" },
    };
  }

  test("a replayed gate stashed before its thread is claimed drains on take", () => {
    stashOrphanApproval(gate("thread-gate-1", "g1"));
    // The delayed second replay pass re-sends the same ask — it replaces.
    stashOrphanApproval(gate("thread-gate-1", "g1"));
    const drained = takeOrphanApprovals("thread-gate-1");
    expect(drained).toHaveLength(1);
    expect(takeOrphanApprovals("thread-gate-1")).toHaveLength(0);
  });

  test("a resolve arriving before the claim drops the stashed gate", () => {
    stashOrphanApproval(gate("thread-gate-2", "g1"));
    dropOrphanApproval("thread-gate-2", "g1");
    expect(takeOrphanApprovals("thread-gate-2")).toHaveLength(0);
  });

  test("an aborted turn clears the stashed gate", () => {
    stashOrphanApproval(gate("thread-gate-3", "g1"));
    clearOrphanApprovals("thread-gate-3");
    expect(takeOrphanApprovals("thread-gate-3")).toHaveLength(0);
  });

  test("claiming a stored thread folds stashed gates into pendingApprovals", async () => {
    const { session } = harness();
    stashOrphanApproval(gate("thread-gate-claim", "g1"));
    await session.openStored("thread-gate-claim");
    expect(session.threadId.value).toBe("thread-gate-claim");
    expect(session.pendingApprovals.value).toHaveLength(1);
    expect(session.pendingApprovals.value[0]?.requestId).toBe("g1");
    // Drained exactly once — nothing left behind to re-fold on a later claim.
    expect(takeOrphanApprovals("thread-gate-claim")).toHaveLength(0);
  });

  test("folding the same gate twice replaces instead of stacking", () => {
    const { session } = harness();
    const evt = gate(session.threadId.value, "g1");
    session.reduce(evt);
    session.reduce(evt);
    expect(session.pendingApprovals.value).toHaveLength(1);
  });
});

describe("useAgent compactThread", () => {
  test("without a bridge it reports unavailable instead of throwing", async () => {
    const { session } = harness();
    await session.compactThread();
    expect(session.compacting.value).toBe(false);
    expect(session.compactError.value).toBe("Compaction isn't available here.");
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

  test("session initializes mode from DEFAULT_MODE_KEY when configured", () => {
    const store = new Map<string, string>();
    const mockStorage: Storage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => {
        store.set(k, String(v));
      },
      removeItem: (k: string) => {
        store.delete(k);
      },
      clear: () => {
        store.clear();
      },
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };
    globalThis.localStorage = mockStorage;
    localStorage.setItem("kone:default-mode", "full-access");
    const cwd = `/tmp/kone-default-mode-test-${seq++}`;
    const agent = useAgent({ provider: "codex", cwd, rehydrate: false });
    const session = agent.sessions.value[0]!;
    expect(session.mode.value).toBe("full-access");
  });
});

describe("TurnDraft object param", () => {
  test("turnLabel prefers text, then skill, then file, then empty", () => {
    expect(turnLabel({ text: "  hello  " })).toBe("hello");
    expect(
      turnLabel({
        text: "   ",
        skills: [{ name: "animate-text", path: "/s/animate-text/SKILL.md" }],
        attachments: [{ type: "file", id: "a1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 }],
      }),
    ).toBe("animate-text");
    expect(
      turnLabel({
        text: "",
        attachments: [{ type: "file", id: "a1", name: "notes.txt", mimeType: "text/plain", sizeBytes: 1 }],
      }),
    ).toBe("notes.txt");
    expect(turnLabel({ text: "   " })).toBe("");
  });

  test("normalizeTurnDraft folds legacy positionals and prefers the object", () => {
    expect(normalizeTurnDraft("hi")).toEqual({ text: "hi" });
    expect(
      normalizeTurnDraft("hi", [{ type: "file", id: "a1", name: "n.txt", mimeType: "text/plain", sizeBytes: 1 }]),
    ).toEqual({
      text: "hi",
      attachments: [{ type: "file", id: "a1", name: "n.txt", mimeType: "text/plain", sizeBytes: 1 }],
    });
    const skills = [{ name: "s", path: "/s/SKILL.md" }];
    expect(normalizeTurnDraft({ text: "obj", skills })).toEqual({ text: "obj", skills });
    // An object wins over positionals arriving alongside it.
    expect(normalizeTurnDraft({ text: "obj" }, undefined, skills)).toEqual({ text: "obj", skills });
    const file = new File(["x"], "f.txt", { type: "text/plain" });
    expect(normalizeComposerDraft("hi", [file], skills)).toEqual({ text: "hi", files: [file], skills });
  });

  test("idle send accepts the draft object like the legacy positionals", () => {
    const { session } = harness();
    void session.send({ text: "object send" });
    const users = session.blocks.value.filter((b) => b.role === "user");
    const last = users[users.length - 1]!;
    expect(last.text).toBe("object send");
  });

  test("busy send with the draft object parks input, files and skills (browser dev)", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    const skills = [{ name: "animate-text", path: "/home/u/.codex/skills/animate-text/SKILL.md" }];
    void session.send({
      text: "",
      attachments: [{ type: "file", id: "a9", name: "notes.txt", mimeType: "text/plain", sizeBytes: 10 }],
      skills,
    });
    const entry = session.queuedTurns.value[0]!;
    expect(entry.input).toBe("");
    expect(entry.attachments?.map((a) => a.id)).toEqual(["a9"]);
    expect(entry.skills).toEqual(skills);

    session.reduce(
      queuedEvent(session.threadId.value, "turn.promoted", {
        queueId: entry.queueId,
        turnId: "t-promoted",
      }),
    );
    const block = session.timelineBlocks.value.find((b) => b.id === entry.userBlockId)!;
    expect(block?.role).toBe("user");
    if (block?.role === "user") {
      expect(block.attachments?.map((a) => a.id)).toEqual(["a9"]);
      expect(block.skills).toEqual(skills);
    }
  });

  test("busy steer with the draft object parks on the steer lane", () => {
    const { session } = harness();
    session.sessionState.value = "running"; // busy
    void session.steerTurn({ text: "nudge it" });
    const entry = session.queuedTurns.value[0]!;
    expect(entry.input).toBe("nudge it");
    expect(entry.dispatchMode).toBe("steer");
  });

  test("serializeQueuedAttachments round-trips through parseQueuedAttachments", () => {
    expect(serializeQueuedAttachments(undefined)).toBeNull();
    expect(serializeQueuedAttachments([])).toBeNull();
    const attachments: ChatAttachment[] = [
      { type: "file", id: "a1", name: "n.txt", mimeType: "text/plain", sizeBytes: 1 },
    ];
    const json = serializeQueuedAttachments(attachments);
    expect(parseQueuedAttachments(json)?.map((a) => a.id)).toEqual(["a1"]);
    expect(parseQueuedAttachments("not-json")).toBeUndefined();
  });
});
