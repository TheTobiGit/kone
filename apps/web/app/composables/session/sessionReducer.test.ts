import { describe, expect, test } from "bun:test";
import { ref, type Ref } from "vue";

import {
  mergeQueueReturn,
  queuedBlockIdsOf,
  parseQueuedAttachments,
  sortQueuedByIds,
  usersOwnQueuedRows,
} from "./sessionQueue";
import { useSessionReducer } from "./sessionReducer";
import type { QueuedTurnEntry, ThreadBlock } from "../agentTypes";
import type {
  CompactionRecord,
  MessageSender,
  RuntimeEvent,
  RuntimeSessionState,
  SpawnedThread,
  TokenUsage,
} from "~/types/desktop";
import type { WorkspaceStepRow } from "~/utils/workspaceSteps";
import type { PendingApproval, PendingUserInput, QueueReturn } from "../agentTypes";

/** The reducer's deps are plain refs and pure helpers, so a session is just
 *  this — no bridge, no adapter, no store. */
function makeSession() {
  const blocks: Ref<ThreadBlock[]> = ref([]);
  const threadId = ref("t");
  const queuedTurnsRaw: Ref<QueuedTurnEntry[]> = ref([]);
  const queueReturn: Ref<QueueReturn | null> = ref(null);
  /** What the reducer told the session about its provider conversation. */
  const conversations: string[] = [];
  const cursors: string[] = [];
  const exits = { count: 0 };
  const deps = {
    blocks,
    threadId,
    touch: () => {},
    noteRefs: (_provider: string, refs: { conversationId?: string; resumeSessionAt?: string }) => {
      if (refs.conversationId) conversations.push(refs.conversationId);
      if (refs.resumeSessionAt) cursors.push(refs.resumeSessionAt);
    },
    ownsExit: () => true,
    noteSessionExited: () => {
      exits.count++;
    },
    sessionState: ref<RuntimeSessionState>("ready"),
    warning: ref<string | null>(null),
    error: ref<string | null>(null),
    model: ref<string | undefined>(undefined),
    tokenUsage: ref<TokenUsage | null>(null),
    title: ref("t"),
    workspaceSteps: ref<WorkspaceStepRow[]>([]),
    everRan: ref(false),
    spawnedChildren: ref<SpawnedThread[]>([]),
    queuedTurnsRaw,
    queueReturn,
    mergeQueueReturn,
    pendingQueueAnchors: new Map<string, string>(),
    parkedUserInput: ref<PendingUserInput | null>(null),
    pendingApprovals: ref<PendingApproval[]>([]),
    anchorFor: () => undefined,
    queuedBlockIdsOf,
    usersOwnQueuedRows,
    sortQueuedByIds,
    parseQueuedAttachments,
    noteCompactedBoundary: (_marker: CompactionRecord) => {},
  };
  return { blocks, queuedTurnsRaw, queueReturn, conversations, cursors, exits, reduce: useSessionReducer(deps).reduce };
}

const base = { threadId: "t", provider: "opencode", source: "kone.store" } as const;

function turnStarted(turnId: string, at: number): RuntimeEvent {
  return { ...base, type: "turn.started", turnId, at };
}

function turnQueued(input: string, at: number): RuntimeEvent {
  return {
    ...base,
    type: "turn.queued",
    queueId: "q-1",
    userBlockId: "ub-2",
    dispatchMode: "queue",
    position: 1,
    input,
    at,
  };
}

/** `turnId` is omitted when the adapter doesn't name the turn until its
 *  turn.started, so the reducer has to cope without it. */
function turnPromoted(at: number, turnId?: string): Extract<RuntimeEvent, { type: "turn.promoted" }> {
  const event: Extract<RuntimeEvent, { type: "turn.promoted" }> = {
    ...base,
    type: "turn.promoted",
    queueId: "q-1",
    at,
  };
  if (turnId) event.turnId = turnId;
  return event;
}

/** The transcript as a user reads it: each user block by its own words, each
 *  assistant block by the turn that produced it. */
