import { describe, expect, test } from "bun:test";
import { ref, type Ref } from "vue";

import {
  queuedBlockIdsOf,
  parseQueuedAttachments,
  sortQueuedByIds,
} from "./sessionQueue";
import { useSessionReducer } from "./sessionReducer";
import type { QueuedTurnEntry, ThreadBlock } from "../agentTypes";
import type {
  CompactionRecord,
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
  const deps = {
    blocks,
    threadId,
    touch: () => {},
    noteResumeSessionAt: () => {},
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
    queueReturn: ref<QueueReturn | null>(null),
    mergeQueueReturn: () => ({ at: 0, text: "", attachments: [], skills: [] }),
    pendingQueueAnchors: new Map<string, string>(),
    pendingUserInput: ref<PendingUserInput | null>(null),
    pendingApprovals: ref<PendingApproval[]>([]),
    anchorFor: () => undefined,
    queuedBlockIdsOf,
    sortQueuedByIds,
    parseQueuedAttachments,
    noteCompactedBoundary: (_marker: CompactionRecord) => {},
  };
  return { blocks, queuedTurnsRaw, reduce: useSessionReducer(deps).reduce };
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
