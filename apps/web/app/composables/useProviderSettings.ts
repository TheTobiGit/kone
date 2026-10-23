import { computed, ref } from "vue";
import { useStorage } from "@vueuse/core";
import { desktopBridge } from "~/utils/desktopBridge";
import type {
  GlobalProviderSettingsPatch,
  KoneAgentApi,
  LegacyRendererProviderSettings,
  ProviderBinaryCheckResult,
  ProviderConfig,
  ProviderEnvVar,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "~/types/desktop";

const KNOWN_PROVIDERS: ProviderKind[] = [
  "codex",
  "claudeAgent",
  "cursor",
  "opencode",
  "droid",
  "antigravity",
  "cline",
];

const DEFAULT_HANDOFF_CAP = 16_000;
const MIN_HANDOFF_CAP = 1_024;
const MAX_HANDOFF_CAP = 64_000;
const DEFAULT_HEALTH_INTERVAL_SEC = 300;

const LEGACY_ENABLED_KEY = "kone.providers.enabled";
const LEGACY_HIDDEN_KEY = "kone.models.hidden";

type SettingsBridge = Partial<
  Pick<
    KoneAgentApi,
    | "getSettings"
    | "setSettings"
    | "patchSettings"
    | "patchGlobalSettings"
    | "checkProviderBinary"
    | "getSettingsSnapshot"
    | "importLegacySettings"
    | "onSettingsChanged"
  >
>;

const settings = ref<ProviderSettingsMap>({});
const providerOrder = ref<ProviderKind[]>([]);
const healthCheckIntervalSec = ref<number>(DEFAULT_HEALTH_INTERVAL_SEC);
const revision = ref(-1);
let stopListening: (() => void) | null = null;
let loaded = false;

const binaryPaths = computed<Partial<Record<ProviderKind, string>>>(() => {
  const out: Partial<Record<ProviderKind, string>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const path = settings.value[provider]?.binaryPath?.trim();
    if (path) out[provider] = path;
  }
  return out;
});

const enabledMap = computed<Partial<Record<ProviderKind, boolean>>>(() => {
  const out: Partial<Record<ProviderKind, boolean>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const enabled = settings.value[provider]?.enabled;
    if (enabled !== undefined) out[provider] = enabled !== false;
  }
  return out;
});

const hiddenModels = computed<Partial<Record<ProviderKind, string[]>>>(() => {
  const out: Partial<Record<ProviderKind, string[]>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const hidden = settings.value[provider]?.hiddenModels;
    if (hidden?.length) out[provider] = [...hidden];
  }
  return out;
});

const updateChecks = useStorage<boolean>("kone.providers.updateChecks", true, undefined, {
  listenToStorageChanges: true,
});

function bridge(): SettingsBridge | undefined {
  const preload = typeof window !== "undefined" ? window.koneDesktop?.agent : undefined;
  return preload ?? desktopBridge()?.agent;
}

function apply(snapshot: ProviderSettingsSnapshot, force = false): void {
  if (!force && snapshot.revision <= revision.value) return;
  settings.value = snapshot.settings;
  providerOrder.value = snapshot.providerOrder ? [...snapshot.providerOrder] : [];
  healthCheckIntervalSec.value =
    snapshot.healthCheckIntervalSec ?? DEFAULT_HEALTH_INTERVAL_SEC;
  revision.value = snapshot.revision;
}

function listen(api: SettingsBridge): void {
  if (stopListening || !api.onSettingsChanged) return;
  stopListening = api.onSettingsChanged(apply);
}

function readLegacy<T>(key: string): T | undefined {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return undefined;
    const parsed: T | null = JSON.parse(raw);
    if (parsed === null || !(parsed instanceof Object) || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    return undefined;
  }
}

function readLegacySettings(): LegacyRendererProviderSettings {
  return {
    enabled: readLegacy<Partial<Record<ProviderKind, boolean>>>(LEGACY_ENABLED_KEY),
    hiddenModels: readLegacy<Partial<Record<ProviderKind, string[]>>>(LEGACY_HIDDEN_KEY),
  };
}

function dropLegacySettings(): void {
  try {
    localStorage.removeItem(LEGACY_ENABLED_KEY);
    localStorage.removeItem(LEGACY_HIDDEN_KEY);
  } catch {
    // Blocked store: the keys can't be read by anything either.
  }
}

function clampCap(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_HANDOFF_CAP;
  return Math.min(MAX_HANDOFF_CAP, Math.max(MIN_HANDOFF_CAP, Math.round(raw)));
}