function timeline(blocks: Ref<ThreadBlock[]>): string[] {
  return blocks.value.map((b) =>
    b.role === "user" ? `user: ${b.text}` : `assistant: ${b.turnId}`,
  );
}

describe("a promoted queued turn lands before its own reply", () => {
  /** The real event order, which is the whole point: the adapter announces
   *  turn.started from inside sendTurn, so the reply's block folds BEFORE the
   *  row settles as promoted. */
  function promotedSession(promoted: () => RuntimeEvent) {
    const session = makeSession();
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(turnQueued("you good?", 200));
    // The drain: the provider takes the row and announces its turn, then the
    // row settles.
    session.reduce(turnStarted("turn-2", 310));
    session.reduce(promoted());
    return session;
  }

  test("the prompt reads before the reply it produced", () => {
    const session = promotedSession(() => turnPromoted(320, "turn-2"));
    expect(timeline(session.blocks)).toEqual([
      "assistant: turn-1",
      "user: you good?",
      "assistant: turn-2",
    ]);
  });

  test("the promoted turn leaves the queue, so the prompt is no longer hidden", () => {
    const session = promotedSession(() => turnPromoted(320, "turn-2"));
    expect(session.queuedTurnsRaw.value).toEqual([]);
    expect(queuedBlockIdsOf(session.queuedTurnsRaw.value).size).toBe(0);
  });

  test("without the row's turn id the prompt still goes to the tail", () => {
    const session = promotedSession(() => turnPromoted(320));
    expect(timeline(session.blocks)).toEqual([
      "assistant: turn-1",
      "assistant: turn-2",
      "user: you good?",
    ]);
  });

  test("a row sent now as a steer splits the live reply it joined", () => {
    const session = makeSession();
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(itemEvent("turn-1", "i-1", "Looking"));
    session.reduce(turnQueued("you good?", 200));
    // Send now into the live turn: the adapter announces the steer, then the
    // row settles with the LIVE turn's id — not a new turn's.
    session.reduce(steered("turn-1", "ub-2", 300));
    session.reduce(turnPromoted(320, "turn-1"));
    expect(timeline(session.blocks)).toEqual([
      "assistant: turn-1",
      "user: you good?",
      "assistant: turn-1",
    ]);
  });
});

function itemEvent(turnId: string, itemId: string, text: string, type: "item.started" | "item.updated" = "item.started"): RuntimeEvent {
  return {
    ...base,
    type,
    turnId,
    item: { itemId, kind: "assistant_text", status: "in-progress", text },
    at: 0,
  };
}

function steered(turnId: string, userBlockId: string, at: number): RuntimeEvent {
  return { ...base, type: "turn.steered", turnId, message: "", userBlockId, at };
}

/** A user block on screen the way steerTurn pushes one: at the tail. */
function pushUser(session: ReturnType<typeof makeSession>, id: string, text: string, at: number): void {
  session.blocks.value = [...session.blocks.value, { id, role: "user", text, at }];
}

/** Each block with the item ids it holds — the split as a reader sees it. */
function pieces(blocks: Ref<ThreadBlock[]>): string[] {
  return blocks.value.map((b) =>
    b.role === "user" ? `user: ${b.text}` : `assistant: ${b.items.map((i) => i.itemId).join(",")}`,
  );
}

