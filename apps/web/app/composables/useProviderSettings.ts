import { computed, ref } from "vue";
import { useStorage } from "@vueuse/core";
import type { ProviderKind, ProviderSettingsMap } from "~/types/desktop";

// The user's per-provider install settings — the settings-surface companion to
// useAgentProviders (which only *detects* installed CLIs). Two axes:
//
//  • binaryPath — where a provider's CLI actually lives. This has to reach the
//    Electron main process (the adapters spawn the binary), so it's persisted
//    through the desktop bridge (koneDesktop.agent.get/setSettings). In `nuxt
//    dev` there's no bridge, so it falls back to localStorage purely so the
//    Providers pane stays demoable in the browser.
//
//  • enabled — whether a provider shows up in the model-picker rail at all. This
//    is a pure renderer-side view filter (no bridge needed), so it lives in
//    localStorage the same way useStripPrefs' motion knobs do, shared at module
//    scope so flipping it in the drawer updates the rail live.
//
// Module-scope state so every surface (the drawer, ProjectView's rail) reads one
// reactive source and a change in one is seen everywhere without a reload.

const KNOWN_PROVIDERS: ProviderKind[] = ["codex", "claudeAgent", "opencode"];

// Where the dev (no-bridge) fallback stashes binary paths, mirroring the shape
// the desktop store persists. Kept separate from `enabled` so the two axes never
// step on each other.
const DEV_BINARY_KEY = "kone.providers.binaryPaths";

// binaryPath per provider. Authoritative source is the desktop store; this is
// the renderer's warm mirror of it (populated by load()).
const binaryPaths = ref<Partial<Record<ProviderKind, string>>>({});
let loaded = false;

// Which providers are allowed in the picker rail. Absent = enabled (opt-out), so
// a fresh install shows every detected provider. Synced across windows.
const enabledMap = useStorage<Partial<Record<ProviderKind, boolean>>>(
  "kone.providers.enabled",
  {},
  undefined,
  { listenToStorageChanges: true },
);

function bridge() {
  return import.meta.client ? window.koneDesktop?.agent : undefined;
}

function readDevBinaryPaths(): Partial<Record<ProviderKind, string>> {
  if (!import.meta.client) return {};
  try {
    const raw = localStorage.getItem(DEV_BINARY_KEY);
    return raw ? (JSON.parse(raw) as Partial<Record<ProviderKind, string>>) : {};
  } catch {
    return {};
  }
}

function writeDevBinaryPaths(map: Partial<Record<ProviderKind, string>>): void {
  if (!import.meta.client) return;
  try {
    localStorage.setItem(DEV_BINARY_KEY, JSON.stringify(map));
  } catch {
    // best-effort; a full/blocked localStorage never breaks the pane.
  }
}

/** Flatten the desktop store's `{ provider: { binaryPath } }` map into the flat
 *  provider→path shape the pane binds to. */
function fromSettingsMap(map: ProviderSettingsMap): Partial<Record<ProviderKind, string>> {
  const out: Partial<Record<ProviderKind, string>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const path = map[provider]?.binaryPath?.trim();
    if (path) out[provider] = path;
  }
  return out;
}

export function useProviderSettings() {
  /** Load persisted binary paths once. Reads the desktop store when present,
   *  else the dev localStorage fallback. Idempotent. */
  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    const api = bridge();
    if (api?.getSettings) {
      try {
        binaryPaths.value = fromSettingsMap(await api.getSettings());
      } catch {
        binaryPaths.value = {};
      }
    } else {
      binaryPaths.value = readDevBinaryPaths();
    }
    loaded = true;
  }

  /** The configured binary path for a provider, or "" when it runs on default. */
  function binaryPath(provider: ProviderKind): string {
    return binaryPaths.value[provider] ?? "";
  }

  /** Persist a provider's binary path. An empty/blank value clears the override
   *  (the adapter falls back to its default). Writes through to the desktop
   *  store (which re-points the live adapter) or the dev fallback. */
  async function setBinaryPath(provider: ProviderKind, path: string): Promise<void> {
    const trimmed = path.trim();
    const next = { ...binaryPaths.value };
    if (trimmed) next[provider] = trimmed;
    else delete next[provider];
    binaryPaths.value = next;

    const api = bridge();
    if (api?.setSettings) {
      try {
        binaryPaths.value = fromSettingsMap(
          await api.setSettings(provider, { binaryPath: trimmed || undefined }),
        );
      } catch {
        // Keep the optimistic in-memory value; the pane still reflects the edit.
      }
    } else {
      writeDevBinaryPaths(next);
    }
  }

  /** Whether a provider may appear in the picker rail (default: yes). */
  function isEnabled(provider: ProviderKind): boolean {
    return enabledMap.value[provider] !== false;
  }

  function setEnabled(provider: ProviderKind, on: boolean): void {
    enabledMap.value = { ...enabledMap.value, [provider]: on };
  }

  /** Predicate for filtering a list of provider-tagged rows by the enabled map,
   *  handed to ProjectView so the rail and boot pick share one rule. */
  const enabledPredicate = computed(
    () => (provider: ProviderKind) => enabledMap.value[provider] !== false,
  );

  return {
    binaryPaths,
    enabledMap,
    load,
    binaryPath,
    setBinaryPath,
    isEnabled,
    setEnabled,
    enabledPredicate,
  };
}
