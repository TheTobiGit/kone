import fs from "node:fs";

import { z } from "zod";

import type { JsonValue } from "@kone/agent-core/lib-jsonValue.js";
import { writeFileAtomicSync } from "@kone/agent-core/lib-atomicWrite.js";

import type {
  GlobalProviderSettingsPatch,
  LegacyRendererProviderSettings,
  ProviderConfig,
  ProviderEnvVar,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "./types.js";
import { PROVIDER_KIND_VALUES, isProviderKind } from "./types.js";
import { DEFAULT_HANDOFF_TOKEN_CAP, clampHandoffTokenCap } from "./contextBudget.js";
import { userDataPath } from "./userDataDir.js";

const KNOWN_PROVIDERS: readonly ProviderKind[] = PROVIDER_KIND_VALUES;

/** Bump when the envelope's shape changes, and add a migration for it. */
const CURRENT_VERSION = 1;

export const DEFAULT_HEALTH_CHECK_INTERVAL_SEC = 300;
const MAX_HEALTH_CHECK_INTERVAL_SEC = 86_400;

const ProviderEnvVarWire = z.object({
  name: z.string(),
  value: z.string().catch(""),
  secret: z.boolean().optional().catch(undefined),
});

const ProviderConfigWire = z.object({
  binaryPath: z.string().trim().min(1).optional().catch(undefined),
  enabled: z.boolean().optional(),
  showInPicker: z.boolean().optional().catch(undefined),
  handoffTokenCap: z.number().optional(),
  hiddenModels: z.array(z.string()).catch([]).optional(),
  customModels: z.array(z.string()).catch([]).optional(),
  homeDir: z.string().trim().min(1).optional().catch(undefined),
  env: z.array(ProviderEnvVarWire).catch([]).optional(),
  resumeAtReset: z.boolean().optional().catch(undefined),
  snoozeWhenLimited: z.boolean().optional().catch(undefined),
});

const SettingsRecordWire = z.record(z.string(), z.record(z.string(), z.json().optional()));

const SettingsEnvelopeWire = z.object({
  version: z.number().int().min(0),
  revision: z.number().int().min(0),
  settings: SettingsRecordWire,
  legacyRendererImported: z.boolean().optional(),
  providerOrder: z.array(z.string()).catch([]).optional(),
  healthCheckIntervalSec: z.number().optional().catch(undefined),
});

const LegacyRendererSettingsWire = z.object({
  enabled: z.record(z.string(), z.boolean().nullable().catch(null)).catch({}).optional(),
  hiddenModels: z.record(z.string(), z.array(z.string()).catch([])).catch({}).optional(),
});

type CommitFlags = {
  legacyRendererImported?: boolean;
  providerOrder?: ProviderKind[] | null;
  healthCheckIntervalSec?: number | null;
};

type SettingsEnvelope = {
  version: number;
  revision: number;
  settings: ProviderSettingsMap;
  legacyRendererImported: boolean;
  providerOrder?: ProviderKind[];
  healthCheckIntervalSec?: number;
};

export type ProviderSettingsMigration = {
  name: string;
  version: number;
  migrate: (raw: JsonValue) => JsonValue;
};

export const PROVIDER_SETTINGS_MIGRATIONS: readonly ProviderSettingsMigration[] = [
  {
    name: "wrap-bare-settings",
    version: 1,
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

function cleanStringList(raw: readonly string[] | undefined): string[] | undefined {
  const out: string[] = [];
  for (const value of raw ?? []) {
    const trimmed = value.trim();
    if (!trimmed || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

type CleanEnvVars = {
  env?: ProviderEnvVar[];
  /** Secret variables whose stored value was dropped. Only the names are kept,
   *  so a legacy literal never travels any further than this decode. */
  strippedSecretNames: string[];
};

function cleanEnvVars(raw: readonly ProviderEnvVar[] | undefined): CleanEnvVars {
  const out: ProviderEnvVar[] = [];
  const strippedSecretNames: string[] = [];
  for (const item of raw ?? []) {
    const name = item.name.trim();
    if (!name) continue;
    const secret = item.secret === true;
    const entry: ProviderEnvVar = secret
      ? { name, value: "", secret: true }
      : { name, value: item.value };
    if (secret && item.value.length > 0) strippedSecretNames.push(name);
    const existingIdx = out.findIndex((e) => e.name === name);
    if (existingIdx >= 0) out[existingIdx] = entry;
    else out.push(entry);
  }
  return {
    env: out.length > 0 ? out : undefined,
    strippedSecretNames,
  };
}

function cleanProviderOrder(raw: readonly string[] | undefined): ProviderKind[] | undefined {
  const out: ProviderKind[] = [];
  for (const item of raw ?? []) {
    const trimmed = item.trim();
    if (!isProviderKind(trimmed) || out.includes(trimmed)) continue;
    out.push(trimmed);
  }
  return out.length > 0 ? out : undefined;
}

function clampHealthIntervalSec(raw: number | undefined): number | undefined {
  if (raw === undefined || !Number.isFinite(raw)) return undefined;
  const rounded = Math.round(raw);
  if (rounded <= 0) return 0;
  return Math.min(MAX_HEALTH_CHECK_INTERVAL_SEC, Math.max(15, rounded));
}

type SanitizedSettings = {
  settings: ProviderSettingsMap;
  strippedSecretNames: string[];
};

function sanitizeWithReport(
  raw: JsonValue | ProviderSettingsMap | null | undefined,
): SanitizedSettings {
  const parsed = SettingsRecordWire.safeParse(raw);
  if (!parsed.success) return { settings: {}, strippedSecretNames: [] };
  const settings: ProviderSettingsMap = {};
  const strippedSecretNames: string[] = [];
  for (const provider of KNOWN_PROVIDERS) {
    const decoded = ProviderConfigWire.safeParse(parsed.data[provider]);
    if (!decoded.success) continue;
    const entry = decoded.data;
    const clean: ProviderConfig = { enabled: entry.enabled ?? true };
    if (entry.binaryPath) clean.binaryPath = entry.binaryPath;
    if (entry.showInPicker !== undefined) clean.showInPicker = entry.showInPicker;
    if (entry.handoffTokenCap !== undefined) {
      clean.handoffTokenCap = clampHandoffTokenCap(entry.handoffTokenCap);
    }
    const hiddenModels = cleanStringList(entry.hiddenModels);
    if (hiddenModels) clean.hiddenModels = hiddenModels;
    const customModels = cleanStringList(entry.customModels);
    if (customModels) clean.customModels = customModels;
    if (entry.homeDir) clean.homeDir = entry.homeDir;
    const env = cleanEnvVars(entry.env);
    if (env.env) clean.env = env.env;
    strippedSecretNames.push(...env.strippedSecretNames);
    if (entry.resumeAtReset !== undefined) clean.resumeAtReset = entry.resumeAtReset;
    if (entry.snoozeWhenLimited !== undefined) clean.snoozeWhenLimited = entry.snoozeWhenLimited;
    settings[provider] = clean;
  }
  return { settings, strippedSecretNames };
}

function sanitize(raw: JsonValue | ProviderSettingsMap | null | undefined): ProviderSettingsMap {
  return sanitizeWithReport(raw).settings;
}

function defaultEnvelope(): SettingsEnvelope {
  return { version: CURRENT_VERSION, revision: 0, settings: {}, legacyRendererImported: false };
}

type DecodedSettings = {
  envelope: SettingsEnvelope;
  upgraded: boolean;
  /** False for a file from a newer kone: read leniently, never rewritten. */
  persistable: boolean;
  strippedSecretNames: string[];
};

function envelopeFrom(wire: z.infer<typeof SettingsEnvelopeWire>): DecodedSettings {
  const sanitized = sanitizeWithReport(wire.settings);
  const envelope: SettingsEnvelope = {
    version: CURRENT_VERSION,
    revision: wire.revision,
    settings: sanitized.settings,
    legacyRendererImported: wire.legacyRendererImported === true,
  };
  const order = cleanProviderOrder(wire.providerOrder);
  if (order) envelope.providerOrder = order;
  const interval = clampHealthIntervalSec(wire.healthCheckIntervalSec);
  if (interval !== undefined) envelope.healthCheckIntervalSec = interval;
  return {
    envelope,
    upgraded: false,
    persistable: true,
    strippedSecretNames: sanitized.strippedSecretNames,
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

function migrateAndDecode(parsed: JsonValue, fromVersion: number): DecodedSettings | null {
  const migrated = SettingsEnvelopeWire.safeParse(runMigrations(parsed, fromVersion));
  if (!migrated.success) return null;
  const decoded = envelopeFrom(migrated.data);
  return { ...decoded, upgraded: true };
}

function decode(file: string, parsed: JsonValue): DecodedSettings | null {
  const wire = SettingsEnvelopeWire.safeParse(parsed);
  if (wire.success) {
    if (wire.data.version > CURRENT_VERSION) {
      console.warn(
        `[providerSettings] ${file} was written by a newer kone (version ${wire.data.version} > ${CURRENT_VERSION}); reading it leniently.`,
      );
      return { ...envelopeFrom(wire.data), persistable: false };
    }
    if (wire.data.version === CURRENT_VERSION) {
      return envelopeFrom(wire.data);
    }
    return migrateAndDecode(parsed, wire.data.version);
  }
  if (!SettingsRecordWire.safeParse(parsed).success) return null;
  return migrateAndDecode(parsed, 0);
}

function quarantine(file: string, reason: string): SettingsEnvelope {
  const target = `${file}.invalid-${Date.now()}`;
  try {
    fs.renameSync(file, target);
    console.warn(`[providerSettings] quarantined ${file} -> ${target}: ${reason}`);
  } catch (error) {
    console.warn(
      `[providerSettings] could not quarantine ${file} -> ${target} (${reason}): ${String(error)}`,
    );
  }
  return defaultEnvelope();
}

function persist(envelope: SettingsEnvelope): void {
  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(envelope, null, 2), { mode: 0o600 });
  } catch (error) {
    console.error("[providerSettings] failed to write provider-settings.json:", error);
  }
}

let cache: SettingsEnvelope | null = null;
const listeners = new Set<(snapshot: ProviderSettingsSnapshot) => void>();

/** The settings a snapshot may carry. Secret entries reach here with an empty
 *  value already; restating that here keeps a future write path from leaking a
 *  literal through the general snapshot by accident. */
function snapshotSettings(settings: ProviderSettingsMap): ProviderSettingsMap {
  const out: ProviderSettingsMap = {};
  for (const provider of KNOWN_PROVIDERS) {
    const config = settings[provider];
    if (!config) continue;
    const copy: ProviderConfig = { ...config };
    if (config.env) {
      copy.env = config.env.map((item) =>
        item.secret === true ? { name: item.name, value: "", secret: true } : { ...item },
      );
    }
    out[provider] = copy;
  }
  return out;
}

function snapshotOf(envelope: SettingsEnvelope): ProviderSettingsSnapshot {
  const snap: ProviderSettingsSnapshot = {
    revision: envelope.revision,
    settings: snapshotSettings(envelope.settings),
    legacyImportPending: !envelope.legacyRendererImported,
  };
  if (envelope.providerOrder) snap.providerOrder = [...envelope.providerOrder];
  if (envelope.healthCheckIntervalSec !== undefined) {
    snap.healthCheckIntervalSec = envelope.healthCheckIntervalSec;
  }
  return snap;
}

function readEnvelope(): SettingsEnvelope {
  if (cache) return cache;
  const file = settingsFilePath();
  if (!fs.existsSync(file)) {
    cache = defaultEnvelope();
    return cache;
  }
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
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
  if (decoded.strippedSecretNames.length > 0) {
    // A pre-boundary file stored the literal. Drop it from disk without ever
    // naming the value; the variable is now inherited from the environment.
    console.warn(
      `[providerSettings] removed stored values for secret env vars (${decoded.strippedSecretNames.join(", ")}); they are now read from the environment.`,
    );
  }
  if (decoded.persistable && (decoded.upgraded || decoded.strippedSecretNames.length > 0)) {
    persist(cache);
  }
  return cache;
}

export function readProviderSettings(): ProviderSettingsMap {
  return readEnvelope().settings;
}

export function readProviderSettingsSnapshot(): ProviderSettingsSnapshot {
  return snapshotOf(readEnvelope());
}

export function onProviderSettingsChanged(
  listener: (snapshot: ProviderSettingsSnapshot) => void,
): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function commit(
  settings: ProviderSettingsMap,
  flags: CommitFlags = {},
): SettingsEnvelope {
  const current = readEnvelope();
  const next: SettingsEnvelope = {
    version: CURRENT_VERSION,
    revision: current.revision + 1,
    settings: sanitize(settings),
    legacyRendererImported: flags.legacyRendererImported ?? current.legacyRendererImported,
  };
  const nextOrder =
    flags.providerOrder === undefined
      ? current.providerOrder
      : flags.providerOrder ?? undefined;
  if (nextOrder?.length) next.providerOrder = nextOrder;

  const nextInterval =
    flags.healthCheckIntervalSec === undefined
      ? current.healthCheckIntervalSec
      : flags.healthCheckIntervalSec ?? undefined;
  if (nextInterval !== undefined) next.healthCheckIntervalSec = nextInterval;

  try {
    writeFileAtomicSync(settingsFilePath(), JSON.stringify(next, null, 2), { mode: 0o600 });
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
      console.error("[providerSettings] settings listener failed:", error);
    }
  }
  return cache;
}

export function writeProviderSettings(
  provider: ProviderKind,
  config: ProviderConfig,
): ProviderSettingsMap {
  const next = { ...readProviderSettings() };
  const clean = sanitize({ [provider]: config })[provider];
  if (clean) next[provider] = clean;
  else delete next[provider];
  return commit(next).settings;
}

export function patchProviderSettings(
  provider: ProviderKind,
  patch: ProviderConfig,
): ProviderSettingsMap {
  const merged: ProviderConfig = { ...(readProviderSettings()[provider] ?? { enabled: true }) };
  for (const key of ProviderConfigWire.keyof().options) {
    if (!(key in patch)) continue;
    const value = patch[key];
    if (value === undefined) delete merged[key];
    else Object.assign(merged, { [key]: value });
  }
  return writeProviderSettings(provider, merged);
}

/** Update top-level provider settings (`providerOrder`, `healthCheckIntervalSec`)
 *  and return the resulting snapshot. */
export function patchGlobalProviderSettings(
  patch: GlobalProviderSettingsPatch,
): ProviderSettingsSnapshot {
  const current = readEnvelope();
  const flags: CommitFlags = {};
  if ("providerOrder" in patch) {
    flags.providerOrder = cleanProviderOrder(patch.providerOrder) ?? null;
  }
  if ("healthCheckIntervalSec" in patch) {
    const clamped = clampHealthIntervalSec(patch.healthCheckIntervalSec);
    flags.healthCheckIntervalSec = clamped ?? null;
  }
  return snapshotOf(commit(current.settings, flags));
}

export function isProviderEnabled(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): boolean {
  return settings[provider]?.enabled !== false;
}

export function setProviderEnabled(
  provider: ProviderKind,
  enabled: boolean,
): ProviderSettingsMap {
  const current = readProviderSettings()[provider] ?? {};
  return writeProviderSettings(provider, { ...current, enabled });
}

/** Whether a provider is shown in the model picker when enabled (default true). */
export function isProviderShownInPicker(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): boolean {
  if (!isProviderEnabled(provider, settings)) return false;
  return settings[provider]?.showInPicker !== false;
}

/** User-added custom model slugs for a provider. */
export function customModelsFor(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): string[] {
  return settings[provider]?.customModels ? [...settings[provider]!.customModels!] : [];
}

/** Persisted provider order, or empty when using default order. */
export function providerOrderFor(): ProviderKind[] {
  const order = readEnvelope().providerOrder;
  return order ? [...order] : [];
}

/** Configured background health-check interval in seconds (0 = disabled; default 300). */
export function healthCheckIntervalSecFor(): number {
  return readEnvelope().healthCheckIntervalSec ?? DEFAULT_HEALTH_CHECK_INTERVAL_SEC;
}

export function handoffTokenCapFor(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): number {
  const stored = settings[provider]?.handoffTokenCap;
  return stored !== undefined ? clampHandoffTokenCap(stored) : DEFAULT_HANDOFF_TOKEN_CAP;
}

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

export function resumeAtResetFor(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): boolean {
  return settings[provider]?.resumeAtReset !== false;
}

export function snoozeWhenLimitedFor(
  provider: ProviderKind,
  settings: ProviderSettingsMap = readProviderSettings(),
): boolean {
  return settings[provider]?.snoozeWhenLimited === true;
}

export function assertProviderEnabled(
  settings: ProviderSettingsMap,
  provider: ProviderKind,
): void {
  if (!isProviderEnabled(provider, settings)) {
    throw new Error(`Provider "${provider}" is disabled in app settings.`);
  }
}

export function importLegacyRendererSettings(
  legacy: LegacyRendererProviderSettings,
): ProviderSettingsSnapshot {
  const envelope = readEnvelope();
  if (envelope.legacyRendererImported) return snapshotOf(envelope);

  const wire = LegacyRendererSettingsWire.safeParse(legacy);
  const next: ProviderSettingsMap = { ...envelope.settings };
  for (const provider of KNOWN_PROVIDERS) {
    const enabled = wire.data?.enabled?.[provider] ?? undefined;
    const hiddenModels = cleanStringList(wire.data?.hiddenModels?.[provider]);

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

export function resetProviderSettingsForTests(): void {
  cachedPath = null;
  cache = null;
  listeners.clear();
}