describe("a message steered into a running turn splits the reply where it landed", () => {
  function steeredSession() {
    const session = makeSession();
    pushUser(session, "ub-1", "what is this project about?", 100);
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(itemEvent("turn-1", "i-1", "Let me look"));
    pushUser(session, "ub-2", "tell me in a table", 200);
    session.reduce(steered("turn-1", "ub-2", 210));
    return session;
  }

  test("what the agent writes after taking it in reads below it", () => {
    const session = steeredSession();
    session.reduce(itemEvent("turn-1", "i-2", "| path |"));
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "assistant: i-1",
      "user: tell me in a table",
      "assistant: i-2",
    ]);
  });

  test("an item already under way keeps streaming into the piece above", () => {
    const session = steeredSession();
    session.reduce(itemEvent("turn-1", "i-1", "Let me look around", "item.updated"));
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "assistant: i-1",
      "user: tell me in a table",
      "assistant: ",
    ]);
  });

  test("the piece above settles at the steer; the turn's outcome lands on the last piece", () => {
    const session = steeredSession();
    session.reduce(itemEvent("turn-1", "i-2", "| path |"));
    session.reduce({ ...base, type: "turn.completed", turnId: "turn-1", at: 400 });
    const replies = session.blocks.value.filter((b) => b.role === "assistant");
    expect(replies.map((b) => [b.state, b.endedAt])).toEqual([
      ["completed", 210],
      ["completed", 400],
    ]);
    expect(replies[1]?.role === "assistant" && replies[1].continues).toBe("turn-1");
  });

  test("a turn that said nothing more after it folds back into one reply", () => {
    const session = steeredSession();
    session.reduce({ ...base, type: "turn.completed", turnId: "turn-1", at: 400 });
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "assistant: i-1",
      "user: tell me in a table",
    ]);
    const reply = session.blocks.value[1];
    expect(reply?.role === "assistant" && reply.endedAt).toBe(400);
  });

  test("a steer on screen keeps its place when its row is promoted after it", () => {
    const session = makeSession();
    pushUser(session, "ub-1", "what is this project about?", 100);
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(itemEvent("turn-1", "i-1", "Let me look"));
    session.reduce(turnQueued("tell me in a table", 200));
    pushUser(session, "ub-2", "tell me in a table", 200);
    session.reduce(steered("turn-1", "ub-2", 210));
    session.reduce(turnPromoted(320, "turn-1"));
    session.reduce(itemEvent("turn-1", "i-2", "| path |"));
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "assistant: i-1",
      "user: tell me in a table",
      "assistant: i-2",
    ]);
  });

  test("a restored row steered in splits where it was taken, not where promotion finds the reply", () => {
    const session = makeSession();
    pushUser(session, "ub-1", "what is this project about?", 100);
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(itemEvent("turn-1", "i-1", "Let me look"));
    // No block on screen for the row — it was restored after a reopen.
    session.reduce(turnQueued("tell me in a table", 200));
    session.reduce(steered("turn-1", "ub-2", 210));
    session.reduce(itemEvent("turn-1", "i-2", "| path |"));
    session.reduce(turnPromoted(320, "turn-1"));
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "assistant: i-1",
      "user: tell me in a table",
      "assistant: i-2",
    ]);
  });

  test("taken in before the turn said anything, the message reads above the reply", () => {
    const session = makeSession();
    pushUser(session, "ub-1", "what is this project about?", 100);
    session.reduce(turnStarted("turn-1", 110));
    pushUser(session, "ub-2", "tell me in a table", 200);
    session.reduce(steered("turn-1", "ub-2", 210));
    session.reduce(itemEvent("turn-1", "i-1", "| path |"));
    expect(pieces(session.blocks)).toEqual([
      "user: what is this project about?",
      "user: tell me in a table",
      "assistant: i-1",
    ]);
  });
});

