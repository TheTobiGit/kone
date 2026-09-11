import { describe, expect, test } from "bun:test";

import {
  BUILTIN_SUBAGENT_PRESETS,
  BUILTIN_SUBAGENT_PRESET_IDS,
  LEGACY_PRESET_ALIASES,
  normalizeChain,
  resolveLegacyPresetId,
} from "./subagentPresets.js";

describe("BUILTIN_SUBAGENT_PRESETS", () => {
  test("contains unique presetIds", () => {
    const ids = BUILTIN_SUBAGENT_PRESETS.map((p) => p.presetId);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
  });

  test("contains the five native roles", () => {
    const ids = BUILTIN_SUBAGENT_PRESETS.map((p) => p.presetId);
    expect(ids).toContain("builtin-scout");
    expect(ids).toContain("builtin-reviewer");
    expect(ids).toContain("builtin-security-reviewer");
    expect(ids).toContain("builtin-librarian");
    expect(ids).toContain("builtin-worker");
    expect(ids).toHaveLength(5);
  });

  test("each preset has non-empty name and instructions", () => {
    for (const preset of BUILTIN_SUBAGENT_PRESETS) {
      expect(preset.presetId).toMatch(/^builtin-[a-z-]+$/);
      expect(preset.name.trim().length).toBeGreaterThan(0);
      expect(preset.instructions.trim().length).toBeGreaterThan(0);
    }
  });

  test("the id list mirrors the definitions in order", () => {
    expect([...BUILTIN_SUBAGENT_PRESET_IDS]).toEqual(
      BUILTIN_SUBAGENT_PRESETS.map((preset) => preset.presetId),
    );
  });
});

describe("LEGACY_PRESET_ALIASES", () => {
  test("every successor is a native this build ships", () => {
    for (const alias of LEGACY_PRESET_ALIASES) {
      expect(BUILTIN_SUBAGENT_PRESET_IDS).toContain(alias.successor);
    }
  });

  test("legacy ids and names resolve, punctuation-blind", () => {
    expect(resolveLegacyPresetId("builtin-explorer")).toBe("builtin-scout");
    expect(resolveLegacyPresetId("Explorer")).toBe("builtin-scout");
    expect(resolveLegacyPresetId("  CODE-REVIEWER ")).toBe("builtin-reviewer");
    expect(resolveLegacyPresetId("builtin-code-reviewer")).toBe("builtin-reviewer");
  });

  test("current names and retired-without-successor names resolve to nothing", () => {
    expect(resolveLegacyPresetId("Scout")).toBeNull();
    expect(resolveLegacyPresetId("builtin-scout")).toBeNull();
    expect(resolveLegacyPresetId("PR Handler")).toBeNull();
    expect(resolveLegacyPresetId("Git Handler")).toBeNull();
    expect(resolveLegacyPresetId("")).toBeNull();
    expect(resolveLegacyPresetId("   ")).toBeNull();
  });
});

describe("normalizeChain", () => {
  const haiku = { provider: "claudeAgent", model: "haiku" };
  const gpt = { provider: "codex", model: "gpt-5" };

  test("a missing primary drops the tail however it was spelt", () => {
    expect(normalizeChain(null, [haiku])).toEqual({ primary: null, fallbacks: null });
    expect(normalizeChain(undefined, [haiku])).toEqual({ primary: null, fallbacks: null });
    expect(normalizeChain(null, null)).toEqual({ primary: null, fallbacks: null });
  });

  test("a pinned primary with no tail reads an empty tail", () => {
    expect(normalizeChain(haiku)).toEqual({ primary: haiku, fallbacks: [] });
    expect(normalizeChain(haiku, null)).toEqual({ primary: haiku, fallbacks: [] });
  });

  test("a pinned primary keeps its tail by value, not by reference", () => {
    const tail = [gpt];
    const chain = normalizeChain(haiku, tail);
    expect(chain).toEqual({ primary: haiku, fallbacks: [gpt] });
    expect(chain.fallbacks).not.toBe(tail);
  });
});
