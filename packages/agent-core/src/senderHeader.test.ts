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

  test("an unbound delegator is named by its rolled call sign — the name the renderer shows for the same id", () => {
    // 76d80d25-… is a real main thread the renderer labels "Crest".
    const sender = agentSenderFor({ threadMeta: () => ({}) }, "76d80d25-f1b3-4763-89dc-c65432c7bf63", "delegator", "brief");
    expect(sender.name).toBe("Crest");
    const header = renderSenderHeader(sender) ?? "";
    expect(header).toContain('name="Crest" relationship="delegator"');
    expect(header).toContain("Crest delegated this work to you.");
    expect(header).not.toContain("your delegator");
  });

  test("a side chat answers under the name of the conversation it was forked from", () => {
    const metas: Record<string, { sourceThreadId?: string; forkContext?: { sourceThreadId: string; forkKind?: "edit" | "handoff" | "branch" } }> = {
      side: { forkContext: { sourceThreadId: "76d80d25-f1b3-4763-89dc-c65432c7bf63" } },
      "edit-fork-1": { forkContext: { sourceThreadId: "76d80d25-f1b3-4763-89dc-c65432c7bf63", forkKind: "edit" } },
    };
    const source = { threadMeta: (id: string) => metas[id] ?? {} };
    expect(agentSenderFor(source, "side", "peer").name).toBe("Crest");
    // An edit fork is a new conversation, not the same agent stepping aside.
    expect(agentSenderFor(source, "edit-fork-1", "peer").name).toBe("Rook");
  });
});