describe("messages delivered from other agents read where they arrived", () => {
  const ada = { kind: "agent", threadId: "t-ada", name: "Ada", relationship: "contractor" } as const;

  /** kone writing another agent's message on this thread, as delivery does. */
  function journaled(id: string, text: string, at: number): RuntimeEvent {
    return { ...base, type: "thread.message-journaled", at, block: { id, role: "user", text, at, sender: ada } };
  }

  function batchSteered(turnId: string, ids: string[], at: number): RuntimeEvent {
    return { ...base, type: "turn.steered", turnId, message: "", userBlockId: ids.at(-1)!, userBlockIds: ids, at };
  }

  function workingSession() {
    const session = makeSession();
    pushUser(session, "ub-1", "build the login", 100);
    session.reduce(turnStarted("turn-1", 110));
    session.reduce(itemEvent("turn-1", "i-1", "Contracting Ada"));
    return session;
  }

  test("a message steered into the running turn splits the reply, with what followed below it", () => {
    const session = workingSession();
    session.reduce(journaled("ub-m1", "Is OAuth in scope?", 200));
    session.reduce(steered("turn-1", "ub-m1", 210));
    session.reduce(itemEvent("turn-1", "i-2", "Answering Ada"));
    expect(pieces(session.blocks)).toEqual([
      "user: build the login",
      "assistant: i-1",
      "user: Is OAuth in scope?",
      "assistant: i-2",
    ]);
  });

  test("a batch steered in as one turn reads together, in order, above what followed", () => {
    const session = workingSession();
    session.reduce(journaled("ub-m1", "Is OAuth in scope?", 200));
    session.reduce(journaled("ub-m2", "And SSO?", 201));
    session.reduce(batchSteered("turn-1", ["ub-m1", "ub-m2"], 210));
    session.reduce(itemEvent("turn-1", "i-2", "Answering Ada"));
    // A second delivery later in the same turn splits it again.
    session.reduce(journaled("ub-m3", "Done.", 300));
    session.reduce(steered("turn-1", "ub-m3", 310));
    session.reduce(itemEvent("turn-1", "i-3", "Ada is done"));
    expect(pieces(session.blocks)).toEqual([
      "user: build the login",
      "assistant: i-1",
      "user: Is OAuth in scope?",
      "user: And SSO?",
      "assistant: i-2",
      "user: Done.",
      "assistant: i-3",
    ]);
  });

  test("a message that waited in the queue keeps its words and who said it when its turn runs", () => {
    const session = workingSession();
    session.reduce(journaled("ub-m1", "Is OAuth in scope?", 200));
    // A provider that can't steer: the delivery waits as a row, whose input is
    // the prompt the agent is sent, not the words on the transcript.
    session.reduce({
      ...base,
      type: "turn.queued",
      queueId: "q-1",
      userBlockId: "ub-m1",
      dispatchMode: "steer",
      position: 1,
      input: "<agent_messages>\nIs OAuth in scope?\n</agent_messages>",
      at: 205,
    });
    session.reduce({ ...base, type: "turn.completed", turnId: "turn-1", at: 220 });
    session.reduce(turnStarted("turn-2", 230));
    session.reduce(turnPromoted(240, "turn-2"));
    const message = session.blocks.value.find((b) => b.id === "ub-m1");
    expect(message?.role === "user" && [message.text, message.sender]).toEqual(["Is OAuth in scope?", ada]);
    expect(timeline(session.blocks)).toEqual([
      "user: build the login",
      "assistant: turn-1",
      "user: Is OAuth in scope?",
      "assistant: turn-2",
    ]);
  });
});

