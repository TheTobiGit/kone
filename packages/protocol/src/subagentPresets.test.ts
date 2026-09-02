import { describe, expect, test } from "bun:test";

import { BUILTIN_SUBAGENT_PRESETS } from "./subagentPresets.js";

describe("BUILTIN_SUBAGENT_PRESETS", () => {
  test("contains unique presetIds", () => {
    const ids = BUILTIN_SUBAGENT_PRESETS.map((p) => p.presetId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("contains standard built-in roles", () => {
    const ids = BUILTIN_SUBAGENT_PRESETS.map((p) => p.presetId);
    expect(ids).toContain("builtin-explorer");
    expect(ids).toContain("builtin-code-reviewer");
    expect(ids).toContain("builtin-pr-handler");
    expect(ids).toContain("builtin-git-handler");
  });

  test("each preset has non-empty name and instructions", () => {
    for (const preset of BUILTIN_SUBAGENT_PRESETS) {
      expect(preset.presetId).toMatch(/^builtin-[a-z-]+$/);
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(preset.instructions.trim().length).toBeGreaterThan(0);
    }
  });
});
