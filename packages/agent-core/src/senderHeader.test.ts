import { describe, expect, test } from "bun:test";

import { agentSenderFor, renderSenderHeader } from "./senderHeader.js";

describe("agentSenderFor", () => {
  test("a contractor is named by its contract, not left to its relationship", () => {
    const sender = agentSenderFor(
      { threadMeta: () => ({ contract: { name: "Frontend Auth" } }) },
      "contractor-1",
      "contractor",
      "report",
    );
    expect(sender.name).toBe("Frontend Auth");
    expect(renderSenderHeader(sender)).toContain('name="Frontend Auth"');
  });

  test("a roster agent keeps its roster name and id", () => {
    const sender = agentSenderFor(
      {
        threadMeta: () => ({}),
        getThreadAgent: () => ({ agentId: "agent-backend" }),
        getAgent: () => ({ name: "Backend" }),
      },
      "delegate-1",
      "delegate",
    );
    expect(sender).toEqual({ kind: "agent", threadId: "delegate-1", relationship: "delegate", agentId: "agent-backend", name: "Backend" });
  });
});