describe("an agent's message waiting in the queue", () => {
  const ada = { kind: "agent", threadId: "ada", name: "Ada", relationship: "peer" } as const;

  function queued(
    queueId: string,
    userBlockId: string,
    input: string,
    at: number,
    sender?: MessageSender,
  ): RuntimeEvent {
    const event: Extract<RuntimeEvent, { type: "turn.queued" }> = {
      ...base,
      type: "turn.queued",
      queueId,
      userBlockId,
      dispatchMode: "steer",
      position: 1,
      input,
      at,
    };
    if (sender) event.sender = sender;
    return event;
  }

  /** A busy thread on a provider that cannot take a message mid-turn: the
   *  agent's message is journaled under its sender, then queued; the user
   *  queues a follow-up of their own behind it. */
  function busyWithBoth() {
    const session = makeSession();
    session.reduce(turnStarted("turn-1", 100));
    session.reduce({
      ...base,
      type: "thread.message-journaled",
      at: 110,
      block: {
        id: "ub-agent",
        role: "user",
        text: "<agent_messages>from Ada</agent_messages>",
        at: 110,
        sender: ada,
      },
    });
    session.reduce(queued("q-agent", "ub-agent", "<agent_messages>from Ada</agent_messages>", 111, ada));
    session.reduce(queued("q-mine", "ub-mine", "and then this", 120, { kind: "user" }));
    return session;
  }

  test("is not the user's to get back on a Stop", () => {
    const session = busyWithBoth();
    session.reduce({ ...base, type: "turn.queued-cancelled", queueId: "q-agent", reason: "stop", at: 200 });

    expect(session.queueReturn.value?.text).toBe("and then this");
    expect(session.queuedTurnsRaw.value).toEqual([]);
  });

  test("a Stop with only an agent's message queued hands nothing back", () => {
    const session = makeSession();
    session.reduce(turnStarted("turn-1", 100));
    session.reduce({
      ...base,
      type: "thread.message-journaled",
      at: 110,
      block: { id: "ub-agent", role: "user", text: "x", at: 110, sender: { kind: "courier" } },
    });
    session.reduce(queued("q-agent", "ub-agent", "x", 111, { kind: "courier" }));
    session.reduce({ ...base, type: "turn.queued-cancelled", queueId: "q-agent", reason: "stop", at: 200 });

    expect(session.queueReturn.value).toBeNull();
  });

  test("is told apart by its row's sender when its block is not loaded", () => {
    // A reopened thread: the agent's message waits behind an approval and its
    // block is not in the loaded page, so only the row says who wrote it. A
    // row with no sender has no block on record and is not the user's either.
    const session = makeSession();
    session.reduce(turnStarted("turn-1", 100));
    session.reduce(queued("q-agent", "ub-agent", "<agent_messages>from Ada</agent_messages>", 111, ada));
    session.reduce(queued("q-orphan", "ub-orphan", "no block on record", 112));
    session.reduce(queued("q-mine", "ub-mine", "and then this", 120, { kind: "user" }));
    session.reduce({ ...base, type: "turn.queued-cancelled", queueId: "q-agent", reason: "stop", at: 200 });

    expect(session.queueReturn.value?.text).toBe("and then this");
  });

  test("keeps its sender when it runs", () => {
    const session = busyWithBoth();
    session.reduce(turnStarted("turn-2", 300));
    session.reduce({ ...base, type: "turn.promoted", queueId: "q-agent", turnId: "turn-2", at: 310 });

    const block = session.blocks.value.find((b) => b.id === "ub-agent");
    expect(block?.role === "user" ? block.sender?.kind : undefined).toBe("agent");
  });
});

describe("a message kone journals for someone else", () => {
  function journaled(id: string, beforeBlockId?: string): RuntimeEvent {
    const event: Extract<RuntimeEvent, { type: "thread.message-journaled" }> = {
      ...base,
      type: "thread.message-journaled",
      at: 200,
      block: {
        id,
        role: "user",
        text: `from Ada ${id}`,
        at: 200,
        sender: { kind: "agent", threadId: "ada", name: "Ada", relationship: "peer" },
      },
    };
    if (beforeBlockId) event.beforeBlockId = beforeBlockId;
    return event;
  }

  function withOwnWords() {
    const session = makeSession();
    session.blocks.value = [
      { id: "ub-1", role: "user", text: "first", at: 1 },
      { id: "ub-2", role: "user", text: "the turn's own words", at: 2 },
    ];
    return session;
  }

  test("reads above the block it belongs in front of", () => {
    const session = withOwnWords();
    session.reduce(journaled("ub-a", "ub-2"));
    expect(timeline(session.blocks)).toEqual(["user: first", "user: from Ada ub-a", "user: the turn's own words"]);
  });

  test("goes at the tail without one, or when that block is not loaded", () => {
    const session = withOwnWords();
    session.reduce(journaled("ub-a"));
    session.reduce(journaled("ub-b", "ub-missing"));
    expect(timeline(session.blocks)).toEqual([
      "user: first",
      "user: the turn's own words",
      "user: from Ada ub-a",
      "user: from Ada ub-b",
    ]);
  });

  test("lands once", () => {
    const session = withOwnWords();
    session.reduce(journaled("ub-a", "ub-2"));
    session.reduce(journaled("ub-a", "ub-1"));
    expect(session.blocks.value.filter((b) => b.id === "ub-a")).toHaveLength(1);
  });
});

