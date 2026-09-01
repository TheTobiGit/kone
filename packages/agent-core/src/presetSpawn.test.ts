import { describe, expect, test } from "bun:test";

import { BUILTIN_SWARM_PRESETS, findBuiltinPreset, planPresetSpawn } from "./presetSpawn.js";
import type { ProviderAvailability } from "./agentModel.js";
import type { SubagentPresetRecord } from "./ConversationStore.js";

function preset(overrides: Partial<SubagentPresetRecord> = {}): SubagentPresetRecord {
  return {
    presetId: "p",
    name: "Explorer",
    instructions: "Read only.",
    model: { provider: "claudeAgent", model: "haiku" },
    modelFallbacks: null,
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

const available: ProviderAvailability[] = [
  { provider: "claudeAgent", available: true, models: ["haiku", "opus"] },
  { provider: "codex", available: true, models: ["gpt-5"] },
];

describe("planPresetSpawn", () => {
  test("lays instructions over the task as the opening brief", () => {
    const plan = planPresetSpawn(preset(), "Map auth.", available, { provider: "codex", model: "gpt-5" });
    expect(plan.ok).toBe(true);
    if (plan.ok) expect(plan.prompt).toBe("Read only.\n\nYour task:\nMap auth.");
  });

  test("a preset with no instructions is just the task", () => {
    const plan = planPresetSpawn(preset({ instructions: null }), "Map auth.", available, {
      provider: "codex",
    });
    if (plan.ok) expect(plan.prompt).toBe("Map auth.");
  });

  test("the preset's model is the target, marked assigned", () => {
    const plan = planPresetSpawn(preset(), "Go.", available, { provider: "codex" });
    expect(plan).toMatchObject({
      ok: true,
      target: { provider: "claudeAgent", model: "haiku" },
      selection: "assigned",
    });
  });

  test("no preference runs on the caller's own provider and model", () => {
    const plan = planPresetSpawn(preset({ model: null }), "Go.", available, {
      provider: "codex",
      model: "gpt-5",
    });
    expect(plan).toMatchObject({
      ok: true,
      target: { provider: "codex", model: "gpt-5" },
      selection: "inherited",
    });
  });

  test("refuses, naming what it tried, when the preset's model can't run", () => {
    const p = preset({ model: { provider: "cursor", model: "auto" } });
    const plan = planPresetSpawn(p, "Go.", available, { provider: "codex" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain("Explorer");
      expect(plan.tried).toEqual(["cursor/auto"]);
    }
  });

  test("a named override beats the preset's chain", () => {
    const plan = planPresetSpawn(
      preset({ modelFallbacks: [{ provider: "codex", model: "gpt-5" }] }),
      "Go.",
      available,
      { provider: "codex", model: "gpt-5" },
      { provider: "claudeAgent", model: "opus" },
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { provider: "claudeAgent", model: "opus" },
      fallbacks: [],
      selection: "requested",
    });
  });

  test("an assigned chain keeps the untried tail as fallbacks", () => {
    const plan = planPresetSpawn(
      preset({
        model: { provider: "claudeAgent", model: "haiku" },
        modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
      }),
      "Go.",
      available,
      { provider: "codex" },
    );
    expect(plan).toMatchObject({
      ok: true,
      target: { provider: "claudeAgent", model: "haiku" },
      fallbacks: [{ provider: "codex", model: "gpt-5" }],
      selection: "assigned",
    });
  });

  test("resolves built-in presets (Explorer, Code Reviewer, PR Handler, Git Handler)", () => {
    expect(BUILTIN_SWARM_PRESETS.length).toBeGreaterThanOrEqual(4);

    const explorer = findBuiltinPreset("Explorer");
    expect(explorer).not.toBeNull();
    expect(explorer?.name).toBe("Explorer");

    const reviewer = findBuiltinPreset("builtin-code-reviewer");
    expect(reviewer).not.toBeNull();
    expect(reviewer?.name).toBe("Code Reviewer");

    const prHandler = findBuiltinPreset("pr-handler");
    expect(prHandler).not.toBeNull();
    expect(prHandler?.name).toBe("PR Handler");

    if (explorer) {
      const plan = planPresetSpawn(explorer, "Audit repo structure", available, {
        provider: "claudeAgent",
        model: "sonnet",
      });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.prompt).toContain("Map the code and report what you find");
        expect(plan.prompt).toContain("Audit repo structure");
      }
    }
  });
});
