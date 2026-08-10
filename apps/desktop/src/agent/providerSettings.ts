import fs from "node:fs";

import type { ProviderConfig, ProviderKind, ProviderSettingsMap } from "./types.js";
import { userDataPath } from "./userDataDir.js";

// Persists the user's per-provider install settings (a custom CLI binary path,
// today) so the agent adapters can be pointed at a non-default install between
// launches. kone holds no provider secrets, only how to reach the CLI the user
// already logged into.
//
// Stored as a small JSON file under the per-user app data directory, next to
// window-state.json, and read/written with the same plain, best-effort file I/O
// (no electron-store dependency, matching the rest of the desktop main process).

const KNOWN_PROVIDERS: ProviderKind[] = ["codex", "claudeAgent", "opencode", "cursor", "droid"];

let cachedPath: string | null = null;
function settingsFilePath(): string {
  cachedPath ??= userDataPath("provider-settings.json");
  return cachedPath;
}

/** Keep only the fields we recognise, dropping anything malformed on disk so a
 *  hand-edited or version-skewed file can never feed junk into an adapter. */
function sanitize(raw: unknown): ProviderSettingsMap {
  if (!raw || typeof raw !== "object") return {};
  const out: ProviderSettingsMap = {};
  for (const provider of KNOWN_PROVIDERS) {
    const entry = (raw as Record<string, unknown>)[provider];
    if (!entry || typeof entry !== "object") continue;
    const config: ProviderConfig = {};
    const binaryPath = (entry as Record<string, unknown>).binaryPath;
    if (typeof binaryPath === "string" && binaryPath.trim()) {
      config.binaryPath = binaryPath.trim();
    }
    if (Object.keys(config).length) out[provider] = config;
  }
  return out;
}

let cache: ProviderSettingsMap | null = null;

/** The persisted provider settings, read from disk once and cached. A missing
 *  or unreadable file is a clean empty map — every adapter then runs on its
 *  built-in default. */
export function readProviderSettings(): ProviderSettingsMap {
  if (cache) return cache;
  try {
    cache = sanitize(JSON.parse(fs.readFileSync(settingsFilePath(), "utf8")));
  } catch {
    cache = {};
  }
  return cache;
}

/** Replace the persisted settings for one provider and write the whole map back
 *  to disk. Returns the updated full map. Best-effort on the write — an I/O
 *  failure keeps the in-memory cache authoritative for the session so the UI
 *  still reflects the change. */
export function writeProviderSettings(
  provider: ProviderKind,
  config: ProviderConfig,
): ProviderSettingsMap {
  const next = { ...readProviderSettings() };
  const clean = sanitize({ [provider]: config })[provider];
  if (clean && Object.keys(clean).length) next[provider] = clean;
  else delete next[provider];
  cache = next;
  try {
    fs.writeFileSync(settingsFilePath(), JSON.stringify(next, null, 2), "utf8");
  } catch {
    // Persisting is best-effort; never crash the app over a settings write.
  }
  return next;
}
