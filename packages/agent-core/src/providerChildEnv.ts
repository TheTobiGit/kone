import os from "node:os";
import path from "node:path";

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
 *  3. Overlays the provider's configured `env` variables. */
export function buildProviderChildEnv(
  provider: ProviderKind,
  baseEnv: NodeJS.ProcessEnv = process.env,
  settings: ProviderSettingsMap = readProviderSettings(),
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(baseEnv)) {
    if (STRIPPED_KEYS.has(key) || key.startsWith("KONE_")) continue;
    out[key] = value;
  }

  const config = settings[provider];
  const homeDir = config?.homeDir?.trim();
  if (homeDir) {
    const expanded = expandHomePath(homeDir);
    out[HOME_ENV_BY_PROVIDER[provider]] = expanded;
    if (provider === "cline") out.CLINE_DIR = expanded;
  }

  if (config?.env?.length) {
    for (const item of config.env) {
      const name = item.name.trim();
      if (!name) continue;
      out[name] = item.value;
    }
  }

  return out;
}
