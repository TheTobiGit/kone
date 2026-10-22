import fs from "node:fs";

import { z } from "zod";

import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { writeFileAtomicSync } from "@kone/agent-core/lib-atomicWrite.js";

import type {
  LegacyRendererProviderSettings,
  ProviderConfig,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "./types.js";
import { PROVIDER_KIND_VALUES } from "./types.js";
import { DEFAULT_HANDOFF_TOKEN_CAP, clampHandoffTokenCap } from "./contextBudget.js";
import { userDataPath } from "./userDataDir.js";

// Persists the user's per-provider settings (a custom CLI binary path, whether
// a provider is enabled, which of its models are hidden, …) so every window and
// the agent adapters read one truth. kone holds no provider secrets, only how
// to reach the CLI the user already logged into.
//
// Stored as a small JSON envelope under the per-user app data directory, next
// to window-state.json, and read/written with the same plain, best-effort file
// I/O (no electron-store dependency, matching the rest of the desktop main
// process). The envelope carries a `revision` that every write advances, so a
// renderer can tell a stale push from a fresh one, and a `legacyRendererImported`
// flag so the old localStorage mirror is folded in exactly once.
//
// The file is the only source of truth: the renderer holds no settings of its
// own, it renders snapshots pushed after each write.

const KNOWN_PROVIDERS: readonly ProviderKind[] = PROVIDER_KIND_VALUES;

/** Bump when the envelope's shape changes, and add a migration for it. */
const CURRENT_VERSION = 1;

const ProviderConfigWire = z.object({
  binaryPath: z.string().trim().min(1).optional(),
  antigravityAuthMethod: z.string().trim().min(1).optional(),
  antigravityGcpProject: z.string().trim().min(1).optional(),
  antigravityGcpLocation: z.string().trim().min(1).optional(),
  enabled: z.boolean().optional(),
  handoffTokenCap: z.number().optional(),
  // A malformed list reads as "nothing hidden" rather than losing the rest of
  // the provider's settings with it.
  hiddenModels: z.array(z.string()).catch([]).optional(),
});

/** Any settings shape on disk: provider id → an object. Field-level junk inside
 *  an entry is sanitize's job; a non-object entry means this is not ours. */
const SettingsRecordWire = z.record(z.string(), z.record(z.string(), z.json().optional()));

/** The current on-disk shape. */
const SettingsEnvelopeWire = z.object({
  version: z.number().int().min(0),
  revision: z.number().int().min(0),
  settings: SettingsRecordWire,
  legacyRendererImported: z.boolean().optional(),
});

/** The renderer's old localStorage values, which arrive over IPC and so are
 *  decoded here rather than trusted. A junk toggle becomes `null` (= absent), a
 *  junk hidden list empty, and a field that is not a map at all contributes
 *  nothing — all entry by entry, so one bad provider never drops the rest. */
const LegacyRendererSettingsWire = z.object({
  enabled: z.record(z.string(), z.boolean().nullable().catch(null)).catch({}).optional(),
  hiddenModels: z.record(z.string(), z.array(z.string()).catch([])).catch({}).optional(),
});

/** The on-disk shape in memory. `settings` is the map the rest of the app works
 *  with. */
type SettingsEnvelope = {
  version: number;
  revision: number;
  settings: ProviderSettingsMap;
  legacyRendererImported: boolean;
};

/** One on-disk shape change. A file is upgraded by running every migration
 *  whose `version` is newer than the file's own; a bare settings map (the
 *  pre-envelope format) counts as version 0. */
export type ProviderSettingsMigration = {
  name: string;
  version: number;
  migrate: (raw: JsonValue) => JsonValue;
};

/** Named and ordered, so a test (and a future reader) can see every step the
 *  file has been through. */
export const PROVIDER_SETTINGS_MIGRATIONS: readonly ProviderSettingsMigration[] = [
  {
    name: "wrap-bare-settings",
    version: 1,
    // The bare map was the whole file; it becomes the envelope's settings.
    // Already-envelope input (a version-0 file from an early build) is left
    // alone, so running the list never nests one envelope in another.
    migrate: (raw) =>
      SettingsEnvelopeWire.safeParse(raw).success
        ? raw
        : { version: 1, revision: 0, settings: raw, legacyRendererImported: false },
  },
];

let cachedPath: string | null = null;
function settingsFilePath(): string {
  cachedPath ??= userDataPath("provider-settings.json");
  return cachedPath;
}

/** Trim, dedupe and drop the empties, so what is stored is exactly what the
 *  picker compares against. An empty list means "nothing hidden" and is not
 *  stored at all. */
function cleanHiddenModels(raw: readonly string[] | undefined): string[] | undefined {
  const out: string[] = [];
  for (const value of raw ?? []) {
    const model = value.trim();
    if (!model || out.includes(model)) continue;
    out.push(model);
  }
  return out.length > 0 ? out : undefined;
}

/** Keep only the fields we recognise, dropping anything malformed on disk so a
 *  hand-edited or version-skewed file can never feed junk into an adapter.
 *  `enabled` decodes to true when absent — being switched off is opt-in, so a
 *  settings file from before the toggle existed (or one that only stores a
 *  binary path) reads as fully enabled. */
function sanitize(raw: JsonValue | null | undefined): ProviderSettingsMap {
  const parsed = SettingsRecordWire.safeParse(raw);
  if (!parsed.success) return {};
  const out: ProviderSettingsMap = {};
  for (const provider of KNOWN_PROVIDERS) {
    // Entry by entry, so one provider's malformed field drops that provider
    // alone instead of every setting in the file.
    const decoded = ProviderConfigWire.safeParse(parsed.data[provider]);
    if (!decoded.success) continue;
    const entry = decoded.data;
    const clean: ProviderConfig = { enabled: entry.enabled ?? true };
    if (entry.binaryPath) clean.binaryPath = entry.binaryPath;
    // A handoff budget cap is a token count; clamp it here so a hand-edited
    // file can never feed an out-of-range value into the send path.
    if (entry.handoffTokenCap !== undefined) {
      clean.handoffTokenCap = clampHandoffTokenCap(entry.handoffTokenCap);
    }
    // Auth-method fields only ever persist for Antigravity — other providers
    // have no use for them and must not carry them.
    if (provider === "antigravity") {
      if (entry.antigravityAuthMethod) clean.antigravityAuthMethod = entry.antigravityAuthMethod;
      if (entry.antigravityGcpProject) clean.antigravityGcpProject = entry.antigravityGcpProject;
      if (entry.antigravityGcpLocation) clean.antigravityGcpLocation = entry.antigravityGcpLocation;
    }
    const hiddenModels = cleanHiddenModels(entry.hiddenModels);
    if (hiddenModels) clean.hiddenModels = hiddenModels;
    // `enabled` is always set (decoded to true when absent), so every entry
    // that reaches this point is worth keeping.
    out[provider] = clean;
  }
  return out;
}

function defaultEnvelope(): SettingsEnvelope {
  return { version: CURRENT_VERSION, revision: 0, settings: {}, legacyRendererImported: false };
}

/** Turn a decoded envelope into the in-memory shape: settings sanitized, and a
 *  version always this build's (an older file is upgraded now; a newer one's
 *  unknown fields cannot be carried by this build). */
function envelopeFrom(wire: z.infer<typeof SettingsEnvelopeWire>): SettingsEnvelope {
  return {
    version: CURRENT_VERSION,
    revision: wire.revision,
    settings: sanitize(wire.settings),
    legacyRendererImported: wire.legacyRendererImported === true,
  };
}

function runMigrations(raw: JsonValue, fromVersion: number): JsonValue {
  let value = raw;
  for (const migration of PROVIDER_SETTINGS_MIGRATIONS) {
    if (migration.version <= fromVersion) continue;
    value = migration.migrate(value);
  }
  return value;
}

/** Run the ordered migrations and decode the result. Null means a migration
 *  produced something this build cannot read, which the caller quarantines. */
function migrateAndDecode(
  parsed: JsonValue,
  fromVersion: number,
): { envelope: SettingsEnvelope; upgraded: boolean } | null {
  const migrated = SettingsEnvelopeWire.safeParse(runMigrations(parsed, fromVersion));
  return migrated.success
    ? { envelope: envelopeFrom(migrated.data), upgraded: true }
    : null;
}

/** Decode a parsed file into an envelope, or null when it is not a shape kone
 *  ever wrote (the caller quarantines that). A top-level object with no numeric
 *  `version` is the pre-envelope bare settings map and is migrated up. */
function decode(
  file: string,
  parsed: JsonValue,
): { envelope: SettingsEnvelope; upgraded: boolean } | null {
  const wire = SettingsEnvelopeWire.safeParse(parsed);
  if (wire.success) {
    if (wire.data.version > CURRENT_VERSION) {
      // A newer kone owns fields this build does not know about. Reading what
      // we can beats quarantining a file this build will never write.
      console.warn(
        `[providerSettings] ${file} was written by a newer kone (version ${wire.data.version} > ${CURRENT_VERSION}); reading it leniently.`,
      );
      return { envelope: envelopeFrom(wire.data), upgraded: false };
    }
    if (wire.data.version === CURRENT_VERSION) {
      return { envelope: envelopeFrom(wire.data), upgraded: false };
    }
    return migrateAndDecode(parsed, wire.data.version);
  }
  // Not an envelope: the pre-envelope format was a bare provider map. Its
  // field-level junk is sanitized after the migration, but the top level must
  // be provider id → object or this is not a settings file at all.
  if (!SettingsRecordWire.safeParse(parsed).success) return null;
  return migrateAndDecode(parsed, 0);
}

/** Move a file kone cannot decode out of the way so it is never read again, and
 *  say where it went. Best-effort: a read-only directory just keeps the file. */
function quarantine(file: string, reason: string): SettingsEnvelope {
  const target = `${file}.invalid-${Date.now()}`;
  try {
    fs.renameSync(file, target);
  } catch {
    // Nothing else to do — the defaults are what the app runs on either way.
  }
  console.warn(
    `[providerSettings] ${file} was ${reason}; moved it to ${target} and started from defaults.`,
  );
  return defaultEnvelope();
}

/** The best-effort write for the migration write-back on first read: an upgrade
 *  that cannot be saved just happens again on the next read. User writes go
 *  through {@link commit}, which surfaces the failure. */
function persist(envelope: SettingsEnvelope): void {
  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(envelope, null, 2));
  } catch {
    // Persisting is best-effort; never crash the app over a settings write.
  }
}

