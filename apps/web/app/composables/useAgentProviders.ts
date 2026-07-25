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
    provider: "codex",
    label: "Codex",
    available: true,
    authStatus: "authenticated",
    readiness: "ready",
    version: "0.48.0",
    authLabel: "ChatGPT Sign-In",
  },
];

// Real ids + display names + reasoning efforts, captured live from
// `codex app-server`'s `model/list` — no baked effort suffix, so browser dev
// exercises the same real-per-model ladder buildModelCatalog() builds.
const MOCK_MODELS: Record<ProviderKind, ModelDescriptor[]> = {
  codex: [
    {
      id: "gpt-5.6-terra",
      label: "GPT-5.6-Terra",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
      serviceTiers: [{ id: "fast", label: "Fast", description: "Lower latency, same model" }],
    },
    {
      id: "gpt-5.6-luna",
      label: "GPT-5.6-Luna",
      reasoningEfforts: ["low", "medium", "high", "xhigh", "max", "ultra"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.5",
      label: "GPT-5.5",
      reasoningEfforts: ["low", "medium", "high"],
      defaultReasoningEffort: "medium",
    },
    {
      id: "gpt-5.4-mini",
      label: "GPT-5.4-Mini",
      reasoningEfforts: ["minimal", "low", "medium"],
      defaultReasoningEffort: "low",
    },
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

  /** Models a provider offers (its own `list models` surface). The label is
   *  whatever the CLI's own response called it (Codex's `model/list` returns a
   *  real `displayName` per model) — kone shows that verbatim rather than
   *  re-guessing a name from the id. Cached at module scope after the first
   *  fetch (bypass with `force`). */
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
    // Only cache a real list — an empty result means the CLI errored or wasn't
    // reachable, and we want the next call to retry rather than serve the miss.
    if (raw.length) modelCache.value = { ...modelCache.value, [provider]: raw };
    return raw;
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
