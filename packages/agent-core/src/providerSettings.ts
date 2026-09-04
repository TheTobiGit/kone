import fs from "node:fs";

import { z } from "zod";

import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { writeFileAtomicSync } from "@kone/agent-core/lib-atomicWrite.js";

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

const KNOWN_PROVIDERS: ProviderKind[] = ["codex", "claudeAgent", "opencode", "cursor", "droid", "antigravity"];

const ProviderConfigWire = z.object({
  binaryPath: z.string().trim().min(1).optional(),
  antigravityAuthMethod: z.string().trim().min(1).optional(),
  antigravityGcpProject: z.string().trim().min(1).optional(),
  antigravityGcpLocation: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
});

const ProviderSettingsWire = z.record(z.string(), ProviderConfigWire);

let cachedPath: string | null = null;
function settingsFilePath(): string {
  cachedPath ??= userDataPath("provider-settings.json");
  return cachedPath;
}

/** Keep only the fields we recognise, dropping anything malformed on disk so a
 *  hand-edited or version-skewed file can never feed junk into an adapter.
 *  `enabled` decodes to true when absent — being switched off is opt-in, so a
 *  settings file from before the toggle existed (or one that only stores a
 *  binary path) reads as fully enabled. */
function sanitize(raw: JsonValue | null | undefined): ProviderSettingsMap {
  const parsed = ProviderSettingsWire.safeParse(raw);
  if (!parsed.success) return {};
  const out: ProviderSettingsMap = {};
  for (const provider of KNOWN_PROVIDERS) {
    const entry = parsed.data[provider];
    if (!entry) continue;
    const clean: ProviderConfig = { enabled: entry.enabled ?? true };
    if (entry.binaryPath) clean.binaryPath = entry.binaryPath;
    // Auth-method fields only ever persist for Antigravity — other providers
    // have no use for them and must not carry them.
    if (provider === "antigravity") {
      if (entry.antigravityAuthMethod) clean.antigravityAuthMethod = entry.antigravityAuthMethod;
      if (entry.antigravityGcpProject) clean.antigravityGcpProject = entry.antigravityGcpProject;
      if (entry.antigravityGcpLocation) clean.antigravityGcpLocation = entry.antigravityGcpLocation;
    }
    // `enabled` is always set (decoded to true when absent), so every entry
    // that reaches this point is worth keeping.
    out[provider] = clean;
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
  // `sanitize` always decodes a known provider to a definite entry (at minimum
  // `{ enabled: true }`), so a write never deletes — clearing every field is
  // the same as the default, and the entry says so explicitly.
  if (clean) next[provider] = clean;
  else delete next[provider];
  cache = next;
  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(next, null, 2));
  } catch {
    // Persisting is best-effort; never crash the app over a settings write.
  }
  return next;
}

/** Whether a provider is enabled in app settings (opt-out; default is true). */
export function isProviderEnabled(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): boolean {
  return settings[provider]?.enabled !== false;
}

/** Enable or disable a provider across the app and persist the change. */
export function setProviderEnabled(
  provider: ProviderKind,
  enabled: boolean,
): ProviderSettingsMap {
  const current = readProviderSettings()[provider] ?? {};
  return writeProviderSettings(provider, { ...current, enabled });
}

/** Throw the canonical "provider is disabled" error unless the provider is
 *  enabled in the given settings. The single enforcement point for the send
 *  path — startSession and follow-up turns share this message verbatim so a
 *  disabled provider fails identically wherever the turn is gated. */
export function assertProviderEnabled(
  settings: ProviderSettingsMap,
  provider: ProviderKind,
): void {
  if (!isProviderEnabled(provider, settings)) {
    throw new Error(`Provider "${provider}" is disabled in app settings.`);
  }
}
