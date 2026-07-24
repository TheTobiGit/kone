import { computed, ref } from "vue";
import type { ModelDescriptor, ProviderKind, ProviderStatus } from "~/types/desktop";
import { peelIpcError } from "~/utils/ipcError";

// Which agent CLIs the user has installed + logged into on this machine. This is
// the "bring your own subscription" surface: kone only *detects* a ready CLI, it
// never holds provider credentials. In `nuxt dev` (no bridge) it falls back to a
// mock so the provider picker stays demoable in the browser.
//
// Module-scope state so every surface that asks about providers shares one probe
// result — discovery shells out to real CLIs, so we don't want it running once
// per component.

const statuses = ref<ProviderStatus[]>([]);
const loading = ref(false);
const loadError = ref<string | null>(null);
let probed = false;

// Prettified model lists, cached per provider at module scope. Populated on the
// first `models()` call (or eagerly by `prepare()` at app open) so entering a
// project reads a warm list instead of re-shelling out to the CLI.
const modelCache = ref<Partial<Record<ProviderKind, ModelDescriptor[]>>>({});
let preparing: Promise<void> | null = null;

const MOCK_STATUSES: ProviderStatus[] = [
  {
    provider: "antigravity",
    label: "Antigravity",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "1.1.4",
    authLabel: "Google Sign-In",
  },
];

// The real `agy models` set (v1.1.5). Kept verbatim so browser dev shows the
// exact same model list the desktop bridge returns — labels are prettified in
// one place (below) via modelLabel.
const MOCK_MODELS: Record<ProviderKind, ModelDescriptor[]> = {
  antigravity: [
    { id: "gemini-3.6-flash-high", label: "gemini-3.6-flash-high" },
    { id: "gemini-3.6-flash-medium", label: "gemini-3.6-flash-medium" },
    { id: "gemini-3.6-flash-low", label: "gemini-3.6-flash-low" },
    { id: "gemini-3.5-flash-high", label: "gemini-3.5-flash-high" },
    { id: "gemini-3.5-flash-medium", label: "gemini-3.5-flash-medium" },
    { id: "gemini-3.5-flash-low", label: "gemini-3.5-flash-low" },
    { id: "gemini-3.1-pro-high", label: "gemini-3.1-pro-high" },
    { id: "gemini-3.1-pro-low", label: "gemini-3.1-pro-low" },
    { id: "claude-sonnet-4-6", label: "claude-sonnet-4-6" },
    { id: "claude-opus-4-6-thinking", label: "claude-opus-4-6-thinking" },
    { id: "gpt-oss-120b-medium", label: "gpt-oss-120b-medium" },
  ],
};

export function useAgentProviders() {
  const ready = computed(() => statuses.value.filter((s) => s.readiness === "ready"));
  const byProvider = (provider: ProviderKind) =>
    computed(() => statuses.value.find((s) => s.provider === provider) ?? null);

  const bridge = () => (import.meta.client ? window.koneDesktop?.agent : undefined);

  /** Probe the machine. Cached after the first successful run unless `force`. */
  async function discover(force = false): Promise<ProviderStatus[]> {
    if (probed && !force) return statuses.value;
    loading.value = true;
    loadError.value = null;
    try {
      const api = bridge();
      statuses.value = api ? await api.discover() : MOCK_STATUSES;
      probed = true;
      return statuses.value;
    } catch (error) {
      loadError.value = peelIpcError(error, "Could not check your agent tools");
      return statuses.value;
    } finally {
      loading.value = false;
    }
  }

  /** Models a provider offers (its own `list models` surface). Labels are
   *  prettified from the raw CLI ids here so the picker reads cleanly while the
   *  id we send back as `--model` stays exactly what the CLI emitted. Cached at
   *  module scope after the first fetch (bypass with `force`). */
  async function models(provider: ProviderKind, force = false): Promise<ModelDescriptor[]> {
    const cached = modelCache.value[provider];
    if (cached && !force) return cached;
    const api = bridge();
    let raw: ModelDescriptor[];
    if (!api) raw = MOCK_MODELS[provider] ?? [];
    else {
      try {
        raw = await api.models(provider);
      } catch {
        raw = [];
      }
    }
    const list = raw.map((m) => ({ ...m, label: modelLabel(m.id) }));
    // Only cache a real list — an empty result means the CLI errored or wasn't
    // reachable, and we want the next call to retry rather than serve the miss.
    if (list.length) modelCache.value = { ...modelCache.value, [provider]: list };
    return list;
  }

  /** Warm the whole provider surface at app open: probe the machine once, then
   *  prefetch models for every installed provider so opening a project is
   *  instant. Deduped — concurrent callers await the same run. */
  async function prepare(): Promise<void> {
    if (preparing) return preparing;
    preparing = (async () => {
      const found = await discover();
      await Promise.all(
        found
          .filter((s) => s.available && !modelCache.value[s.provider])
          .map((s) => models(s.provider)),
      );
    })();
    try {
      await preparing;
    } finally {
      preparing = null;
    }
  }

  return {
    statuses,
    ready,
    loading,
    loadError,
    byProvider,
    discover,
    models,
    prepare,
  };
}