let cache: SettingsEnvelope | null = null;
const listeners = new Set<(snapshot: ProviderSettingsSnapshot) => void>();

function snapshotOf(envelope: SettingsEnvelope): ProviderSettingsSnapshot {
  return {
    revision: envelope.revision,
    settings: envelope.settings,
    legacyImportPending: !envelope.legacyRendererImported,
  };
}

function readEnvelope(): SettingsEnvelope {
  if (cache) return cache;
  const file = settingsFilePath();
  // A first run has no file at all — that is the normal empty case, not a
  // problem worth a warning (and nothing to quarantine).
  if (!fs.existsSync(file)) {
    cache = defaultEnvelope();
    return cache;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    // Unreadable for a reason other than absence: still start clean, but say so
    // and leave the file where it is — it may be a permissions problem, not a
    // bad file.
    console.warn(
      `[providerSettings] could not read ${file}: ${String(error)}; starting from defaults.`,
    );
    cache = defaultEnvelope();
    return cache;
  }
  let parsed: JsonValue;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    cache = quarantine(file, `not valid JSON (${String(error)})`);
    return cache;
  }
  const decoded = decode(file, parsed);
  if (!decoded) {
    cache = quarantine(file, "not a settings file kone wrote");
    return cache;
  }
  cache = decoded.envelope;
  // An older file is upgraded in place on first read, so the next boot reads
  // the envelope directly.
  if (decoded.upgraded) persist(cache);
  return cache;
}

