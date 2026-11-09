import { describe, expect, test } from "bun:test";
import { agentIdentity, namedIdentity } from "../src/identity.js";
import type { AgentRecord } from "@kone/agent-core/rosterRecord.js";

describe("session identities", () => {
  test("guest identities are stable and use a thumbs SVG", () => {
    const first = agentIdentity("thread-a");
    expect(first).toEqual(agentIdentity("thread-a"));
    expect(first.name).toBe("Hollow");
    expect(first.svg).toContain("<svg");
    expect(agentIdentity(null).name).toBe("kone");
  });
  test("named identity uses the roster name and portrait", () => {
    const agent: AgentRecord = {
      agentId: "a", presetId: null, name: "Ada", role: null, instructions: null,
      faceBody: null, faceInk: null, skills: null, model: null, modelFallbacks: null,
      avatar: { source: "upload", src: "data:image/png;base64,AAAA" }, bot: null,
      sortOrder: 0, createdAt: 0, updatedAt: 0, deletedAt: null,
    };
    const identity = namedIdentity("thread-a", agent);
    expect(identity?.name).toBe("Ada");
    expect(identity?.avatar).toBe(agent.avatar?.src);
    expect(identity?.svg).toContain("<svg");
  });
});
