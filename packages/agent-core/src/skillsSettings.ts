import fs from "node:fs";

import { z } from "zod";

import type { JsonValue } from "./lib-jsonValue.js";
import { writeFileAtomicSync } from "./lib-atomicWrite.js";
import { clearAgentInventoryCache } from "./inventory/index.js";
import { userDataPath } from "./userDataDir.js";

export type InternalSkillsSettings = {
  /** Paths or lowercased names of skills disabled internally */
  disabled: string[];
  /** Identifiers or directories of plugins disabled internally */
  disabledPlugins: string[];
};

const InternalSkillsSettingsSchema = z.object({
  disabled: z.array(z.string().trim().min(1)).default([]),
  disabledPlugins: z.array(z.string().trim().min(1)).default([]),
});

let cachedPath: string | null = null;
function settingsFilePath(): string {
  cachedPath ??= userDataPath("skills-settings.json");
  return cachedPath;
}

function sanitize(raw: JsonValue | null | undefined): InternalSkillsSettings {
  const parsed = InternalSkillsSettingsSchema.safeParse(raw);
  if (!parsed.success) return { disabled: [], disabledPlugins: [] };
  return {
    disabled: Array.from(new Set(parsed.data.disabled)),
    disabledPlugins: Array.from(new Set(parsed.data.disabledPlugins)),
  };
}

let cache: InternalSkillsSettings | null = null;

/** Read persisted internal skill settings. Falls back to empty arrays on unreadable or missing file. */
export function readInternalSkillsSettings(): InternalSkillsSettings {
  if (cache) return cache;
  try {
    // SAFETY: JSON.parse produces primitive/object structures conforming to JsonValue
    const raw = JSON.parse(fs.readFileSync(settingsFilePath(), "utf8")) as JsonValue;
    cache = sanitize(raw);
  } catch {
    cache = { disabled: [], disabledPlugins: [] };
  }
  return cache;
}

/** Write updated internal skill settings to disk atomically and update memory cache. */
export function writeInternalSkillsSettings(
  patch: Partial<InternalSkillsSettings>,
): InternalSkillsSettings {
  const current = readInternalSkillsSettings();
  const next: InternalSkillsSettings = sanitize({
    disabled: patch.disabled ?? current.disabled,
    disabledPlugins: patch.disabledPlugins ?? current.disabledPlugins,
  });
  cache = next;
  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(next, null, 2));
  } catch {
    // Best-effort file persistence; in-memory cache remains updated for the session
  }
  clearAgentInventoryCache();
  return next;
}

/** Check whether a skill is enabled under internal settings. */
export function isSkillInternallyEnabled(
  skill: { path?: string; name: string },
  settings: InternalSkillsSettings = readInternalSkillsSettings(),
): boolean {
  const pathKey = skill.path?.trim().toLowerCase();
  const nameKey = skill.name.trim().toLowerCase();
  for (const item of settings.disabled) {
    const lower = item.toLowerCase();
    if (pathKey && lower === pathKey) return false;
    if (nameKey && lower === nameKey) return false;
  }
  return true;
}

/** Check whether a plugin is enabled under internal settings. */
export function isPluginInternallyEnabled(
  pluginIdOrDir: string,
  settings: InternalSkillsSettings = readInternalSkillsSettings(),
): boolean {
  const key = pluginIdOrDir.trim().toLowerCase();
  for (const item of settings.disabledPlugins) {
    if (item.toLowerCase() === key) return false;
  }
  return true;
}

/** Update the internal enabled state of a specific skill. */
export function setSkillInternalState(
  skill: { path?: string; name: string },
  enabled: boolean,
): InternalSkillsSettings {
  const current = readInternalSkillsSettings();
  const nextDisabled = new Set(current.disabled);
  const pathKey = skill.path?.trim();
  const nameKey = skill.name.trim().toLowerCase();

  if (enabled) {
    if (pathKey) nextDisabled.delete(pathKey);
    nextDisabled.delete(nameKey);
    for (const item of Array.from(nextDisabled)) {
      const lower = item.toLowerCase();
      if ((pathKey && lower === pathKey.toLowerCase()) || lower === nameKey) {
        nextDisabled.delete(item);
      }
    }
  } else {
    if (pathKey) {
      nextDisabled.add(pathKey);
    } else {
      nextDisabled.add(nameKey);
    }
  }

  return writeInternalSkillsSettings({
    disabled: Array.from(nextDisabled),
  });
}

/** Update the internal enabled state of a specific plugin. */
export function setPluginInternalState(
  pluginIdOrDir: string,
  enabled: boolean,
): InternalSkillsSettings {
  const current = readInternalSkillsSettings();
  const nextPlugins = new Set(current.disabledPlugins);
  const key = pluginIdOrDir.trim();

  if (enabled) {
    nextPlugins.delete(key);
    for (const item of Array.from(nextPlugins)) {
      if (item.toLowerCase() === key.toLowerCase()) {
        nextPlugins.delete(item);
      }
    }
  } else {
    nextPlugins.add(key);
  }

  return writeInternalSkillsSettings({
    disabledPlugins: Array.from(nextPlugins),
  });
}

export function resetInternalSkillsSettingsCacheForTesting(): void {
  cache = null;
  cachedPath = null;
}
