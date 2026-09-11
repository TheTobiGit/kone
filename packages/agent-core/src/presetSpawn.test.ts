import { describe, expect, test } from "bun:test";

import { planPresetSpawn } from "./presetSpawn.js";
import { builtinPresetsWithConfig } from "./rosterRecord.js";
import {
  BUILTIN_SUBAGENT_PRESETS,
  resolveLegacyPresetId,
} from "@kone/protocol/subagent-presets";
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
    const modelRef = { provider: "cursor" as const, model: "auto" };
    const p = preset({ model: modelRef });
    const plan = planPresetSpawn(p, "Go.", available, { provider: "codex" });
    expect(plan.ok).toBe(false);
    if (!plan.ok) {
      expect(plan.reason).toContain("Explorer");
      expect(plan.tried).toEqual([modelRef]);
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

  test("the five natives carry no model until one is pinned", () => {
    const natives = builtinPresetsWithConfig([]);
    expect(natives).toHaveLength(5);
    expect(natives.map((native) => native.presetId)).toEqual(
      BUILTIN_SUBAGENT_PRESETS.map((preset) => preset.presetId),
    );
    for (const native of natives) {
      expect(native.model).toBeNull();
      expect(native.modelFallbacks).toBeNull();
    }
  });

  test("a disabled native reads as absent; a pinned chain folds in", () => {
    const natives = builtinPresetsWithConfig([
      { presetId: "builtin-librarian", enabled: false, model: null, modelFallbacks: null, updatedAt: 1 },
      {
        presetId: "builtin-scout",
        enabled: true,
        model: { provider: "claudeAgent", model: "haiku" },
        modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
        updatedAt: 1,
      },
    ]);
    expect(natives.map((native) => native.presetId)).not.toContain("builtin-librarian");
    expect(natives.find((native) => native.presetId === "builtin-scout")).toMatchObject({
      model: { provider: "claudeAgent", model: "haiku" },
      modelFallbacks: [{ provider: "codex", model: "gpt-5" }],
    });
  });

  test("a legacy name resolves to its successor native", () => {
    expect(resolveLegacyPresetId("Explorer")).toBe("builtin-scout");
    expect(resolveLegacyPresetId("code-reviewer")).toBe("builtin-reviewer");
    expect(resolveLegacyPresetId("builtin-code-reviewer")).toBe("builtin-reviewer");
    // Retired with no successor: the agent gets the current list, not a guess.
    expect(resolveLegacyPresetId("PR Handler")).toBeNull();
    expect(resolveLegacyPresetId("Git Handler")).toBeNull();
    expect(resolveLegacyPresetId("Scout")).toBeNull();

    const scout = builtinPresetsWithConfig([]).find(
      (native) => native.presetId === resolveLegacyPresetId("Explorer"),
    )!;
    const plan = planPresetSpawn(scout, "Audit repo structure", available, {
      provider: "claudeAgent",
      model: "sonnet",
    });
    expect(plan.ok).toBe(true);
    if (plan.ok) {
      expect(plan.prompt).toContain("Read-only investigation of the codebase");
      expect(plan.prompt).toContain("Audit repo structure");
    }
  });
});
