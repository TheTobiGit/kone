import { describe, expect, test } from "bun:test";

import {
  COURIER_AGENT_ID,
  encodeMessageSender,
  isCourierAgentId,
  parseMessageSender,
  senderLabel,
} from "./messageSender.js";

describe("message sender", () => {
  test("the user is stored as NULL and read back as absent", () => {
    expect(encodeMessageSender(undefined)).toBeNull();
    expect(encodeMessageSender({ kind: "user" })).toBeNull();
    expect(parseMessageSender(null)).toBeUndefined();
    expect(parseMessageSender('{"kind":"user"}')).toBeUndefined();
  });

  test("an agent sender round-trips", () => {
    const sender = {
      kind: "agent" as const,
      threadId: "t-main",
      name: "Maya",
      agentId: "agent-maya",
      relationship: "delegator" as const,
      messageKind: "brief" as const,
    };
    expect(parseMessageSender(encodeMessageSender(sender))).toEqual(sender);
  });

  test("a system sender round-trips", () => {
    expect(parseMessageSender(encodeMessageSender({ kind: "system" }))).toEqual({ kind: "system" });
  });

  test("a courier sender round-trips with whose work it carries", () => {
    const sender = {
      kind: "courier" as const,
      messageKind: "report" as const,
      about: { threadId: "t-child", name: "Ada", agentId: "agent-ada", relationship: "contractor" as const },
    };
    expect(parseMessageSender(encodeMessageSender(sender))).toEqual(sender);
  });

  test("the courier's id is the one reserved roster id", () => {
    expect(isCourierAgentId(COURIER_AGENT_ID)).toBe(true);
    expect(isCourierAgentId("orchestrator")).toBe(false);
    expect(isCourierAgentId(null)).toBe(false);
  });

  test("anything unreadable falls back to the user rather than a wrong claim", () => {
    expect(parseMessageSender("not json")).toBeUndefined();
    expect(parseMessageSender('{"kind":"agent"}')).toBeUndefined();
    expect(parseMessageSender('{"kind":"agent","threadId":"t","relationship":"boss"}')).toBeUndefined();
  });
});

// The one line a transcript read outside the app gets: nobody but the user
// reads as the user, and the courier keeps whose words it carried.
describe("sender label", () => {
  test("names every speaker as what they are", () => {
    expect(senderLabel(undefined)).toBe("User");
    expect(senderLabel({ kind: "system" })).toBe("kone (notice)");
    expect(senderLabel({ kind: "agent", threadId: "t1", relationship: "peer" })).toBe("Agent (agent, teammate)");
    expect(senderLabel({ kind: "courier" })).toBe("kone (courier)");
    expect(
      senderLabel({ kind: "courier", about: { threadId: "t2", relationship: "child" } }),
    ).toBe("kone (courier, carrying an agent's message; your worker, thread t2)");
  });
});
