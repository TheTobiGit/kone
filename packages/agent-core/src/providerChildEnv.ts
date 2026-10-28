import os from "node:os";
import path from "node:path";

import { deleteEnvVar, envValue, setEnvVar } from "./envKeys.js";
import { readProviderSettings } from "./providerSettings.js";
import type { ProviderKind, ProviderSettingsMap } from "./types.js";

const HOME_ENV_BY_PROVIDER = {
  codex: "CODEX_HOME",
  claudeAgent: "CLAUDE_CONFIG_DIR",
  opencode: "OPENCODE_CONFIG_DIR",
  cursor: "CURSOR_CONFIG_DIR",
  droid: "DROID_HOME",
  cline: "CLINE_DATA_DIR",
  antigravity: "ANTIGRAVITY_HOME",
} satisfies Record<ProviderKind, string>;

const DEFAULT_HOME_BY_PROVIDER = {
  codex: "~/.codex",
  claudeAgent: "~/.claude",
  opencode: "~/.config/opencode",
  cursor: "~/.cursor",
  droid: "~/.factory",
  cline: "~/.cline",
  antigravity: "~/.gemini/antigravity-cli",
} satisfies Record<ProviderKind, string>;

const STRIPPED_KEYS = new Set(["NODE_OPTIONS", "ELECTRON_RUN_AS_NODE"]);

/** The environment variable name a provider's CLI reads for its home/config dir. */
export function homeEnvVarFor(provider: ProviderKind): string {
  return HOME_ENV_BY_PROVIDER[provider];
}

/** The default display path for a provider's home/config dir. */
export function defaultHomeDirFor(provider: ProviderKind): string {
  return DEFAULT_HOME_BY_PROVIDER[provider];
}

/** Expand a leading `~` or `~/...` against the user's home directory. */
export function expandHomePath(raw: string, home: string = os.homedir()): string {
  const trimmed = raw.trim();
  if (trimmed === "~") return home;
  if (trimmed.startsWith("~/") || trimmed.startsWith("~\\")) {
    return path.join(home, trimmed.slice(2));
  }
  return trimmed;
}

/** Build the sanitized child-process environment for `provider`:
 *  1. Strips `NODE_OPTIONS`, `ELECTRON_RUN_AS_NODE`, and internal `KONE_*` variables.
 *  2. Maps a configured `homeDir` (expanding `~`) onto the provider CLI's home env var.
 *  3. Applies the provider's configured `env` variables. Ordinary entries carry
 *     their stored value; a `secret` entry carries no value and is read from the
 *     same-named variable in `baseEnv`, so kone never stores the credential. */
export function buildProviderChildEnv(
  provider: ProviderKind,
  baseEnv: NodeJS.ProcessEnv = process.env,
  settings: ProviderSettingsMap = readProviderSettings(),
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    const normalized = platform === "win32" ? key.toUpperCase() : key;
    if (STRIPPED_KEYS.has(normalized) || normalized.startsWith("KONE_")) continue;
    out[key] = value;
  }

  // Inherited references read the sanitized source, before any provider
  // settings can change a home variable or an earlier env entry.
  const inheritedEnv = { ...out };

  const config = settings[provider];
  const homeDir = config?.homeDir?.trim();
  if (homeDir) {
    const expanded = expandHomePath(homeDir);
    setEnvVar(out, HOME_ENV_BY_PROVIDER[provider], expanded, platform);
    if (provider === "cline") setEnvVar(out, "CLINE_DIR", expanded, platform);
  }

  if (config?.env?.length) {
    for (const item of config.env) {
      const name = item.name.trim();
      if (!name) continue;
      if (item.secret === true) {
        const inherited = envValue(inheritedEnv, name, platform);
        if (inherited === undefined) deleteEnvVar(out, name, platform);
        else setEnvVar(out, name, inherited, platform);
        continue;
      }
      setEnvVar(out, name, item.value, platform);
    }
  }

  return out;
}