/** The persisted provider settings, read from disk once and cached. A missing
 *  or unreadable file is a clean empty map — every adapter then runs on its
 *  built-in default. */
export function readProviderSettings(): ProviderSettingsMap {
  return readEnvelope().settings;
}

/** What a renderer needs to mirror this store: the revision it is at, the
 *  settings themselves, and whether it still owes us its legacy localStorage
 *  values. */
export function readProviderSettingsSnapshot(): ProviderSettingsSnapshot {
  return snapshotOf(readEnvelope());
}

/** Subscribe to settings changes. Fires after every write, with the revision the
 *  write produced. Returns an unsubscribe fn. */
export function onProviderSettingsChanged(
  listener: (snapshot: ProviderSettingsSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The single write path: persist, then advance the revision and announce.
 *  Every setter routes through here, so a renderer's revision is a faithful
 *  count of the settings it has yet to see.
 *
 *  The file is the source of truth, so it is written FIRST: a write that fails
 *  leaves the cache, the revision and every listener untouched and throws, and
 *  the caller's rejection then agrees with what a reload will read. */
function commit(
  settings: ProviderSettingsMap,
  flags: { legacyRendererImported?: boolean } = {},
): SettingsEnvelope {
  const current = readEnvelope();
  const next: SettingsEnvelope = {
    version: CURRENT_VERSION,
    revision: current.revision + 1,
    settings,
    legacyRendererImported: flags.legacyRendererImported ?? current.legacyRendererImported,
  };
  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(next, null, 2));
  } catch (error) {
    throw new Error(
      `Provider settings could not be saved: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  cache = next;
  const snapshot = snapshotOf(cache);
  for (const listener of listeners) {
    try {
      listener(snapshot);
    } catch (error) {
      // One bad subscriber must not strand the others or the write.
      console.error("[providerSettings] settings listener failed:", error);
    }
  }
  return cache;
}

/** Replace the persisted settings for one provider and write the whole map back
 *  to disk. Returns the updated full map. */
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
  return commit(next).settings;
}

/** Merge just the fields a renderer changed onto the provider's CURRENT entry
 *  and persist the result. `setProviderSettings` replaces the entry, so two
 *  windows editing different fields of one provider would undo each other; a
 *  patch is built from what the window changed, not from its snapshot. A field
 *  whose value is `undefined` is removed. Returns the updated full map. */
export function patchProviderSettings(
  provider: ProviderKind,
  patch: ProviderConfig,
): ProviderSettingsMap {
  // A provider with no entry is fully enabled, so a patch creates that entry
  // rather than a half-populated one.
  const merged: ProviderConfig = { ...(readProviderSettings()[provider] ?? { enabled: true }) };
  for (const key of ProviderConfigWire.keyof().options) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else Object.assign(merged, { [key]: value });
  }
  return writeProviderSettings(provider, merged);
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

/** The effective handoff history cap, in tokens, for a provider — the stored
 *  setting clamped to the module's bounds, or the built-in default when the
 *  provider never set one. */
export function handoffTokenCapFor(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): number {
  const stored = settings[provider]?.handoffTokenCap;
  return stored !== undefined ? clampHandoffTokenCap(stored) : DEFAULT_HANDOFF_TOKEN_CAP;
}

/** Set one provider's handoff history cap and persist it, preserving its other
 *  settings. Returns the updated full map. */
export function setProviderHandoffTokenCap(
  provider: ProviderKind,
  cap: number,
): ProviderSettingsMap {
  const current = readProviderSettings()[provider] ?? {};
  return writeProviderSettings(provider, {
    ...current,
    handoffTokenCap: clampHandoffTokenCap(cap),
  });
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

/** Fold the renderer's legacy localStorage mirror into the store — once, ever.
 *
 *  The file wins; localStorage only fills gaps. Per provider: `enabled` from the
 *  legacy value applies only when the file has no entry at all (every toggle the
 *  old renderer wrote already reached the file, so an existing entry is
 *  authoritative), and `hiddenModels` applies only when that entry has no hidden
 *  list (the store never held one before, so in practice it is imported).
 *  Everything else in the file is untouched. */
export function importLegacyRendererSettings(
  legacy: LegacyRendererProviderSettings,
): ProviderSettingsSnapshot {
  const envelope = readEnvelope();
  if (envelope.legacyRendererImported) return snapshotOf(envelope);

  // It crossed IPC from the renderer's localStorage: decode it, don't trust it.
  const wire = LegacyRendererSettingsWire.safeParse(legacy);
  const next: ProviderSettingsMap = { ...envelope.settings };
  for (const provider of KNOWN_PROVIDERS) {
    // A junk toggle decodes to null = absent; a junk hidden list to empty.
    const enabled = wire.data?.enabled?.[provider] ?? undefined;
    const hiddenModels = cleanHiddenModels(wire.data?.hiddenModels?.[provider]);

    const existing = next[provider];
    if (!existing) {
      if (enabled === undefined && !hiddenModels) continue;
      const created: ProviderConfig = { enabled: enabled ?? true };
      if (hiddenModels) created.hiddenModels = hiddenModels;
      next[provider] = created;
      continue;
    }
    if (hiddenModels && existing.hiddenModels === undefined) {
      next[provider] = { ...existing, hiddenModels };
    }
  }

  return snapshotOf(commit(next, { legacyRendererImported: true }));
}

/** Test seam: forget the cached path, envelope and listeners so the next call
 *  re-reads whatever directory the test just handed `setUserDataDir`. */
export function resetProviderSettingsForTests(): void {
  cachedPath = null;
  cache = null;
  listeners.clear();
}
