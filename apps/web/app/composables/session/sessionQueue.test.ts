import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import type { KoneAgentApi, QueuedTurnRow } from "~/types/desktop";
import type { QueuedTurnEntry, ThreadBlock } from "../agentTypes";
import { usersOwnQueuedRows, useSessionQueue } from "./sessionQueue";

const ENTRY: QueuedTurnEntry = {
  queueId: "q1",
  threadId: "t1",
  userBlockId: "ub1",
  dispatchMode: "queue",
  state: "failed",
  input: "send me",
  createdAt: 1,
  position: 1,
};

function harness(sessionComesUp: boolean) {
  const calls: string[] = [];
  const bridge = {
    sendQueuedTurnNow: async (threadId: string, queueId: string) => {
      calls.push(`send-now:${threadId}:${queueId}`);
      return true;
    },
  };
  const queue = useSessionQueue({
    blocks: ref<ThreadBlock[]>([]),
    threadId: ref("t1"),
    // SAFETY: Send now reads only the queue slice stubbed above.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    bridge: () => bridge as unknown as KoneAgentApi,
    error: ref<string | null>(null),
    busy: ref(false),
    ensureSession: async () => {
      calls.push("ensure-session");
      return sessionComesUp;
    },
    send: async () => {},
    steerTurn: async () => {},
  });
  return { queue, calls };
}

describe("Send now on a queued row", () => {
  test("starts a reopened thread's session before asking the backend to deliver", async () => {
    const { queue, calls } = harness(true);
    await queue.sendQueuedEntryNow(ENTRY);
    expect(calls).toEqual(["ensure-session", "send-now:t1:q1"]);
  });

  test("leaves the row alone when the session doesn't come up", async () => {
    const { queue, calls } = harness(false);
    await queue.sendQueuedEntryNow(ENTRY);
    expect(calls).toEqual(["ensure-session"]);
  });
});

describe("the strip shows the user's own queued rows", () => {
  const ada = { kind: "agent", threadId: "ada", name: "Ada", relationship: "peer" } as const;

  function row(queueId: string, over: Partial<QueuedTurnEntry> = {}): QueuedTurnEntry {
    return { ...ENTRY, queueId, userBlockId: `ub-${queueId}`, state: "queued", ...over };
  }

  function queueOn(rows: QueuedTurnRow[]) {
    // SAFETY: seeding reads only queuedTurns, stubbed here.
    // eslint-disable-next-line anti-slop/no-chained-type-assertions
    const api = { queuedTurns: async () => rows } as unknown as KoneAgentApi;
    const queue = useSessionQueue({
      // A reopened thread whose queued messages' blocks are not in the loaded
      // page: nothing on screen says who wrote them.
      blocks: ref<ThreadBlock[]>([]),
      threadId: ref("t1"),
      bridge: () => api,
      error: ref<string | null>(null),
      busy: ref(true),
      ensureSession: async () => true,
      send: async () => {},
      steerTurn: async () => {},
    });
    return { queue, api };
  }

  test("a reopened thread's queue shows only the rows the user wrote, renumbered", async () => {
    const stored: QueuedTurnRow[] = [
      { ...row("agent", { sender: ada }), input: "<agent_messages>from Ada</agent_messages>", attemptCount: 0, updatedAt: 1 },
      { ...row("orphan"), attemptCount: 0, updatedAt: 1 },
      { ...row("mine", { sender: { kind: "user" } }), attemptCount: 0, updatedAt: 1 },
      { ...row("notice", { sender: { kind: "system" } }), attemptCount: 0, updatedAt: 1 },
    ];
    const { queue, api } = queueOn(stored);
    queue.seedQueuedTurns(api);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(queue.queuedTurns.value.map((q) => [q.queueId, q.position])).toEqual([["mine", 1]]);
    // The raw list keeps every row, so their blocks stay held back from the
    // transcript until they run.
    expect(queue.queuedTurnsRaw.value).toHaveLength(4);
  });

  test("only a user sender is the user's", () => {
    const rows = [
      row("a", { sender: ada }),
      row("b", { sender: { kind: "courier" } }),
      row("c"),
      row("d", { sender: { kind: "user" } }),
    ];
    expect(usersOwnQueuedRows(rows).map((q) => q.queueId)).toEqual(["d"]);
  });
});
