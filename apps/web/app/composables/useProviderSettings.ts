import { computed, ref } from "vue";
import { useStorage } from "@vueuse/core";
import { desktopBridge } from "~/utils/desktopBridge";
import type {
  KoneAgentApi,
  LegacyRendererProviderSettings,
  ProviderConfig,
  ProviderKind,
  ProviderSettingsMap,
  ProviderSettingsSnapshot,
} from "~/types/desktop";

// The user's per-provider install settings — the settings-surface companion to
// useAgentProviders (which only *detects* installed CLIs). The desktop store owns
// them now (binary path, enabled, hidden model families); this module is the
// renderer's mirror of it. load() pulls a revisioned snapshot and
// onSettingsChanged pushes every later write, so two windows and the picker rail
// never disagree. Setters update the mirror optimistically and write through the
// same bridge; the push that follows is authoritative.
//
// A plain browser has nowhere to persist: the mirror is the session's store
// (everything enabled, nothing hidden) and the dev stand-in answers reads
// without one. Module scope so the drawer, the rail and the picker read one
// reactive source.

const KNOWN_PROVIDERS: ProviderKind[] = ["codex", "claudeAgent", "cursor", "opencode", "droid", "antigravity", "cline"];

// Where `enabled` and the hidden model families used to live in the renderer.
// They're read once when main reports an un-imported store, then removed; the
// file is the only store after that.
const LEGACY_ENABLED_KEY = "kone.providers.enabled";
const LEGACY_HIDDEN_KEY = "kone.models.hidden";

/** The slice of the preload this module writes through. All optional so a
 *  preload that predates the snapshot calls still typechecks (and loses no more
 *  than its live updates). */
type SettingsBridge = Partial<
  Pick<
    KoneAgentApi,
    | "getSettings"
    | "setSettings"
    | "patchSettings"
    | "getSettingsSnapshot"
    | "importLegacySettings"
    | "onSettingsChanged"
  >
>;

// The desktop store's settings, mirrored. Authoritative copy lives in main; this
// ref is replaced wholesale by each applied snapshot.
const settings = ref<ProviderSettingsMap>({});
// The revision of the snapshot in `settings`; -1 means nothing applied yet.
const revision = ref(-1);
// One subscription per session, however many surfaces call load().
let stopListening: (() => void) | null = null;
let loaded = false;

/** binaryPath per provider, flattened for the pane. */
const binaryPaths = computed<Partial<Record<ProviderKind, string>>>(() => {
  const out: Partial<Record<ProviderKind, string>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const path = settings.value[provider]?.binaryPath?.trim();
    if (path) out[provider] = path;
  }
  return out;
});

/** Which providers are allowed in the picker rail. Absent = enabled (opt-out),
 *  so a fresh install shows every detected provider. */
const enabledMap = computed<Partial<Record<ProviderKind, boolean>>>(() => {
  const out: Partial<Record<ProviderKind, boolean>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const enabled = settings.value[provider]?.enabled;
    if (enabled !== undefined) out[provider] = enabled !== false;
  }
  return out;
});

/** Which model *families* are hidden from the picker, keyed by provider. Like
 *  enabledMap this is opt-out: a family absent from its provider's list is
 *  shown, and an empty list is the same as no list. */
const hiddenModels = computed<Partial<Record<ProviderKind, string[]>>>(() => {
  const out: Partial<Record<ProviderKind, string[]>> = {};
  for (const provider of KNOWN_PROVIDERS) {
    const hidden = settings.value[provider]?.hiddenModels;
    if (hidden?.length) out[provider] = [...hidden];
  }
  return out;
});

// Whether the providers pane may look up newer CLI versions when it opens. On by
// default, but genuinely optional: it's a network call about software the user
// might have pinned deliberately, and kone shouldn't reach out to registries
// behind the back of someone who'd rather it didn't. The only setting still kept
// in the renderer.
const updateChecks = useStorage<boolean>("kone.providers.updateChecks", true, undefined, {
  listenToStorageChanges: true,
});

function bridge(): SettingsBridge | undefined {
  // Existence probe, not a narrowing one: the preload only exists in the desktop
  // renderer, and bun tests stand one in on globalThis.window. The dev stand-in
  // answers a plain browser, so `nuxt dev` runs the same snapshot path.
  const preload = typeof window !== "undefined" ? window.koneDesktop?.agent : undefined;
  return preload ?? desktopBridge()?.agent;
}

/** Apply a snapshot from main, newest wins. A push can overtake the reply to a
 *  read, so anything at or below the revision already applied is stale — unless
 *  the caller re-read main after a failed write, where the file legitimately
 *  never moved. */
function apply(snapshot: ProviderSettingsSnapshot, force = false): void {
  if (!force && snapshot.revision <= revision.value) return;
  settings.value = snapshot.settings;
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
    // The keys held plain maps when anything wrote them; anything else (an
    // array, a bare value) is absent rather than something to import.
    if (parsed === null || !(parsed instanceof Object) || Array.isArray(parsed)) return undefined;
    return parsed;
  } catch {
    // Unparseable, or a blocked store: treat it as nothing to import.
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
    // The import ran (or another window already ran it); the keys are inert.
    localStorage.removeItem(LEGACY_ENABLED_KEY);
    localStorage.removeItem(LEGACY_HIDDEN_KEY);
  } catch {
    // Blocked store: the keys can't be read by anything either.
  }
}

