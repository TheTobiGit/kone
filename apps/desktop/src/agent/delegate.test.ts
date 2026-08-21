import { describe, expect, test } from "bun:test";

import { resolveDelegation } from "./delegate.js";
import type { ProviderAvailability } from "./agentModel.js";
import type { AgentRecord } from "./ConversationStore.js";

function agent(overrides: Partial<AgentRecord> = {}): AgentRecord {
  return {
    agentId: "agent-backend",
    presetId: null,
    name: "Backend",
    role: null,
    instructions: "You own the API layer.",
    faceBody: null,
    faceInk: null,
    skills: null,
    model: null,
    policies: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    deletedAt: null,
    ...overrides,
  };
}

const caller = { provider: "opencode" as const, model: "deepseek-v4" };

/** Both providers healthy, each offering one model. */
const availability: ProviderAvailability[] = [
  { provider: "claudeAgent", available: true, models: ["haiku", "sonnet"] },
  { provider: "codex", available: true, models: ["gpt-5"] },
  { provider: "opencode", available: true, models: ["deepseek-v4"] },
];

describe("resolveDelegation", () => {
  test("the persona is the agent's name and instructions", () => {
    const plan = resolveDelegation({ agent: agent(), task: "Build /users", availability, caller });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.persona).toEqual({ name: "Backend", instructions: "You own the API layer." });
  });

  test("an agent with no instructions is a name-only persona", () => {
    const plan = resolveDelegation({
      agent: agent({ instructions: null }),
      task: "Build /users",
      availability,
      caller,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.persona).toEqual({ name: "Backend" });
  });

  test("an agent with no resolvable name is refused as no_identity", () => {
    for (const name of [null, "", "   "]) {
      const plan = resolveDelegation({
        agent: agent({ name }),
        task: "Build /users",
        availability,
        caller,
      });
      expect(plan.ok).toBe(false);
      if (plan.ok) continue;
      expect(plan.code).toBe("no_identity");
    }
  });

  test("the task alone is the brief — the agent's instructions are not prepended", () => {
    const plan = resolveDelegation({
      agent: agent(),
      task: "Build the /users endpoint.",
      availability,
      caller,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.prompt).toBe("Build the /users endpoint.");
    expect(plan.prompt).not.toContain("API layer");
  });

  test("the agent's model is picked as the preferred selection", () => {
    const plan = resolveDelegation({
      agent: agent({ model: { provider: "claudeAgent", model: "sonnet" } }),
      task: "Build /users",
      availability,
      caller,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.selection).toBe("preferred");
    expect(plan.target).toEqual({ provider: "claudeAgent", model: "sonnet" });
  });

  test("no model preference runs on the caller's own provider/model", () => {
    const plan = resolveDelegation({ agent: agent({ model: null }), task: "Build /users", availability, caller });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.selection).toBe("caller-default");
    expect(plan.target).toEqual({ provider: "opencode", model: "deepseek-v4" });
  });

  test("caller-default without a caller model leaves the model to the provider", () => {
    const plan = resolveDelegation({
      agent: agent({ model: null }),
      task: "Build /users",
      availability,
      caller: { provider: "codex" },
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.target).toEqual({ provider: "codex" });
  });

  test("an unavailable model is refused as none_available, with what it tried", () => {
    const model = { provider: "claudeAgent" as const, model: "opus" }; // not offered
    const plan = resolveDelegation({ agent: agent({ model }), task: "Build /users", availability, caller });
    expect(plan.ok).toBe(false);
    if (plan.ok) return;
    expect(plan.code).toBe("none_available");
    expect(plan.tried).toEqual(model);
  });
});
