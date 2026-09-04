import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  isPluginInternallyEnabled,
  isSkillInternallyEnabled,
  readInternalSkillsSettings,
  resetInternalSkillsSettingsCacheForTesting,
  setPluginInternalState,
  setSkillInternalState,
  writeInternalSkillsSettings,
} from "./skillsSettings.js";
import { setUserDataDir } from "./userDataDir.js";

const tmp = mkdtempSync(path.join(tmpdir(), "kone-skills-settings-test-"));
setUserDataDir(tmp);

describe("skillsSettings persistence and evaluation", () => {
  test("returns empty defaults when settings file does not exist", () => {
    resetInternalSkillsSettingsCacheForTesting();
    const settings = readInternalSkillsSettings();
    expect(settings.disabled).toEqual([]);
    expect(settings.disabledPlugins).toEqual([]);
  });

  test("toggles a skill disabled and persists it", () => {
    resetInternalSkillsSettingsCacheForTesting();
    const skill = { path: "/path/to/my-skill/SKILL.md", name: "my-skill" };
    expect(isSkillInternallyEnabled(skill)).toBe(true);

    const updated = setSkillInternalState(skill, false);
    expect(updated.disabled).toContain(skill.path);
    expect(isSkillInternallyEnabled(skill)).toBe(false);

    // Re-read with fresh cache reset
    resetInternalSkillsSettingsCacheForTesting();
    const fresh = readInternalSkillsSettings();
    expect(isSkillInternallyEnabled(skill, fresh)).toBe(false);

    // Re-enable
    setSkillInternalState(skill, true);
    expect(isSkillInternallyEnabled(skill)).toBe(true);
  });

  test("evaluates skill enabled state by name as fallback", () => {
    resetInternalSkillsSettingsCacheForTesting();
    writeInternalSkillsSettings({ disabled: ["lint-code"] });

    expect(isSkillInternallyEnabled({ name: "lint-code" })).toBe(false);
    expect(isSkillInternallyEnabled({ name: "other-skill" })).toBe(true);
  });

  test("toggles a plugin disabled and persists it", () => {
    resetInternalSkillsSettingsCacheForTesting();
    expect(isPluginInternallyEnabled("github")).toBe(true);

    setPluginInternalState("github", false);
    expect(isPluginInternallyEnabled("github")).toBe(false);

    resetInternalSkillsSettingsCacheForTesting();
    expect(isPluginInternallyEnabled("github")).toBe(false);

    setPluginInternalState("github", true);
    expect(isPluginInternallyEnabled("github")).toBe(true);
  });
});
