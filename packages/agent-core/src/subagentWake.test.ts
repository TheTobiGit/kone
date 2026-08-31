import { describe, expect, test } from "bun:test";
import { subagentWakePrompt } from "./subagentWake.js";
import type { SubagentRunSnapshot } from "./types.js";

function run(over: Partial<SubagentRunSnapshot> = {}): SubagentRunSnapshot {
  return { toolUseId: "tool-1", status: "completed", ...over };
}

describe("the subagent wake prompt", () => {
  test("names each run, its outcome, and what it reported", () => {
    const prompt = subagentWakePrompt([
      run({ description: "Explore t3code archive chats", summary: "found three call sites" }),
      run({ toolUseId: "tool-2", description: "Explore synara archive chats", status: "failed" }),
    ]);

    expect(prompt).toContain("2 background subagents");
    expect(prompt).toContain("- Explore t3code archive chats — finished: found three call sites");
    expect(prompt).toContain("- Explore synara archive chats — failed");
  });

  test("falls back to the agent type, then the tool-use id, for an unlabelled run", () => {
    expect(subagentWakePrompt([run({ agentType: "explore" })])).toContain("- explore — finished");
    expect(subagentWakePrompt([run()])).toContain("- tool-1 — finished");
  });

  test("reads as one subagent when there is one", () => {
    expect(subagentWakePrompt([run()])).toContain("A background subagent");
  });

  test("says the user has not spoken, so the agent resumes rather than answers", () => {
    expect(subagentWakePrompt([run()])).toContain("the user has not said anything new");
  });

  test("an empty batch still says something — a turn with an empty prompt is worse", () => {
    expect(subagentWakePrompt([]).trim().length).toBeGreaterThan(0);
  });
});
