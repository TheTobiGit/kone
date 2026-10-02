import { describe, expect, test } from "bun:test";
import { ref } from "vue";
import type { KoneAgentApi } from "~/types/desktop";
import type { QueuedTurnEntry, ThreadBlock } from "../agentTypes";
import { useSessionQueue } from "./sessionQueue";

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
