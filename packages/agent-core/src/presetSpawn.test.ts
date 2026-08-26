import { describe, expect, test } from "bun:test";

import { BUILTIN_SWARM_PRESETS, findBuiltinPreset, planPresetSpawn } from "./presetSpawn.js";
import type { SubagentPresetRecord } from "./ConversationStore.js";

function preset(overrides: Partial<SubagentPresetRecord> = {}): SubagentPresetRecord {
  return {
    presetId: "p",
    name: "Explorer",
    instructions: "Read only.",
    model: { provider: "claudeAgent", model: "haiku" },
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

  test("the preset's model is the target, marked preferred", () => {
    const plan = planPresetSpawn(preset(), "Go.", available, { provider: "codex" });
    expect(plan).toMatchObject({
      ok: true,
      target: { provider: "claudeAgent", model: "haiku" },
      selection: "preferred",
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
      selection: "caller-default",
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

  test("resolves built-in swarm presets (Fast Scout, Reviewer, Refactorer)", () => {
    expect(BUILTIN_SWARM_PRESETS.length).toBeGreaterThanOrEqual(3);

    const scout = findBuiltinPreset("Fast Scout");
    expect(scout).not.toBeNull();
    expect(scout?.name).toBe("Fast Scout");

    const reviewer = findBuiltinPreset("builtin-reviewer");
    expect(reviewer).not.toBeNull();
    expect(reviewer?.name).toBe("Reviewer");

    const refactorer = findBuiltinPreset("refactorer");
    expect(refactorer).not.toBeNull();
    expect(refactorer?.name).toBe("Refactorer");

    if (scout) {
      const plan = planPresetSpawn(scout, "Audit repo structure", available, {
        provider: "claudeAgent",
        model: "sonnet",
      });
      expect(plan.ok).toBe(true);
      if (plan.ok) {
        expect(plan.prompt).toContain("You are the Fast Scout subagent");
        expect(plan.prompt).toContain("Audit repo structure");
      }
    }
  });
});