describe("a provider session's end", () => {
  function exited(threadId: string): RuntimeEvent {
    return { type: "session.exited", threadId, provider: "codex", at: 500, source: "codex.rpc.lifecycle", code: null };
  }

  test("tells the session, so its next send starts a new one", () => {
    const session = makeSession();
    session.reduce(exited("t"));
    expect(session.exits.count).toBe(1);
  });

  test("another thread's end is not this one's", () => {
    const session = makeSession();
    session.reduce(exited("someone-else"));
    expect(session.exits.count).toBe(0);
  });

  test("the conversation to resume is this thread's own, never a child's", () => {
    const session = makeSession();
    const refsOn = (threadId: string, conversationId: string): RuntimeEvent => ({
      type: "session.warning",
      threadId,
      provider: "claudeAgent",
      at: 400,
      source: "claude.sdk.lifecycle",
      refs: { conversationId },
      message: "noted",
    });
    session.reduce(refsOn("t", "conv-own"));
    session.reduce(refsOn("child", "conv-child"));
    expect(session.conversations).toEqual(["conv-own"]);
  });

  test("the resume cursor is this thread's own, never a child's", () => {
    const session = makeSession();
    const cursorOn = (threadId: string, resumeSessionAt: string): RuntimeEvent => ({
      type: "session.warning",
      threadId,
      provider: "claudeAgent",
      at: 400,
      source: "claude.sdk.lifecycle",
      refs: { resumeSessionAt },
      message: "noted",
    });
    session.reduce(cursorOn("t", "uuid-own"));
    // A spawned child's traffic is routed to its parent's session too.
    session.reduce(cursorOn("child", "uuid-child"));
    expect(session.cursors).toEqual(["uuid-own"]);
  });
});

describe("a journaled message taken back", () => {
  test("comes off the transcript it was placed on", () => {
    const session = makeSession();
    const envelope = { threadId: "t", provider: "codex", at: 300, source: "kone.store" } as const;
    session.reduce({
      ...envelope,
      type: "thread.message-journaled",
      block: { id: "ub-agent", role: "user", text: "Build the login screen", at: 300 },
    });
    expect(session.blocks.value.map((b) => b.id)).toEqual(["ub-agent"]);

    session.reduce({ ...envelope, type: "thread.message-unjournaled", blockId: "ub-agent" });

    // The send was refused and the store dropped the block; left here, the
    // view showed a message the agent never got and a reload would not.
    expect(session.blocks.value).toEqual([]);
  });
});

describe("an in-place queued edit in the strip", () => {
  test("restates the words and clears attachments/skills on an explicit empty array", () => {
    const session = makeSession();
    const row: QueuedTurnEntry = {
      queueId: "q1",
      threadId: "t",
      userBlockId: "ub-1",
      dispatchMode: "queue",
      state: "queued",
      input: "old words",
      attemptCount: 0,
      createdAt: 1,
      updatedAt: 1,
      attachments: [{ type: "file", id: "a1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
      skills: [{ name: "s", path: "/s" }],
      position: 1,
    };
    session.queuedTurnsRaw.value = [row];

    session.reduce({
      ...base,
      type: "turn.queued-updated",
      queueId: "q1",
      state: "queued",
      attemptCount: 0,
      input: "new words",
      attachments: [],
      skills: [],
    });

    const updated = session.queuedTurnsRaw.value[0];
    expect(updated?.input).toBe("new words");
    expect(updated?.attachments ?? []).toEqual([]);
    expect(updated?.skills ?? []).toEqual([]);
  });

  test("keeps attachments/skills when the update omits them", () => {
    const session = makeSession();
    session.queuedTurnsRaw.value = [
      {
        queueId: "q1",
        threadId: "t",
        userBlockId: "ub-1",
        dispatchMode: "queue",
        state: "queued",
        input: "old",
        attemptCount: 0,
        createdAt: 1,
        updatedAt: 1,
        attachments: [{ type: "file", id: "a1", name: "a.txt", mimeType: "text/plain", sizeBytes: 1 }],
        skills: [{ name: "s", path: "/s" }],
        position: 1,
      },
    ];
    session.reduce({
      ...base,
      type: "turn.queued-updated",
      queueId: "q1",
      state: "queued",
      attemptCount: 0,
      input: "changed",
    });
    expect(session.queuedTurnsRaw.value[0]?.attachments).toHaveLength(1);
    expect(session.queuedTurnsRaw.value[0]?.skills).toHaveLength(1);
  });
});