export function useProviderSettings() {
  /** Mirror main's settings once, then keep them live. Idempotent; a failed
   *  read keeps whatever this window already shows. */
  async function load(force = false): Promise<void> {
    if (loaded && !force) return;
    const api = bridge();
    // A read or import that didn't land leaves this load unsettled, so the
    // next load() tries again; nothing retries on its own.
    let settled = true;
    if (api?.getSettingsSnapshot) {
      listen(api);
      try {
        const snapshot = await api.getSettingsSnapshot();
        if (snapshot.legacyImportPending && api.importLegacySettings) {
          // Show main's store until the import is saved, so the pane never
          // shows choices the file doesn't have.
          apply(snapshot);
          try {
            const imported = await api.importLegacySettings(readLegacySettings());
            apply(imported);
            if (imported.legacyImportPending) settled = false;
            else dropLegacySettings();
          } catch {
            // Not saved: the keys are still the only copy of those choices.
            settled = false;
          }
        } else {
          apply(snapshot);
          // Pending with no importer means a build that can still needs the
          // keys; once imported, leftovers are stale copies of the store.
          if (!snapshot.legacyImportPending) dropLegacySettings();
        }
      } catch {
        // Keep the current mirror; the next push or load() settles it.
        settled = false;
      }
    } else if (api?.getSettings) {
      // Preload without the snapshot calls: no revision, no pushes.
      try {
        settings.value = await api.getSettings();
      } catch {
        // Keep the current mirror; the next load() tries again.
        settled = false;
      }
    }
    loaded = settled;
  }

  /** The configured binary path for a provider, or "" when it runs on default. */
  function binaryPath(provider: ProviderKind): string {
    return binaryPaths.value[provider] ?? "";
  }

  /** Persist one provider's change: show it now, write through the bridge, and
   *  let the push that follows confirm it. Only the changed fields reach main,
   *  so a second window editing another field never gets undone. */
  async function write(provider: ProviderKind, patch: ProviderConfig): Promise<void> {
    const next = { ...settings.value[provider], ...patch };
    settings.value = { ...settings.value, [provider]: next };

    const api = bridge();
    if (api?.patchSettings) {
      try {
        apply(await api.patchSettings(provider, patch));
      } catch {
        // Nothing was saved, so the revision didn't move either: force the read
        // back past the guard to take the optimism off the pane.
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
    // A preload from before patchSettings: the whole entry is all it can take.
    try {
      const written = await api.setSettings(provider, next);
      // Without the push, the reply to the write is the only authoritative copy.
      if (!api.getSettingsSnapshot) settings.value = written;
    } catch {
      // Keep the optimistic value; the pane still reflects the edit.
    }
  }

  /** Persist a provider's binary path. An empty/blank value clears the override
   *  (the adapter falls back to its default). */
  async function setBinaryPath(provider: ProviderKind, path: string): Promise<void> {
    await write(provider, { binaryPath: path.trim() || undefined });
  }

  /** Whether a provider may appear in the picker rail (default: yes). */
  function isEnabled(provider: ProviderKind): boolean {
    return enabledMap.value[provider] !== false;
  }

  async function setEnabled(provider: ProviderKind, on: boolean): Promise<void> {
    await write(provider, { enabled: on });
  }

  /** Predicate for filtering a list of provider-tagged rows by the enabled map,
   *  handed to ProjectView so the rail and boot pick share one rule. */
  const enabledPredicate = computed(
    () => (provider: ProviderKind) => enabledMap.value[provider] !== false,
  );

  /** Whether a model family may appear in the picker (default: yes). Keyed by
   *  the family core (ModelOption.key), which is what both the pane's toggle and
   *  the picker's catalog group by. */
  function isModelHidden(provider: ProviderKind, key: string): boolean {
    return hiddenModels.value[provider]?.includes(key) ?? false;
  }

  /** Hiding a family writes through the bridge; the mirror updates first so the
   *  toggle reacts on the same frame. */
  function setModelHidden(provider: ProviderKind, key: string, hidden: boolean): void {
    const current = hiddenModels.value[provider] ?? [];
    const next = hidden
      ? current.includes(key)
        ? current
        : [...current, key]
      : current.filter((k) => k !== key);
    void write(provider, { hiddenModels: next });
  }

  /** How many of a provider's families the user has hidden — for the pane's
   *  count line. Counts only keys still present in the live catalog it's given,
   *  so a model that's since disappeared doesn't inflate the tally. */
  function hiddenModelCount(provider: ProviderKind, liveKeys: string[]): number {
    const hidden = hiddenModels.value[provider];
    if (!hidden?.length) return 0;
    const live = new Set(liveKeys);
    return hidden.filter((k) => live.has(k)).length;
  }

  /** Predicate ProjectView filters its picker catalog through, so the pane's
   *  toggles and the picker share one rule (mirrors enabledPredicate). */
  const modelVisiblePredicate = computed(
    () => (provider: ProviderKind, key: string) =>
      !(hiddenModels.value[provider]?.includes(key) ?? false),
  );

  return {
    binaryPaths,
    enabledMap,
    hiddenModels,
    updateChecks,
    load,
    binaryPath,
    setBinaryPath,
    isEnabled,
    setEnabled,
    enabledPredicate,
    isModelHidden,
    setModelHidden,
    hiddenModelCount,
    modelVisiblePredicate,
  };
}

/** Test hook: the mirror and its subscription outlive a single test case. */
export function resetProviderSettingsForTests(): void {
  stopListening?.();
  stopListening = null;
  settings.value = {};
  revision.value = -1;
  loaded = false;
}
