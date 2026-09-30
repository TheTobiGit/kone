import { describe, expect, test } from "bun:test";

import { encodeMessageSender, parseMessageSender } from "./messageSender.js";

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

  test("anything unreadable falls back to the user rather than a wrong claim", () => {
    expect(parseMessageSender("not json")).toBeUndefined();
    expect(parseMessageSender('{"kind":"agent"}')).toBeUndefined();
    expect(parseMessageSender('{"kind":"agent","threadId":"t","relationship":"boss"}')).toBeUndefined();
  });
});
