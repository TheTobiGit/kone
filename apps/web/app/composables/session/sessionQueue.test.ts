import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import type { KoneAgentApi } from "~/types/desktop";
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
  const agentSender = { kind: "agent", threadId: "peer", name: "Ada", relationship: "peer" } as const;

  function row(queueId: string, userBlockId: string, over: Partial<QueuedTurnEntry> = {}): QueuedTurnEntry {
    return { ...ENTRY, queueId, userBlockId, state: "queued", ...over };
  }

  test("a row whose block another agent wrote is left out, and the rest renumber", () => {
    const blocks = ref<ThreadBlock[]>([
      { id: "ub-agent", role: "user", text: "<agent_messages>…</agent_messages>", at: 1, sender: agentSender },
      { id: "ub-mine", role: "user", text: "mine", at: 2 },
    ]);
    const queue = useSessionQueue({
      blocks,
      threadId: ref("t1"),
      bridge: () => null,
      error: ref<string | null>(null),
      busy: ref(true),
      ensureSession: async () => true,
      send: async () => {},
      steerTurn: async () => {},
    });
    queue.queuedTurnsRaw.value = [row("q-agent", "ub-agent"), row("q-mine", "ub-mine"), row("q-reseeded", "ub-gone")];

    expect(queue.queuedTurns.value.map((q) => [q.queueId, q.position])).toEqual([
      ["q-mine", 1],
      ["q-reseeded", 2],
    ]);
    // The raw list keeps the agent's row, so its block stays held back from
    // the transcript until it runs.
    expect(queue.queuedTurnsRaw.value).toHaveLength(3);
  });

  test("a row anchored to an agent's block by its blockId is left out too", () => {
    const blocks: ThreadBlock[] = [
      { id: "ub-agent", role: "user", text: "x", at: 1, sender: { kind: "courier" } },
    ];
    expect(usersOwnQueuedRows([row("q", "ub-other", { blockId: "ub-agent" })], blocks)).toEqual([]);
  });

  test("kone's notices count as not the user's; a user sender does", () => {
    const blocks: ThreadBlock[] = [
      { id: "ub-sys", role: "user", text: "x", at: 1, sender: { kind: "system" } },
      { id: "ub-me", role: "user", text: "y", at: 2, sender: { kind: "user" } },
    ];
    expect(usersOwnQueuedRows([row("a", "ub-sys"), row("b", "ub-me")], blocks).map((q) => q.queueId)).toEqual(["b"]);
  });
});