export function useProviderSettings() {
  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    const api = bridge();
    let settled = true;
    if (api?.getSettingsSnapshot) {
      listen(api);
      try {
        const snapshot = await api.getSettingsSnapshot();
        if (snapshot.legacyImportPending && api.importLegacySettings) {
          apply(snapshot);
          try {
            const imported = await api.importLegacySettings(readLegacySettings());
            apply(imported);
            if (imported.legacyImportPending) settled = false;
            else dropLegacySettings();
          } catch {
            settled = false;
          }
        } else {
          apply(snapshot);
          if (!snapshot.legacyImportPending) dropLegacySettings();
        }
      } catch {
        settled = false;
      }
    } else if (api?.getSettings) {
      try {
        settings.value = await api.getSettings();
      } catch {
        settled = false;
      }
    }
    loaded = settled;
  }

  function binaryPath(provider: ProviderKind): string {
    return binaryPaths.value[provider] ?? "";
  }

  async function write(provider: ProviderKind, patch: ProviderConfig): Promise<void> {
    const next: ProviderConfig = { ...settings.value[provider], ...patch };
    settings.value = { ...settings.value, [provider]: next };

    const api = bridge();
    if (api?.patchSettings) {
      try {
        apply(await api.patchSettings(provider, patch));
      } catch {
        if (api.getSettingsSnapshot) {
          try {
            apply(await api.getSettingsSnapshot(), true);
          } catch {
            // Unreadable too; the next push or reload settles it.
          }
        }
      }
      return;
    }
    if (!api?.setSettings) return;
    try {
      const written = await api.setSettings(provider, next);
      if (!api.getSettingsSnapshot) settings.value = written;
    } catch {
      // Keep the optimistic value; the pane still reflects the edit.
    }
  }

  async function writeGlobal(patch: GlobalProviderSettingsPatch): Promise<void> {
    if (patch.providerOrder !== undefined) {
      providerOrder.value = [...patch.providerOrder];
    }
    if (patch.healthCheckIntervalSec !== undefined) {
      healthCheckIntervalSec.value = patch.healthCheckIntervalSec;
    }
    const api = bridge();
    if (api?.patchGlobalSettings) {
      try {
        apply(await api.patchGlobalSettings(patch));
      } catch {
        if (api.getSettingsSnapshot) {
          try {
            apply(await api.getSettingsSnapshot(), true);
          } catch {
            // Unreadable too.
          }
        }
      }
    }
  }

  async function setBinaryPath(provider: ProviderKind, path: string): Promise<void> {
    await write(provider, { binaryPath: path.trim() || undefined });
  }

  async function checkBinary(
    provider: ProviderKind,
    path?: string,
  ): Promise<ProviderBinaryCheckResult | null> {
    const api = bridge();
    if (!api?.checkProviderBinary) return null;
    try {
      return await api.checkProviderBinary(provider, path);
    } catch {
      return null;
    }
  }

  function isEnabled(provider: ProviderKind): boolean {
    return enabledMap.value[provider] !== false;
  }

  async function setEnabled(provider: ProviderKind, on: boolean): Promise<void> {
    await write(provider, { enabled: on });
  }

  /** Whether a provider is shown in the model picker when enabled (default: true). */
  function isShownInPicker(provider: ProviderKind): boolean {
    if (!isEnabled(provider)) return false;
    return settings.value[provider]?.showInPicker !== false;
  }

  async function setShownInPicker(provider: ProviderKind, on: boolean): Promise<void> {
    await write(provider, { showInPicker: on });
  }

  /** Order a list of provider ids according to the user's persisted `providerOrder`. */
  function orderProviders(base: readonly ProviderKind[]): ProviderKind[] {
    const stored = providerOrder.value;
    if (!stored.length) return [...base];
    const baseSet = new Set(base);
    const out: ProviderKind[] = [];
    for (const p of stored) {
      if (baseSet.has(p) && !out.includes(p)) out.push(p);
    }
    for (const p of base) {
      if (!out.includes(p)) out.push(p);
    }
    return out;
  }

  /** Move `provider` one step earlier (-1) or later (+1) in `baseOrder` and persist. */
  async function moveProvider(
    provider: ProviderKind,
    delta: -1 | 1,
    baseOrder: readonly ProviderKind[] = KNOWN_PROVIDERS,
  ): Promise<void> {
    const list = orderProviders(baseOrder);
    const idx = list.indexOf(provider);
    const target = idx + delta;
    if (idx < 0 || target < 0 || target >= list.length) return;
    const a = list[idx];
    const b = list[target];
    if (!a || !b) return;
    list[idx] = b;
    list[target] = a;
    await writeGlobal({ providerOrder: list });
  }

  async function setHealthCheckIntervalSec(seconds: number): Promise<void> {
    await writeGlobal({ healthCheckIntervalSec: Math.max(0, Math.round(seconds)) });
  }

  function handoffTokenCap(provider: ProviderKind): number {
    const raw = settings.value[provider]?.handoffTokenCap;
    return raw !== undefined ? clampCap(raw) : DEFAULT_HANDOFF_CAP;
  }

  async function setHandoffTokenCap(provider: ProviderKind, cap: number): Promise<void> {
    await write(provider, { handoffTokenCap: clampCap(cap) });
  }

  function customModels(provider: ProviderKind): string[] {
    const list = settings.value[provider]?.customModels;
    return list?.length ? [...list] : [];
  }

  async function addCustomModel(provider: ProviderKind, slug: string): Promise<void> {
    const trimmed = slug.trim();
    if (!trimmed) return;
    const current = customModels(provider);
    if (current.includes(trimmed)) return;
    await write(provider, { customModels: [...current, trimmed] });
  }

  async function removeCustomModel(provider: ProviderKind, slug: string): Promise<void> {
    const next = customModels(provider).filter((s) => s !== slug);
    await write(provider, { customModels: next.length ? next : undefined });
  }

  function homeDir(provider: ProviderKind): string {
    return settings.value[provider]?.homeDir?.trim() ?? "";
  }

  async function setHomeDir(provider: ProviderKind, path: string): Promise<void> {
    await write(provider, { homeDir: path.trim() || undefined });
  }

  function envVars(provider: ProviderKind): ProviderEnvVar[] {
    const list = settings.value[provider]?.env;
    return list?.length ? list.map((v) => ({ ...v })) : [];
  }

  async function setEnvVars(provider: ProviderKind, vars: ProviderEnvVar[]): Promise<void> {
    const clean: ProviderEnvVar[] = [];
    for (const v of vars) {
      const name = v.name.trim();
      if (!name) continue;
      const item: ProviderEnvVar = { name, value: v.value };
      if (v.secret) item.secret = true;
      clean.push(item);
    }
    await write(provider, { env: clean.length ? clean : undefined });
  }

  const enabledPredicate = computed(
    () => (provider: ProviderKind) => enabledMap.value[provider] !== false,
  );

  function isModelHidden(provider: ProviderKind, key: string): boolean {
    return hiddenModels.value[provider]?.includes(key) ?? false;
  }

  function setModelHidden(provider: ProviderKind, key: string, hidden: boolean): void {
    const current = hiddenModels.value[provider] ?? [];
    const next = hidden
      ? current.includes(key)
        ? current
        : [...current, key]
      : current.filter((k) => k !== key);
    void write(provider, { hiddenModels: next });
  }

  function hiddenModelCount(provider: ProviderKind, liveKeys: string[]): number {
    const hidden = hiddenModels.value[provider];
    if (!hidden?.length) return 0;
    const live = new Set(liveKeys);
    return hidden.filter((k) => live.has(k)).length;
  }

  const modelVisiblePredicate = computed(
    () => (provider: ProviderKind, key: string) =>
      !(hiddenModels.value[provider]?.includes(key) ?? false),
  );

  function resumeAtReset(provider: ProviderKind): boolean {
    return settings.value[provider]?.resumeAtReset !== false;
  }

  async function setResumeAtReset(provider: ProviderKind, on: boolean): Promise<void> {
    await write(provider, { resumeAtReset: on });
  }

  function snoozeWhenLimited(provider: ProviderKind): boolean {
    return settings.value[provider]?.snoozeWhenLimited === true;
  }

  async function setSnoozeWhenLimited(provider: ProviderKind, on: boolean): Promise<void> {
    await write(provider, { snoozeWhenLimited: on });
  }

  return {
    binaryPaths,
    enabledMap,
    hiddenModels,
    providerOrder,
    healthCheckIntervalSec,
    updateChecks,
    load,
    binaryPath,
    setBinaryPath,
    checkBinary,
    isEnabled,
    setEnabled,
    isShownInPicker,
    setShownInPicker,
    orderProviders,
    moveProvider,
    setHealthCheckIntervalSec,
    handoffTokenCap,
    setHandoffTokenCap,
    customModels,
    addCustomModel,
    removeCustomModel,
    homeDir,
    setHomeDir,
    envVars,
    setEnvVars,
    enabledPredicate,
    isModelHidden,
    setModelHidden,
    hiddenModelCount,
    modelVisiblePredicate,
    resumeAtReset,
    setResumeAtReset,
    snoozeWhenLimited,
    setSnoozeWhenLimited,
  };
}

export function resetProviderSettingsForTests(): void {
  stopListening?.();
  stopListening = null;
  settings.value = {};
  providerOrder.value = [];
  healthCheckIntervalSec.value = DEFAULT_HEALTH_INTERVAL_SEC;
  revision.value = -1;
  loaded = false;
}
