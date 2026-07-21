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

const MOCK_MODELS: Record<ProviderKind, ModelDescriptor[]> = {
  antigravity: [
    { id: "Gemini 3.5 Flash (Medium)", label: "Gemini 3.5 Flash (Medium)" },
    { id: "Gemini 3.1 Pro (High)", label: "Gemini 3.1 Pro (High)" },
    { id: "Claude Sonnet 4.6 (Thinking)", label: "Claude Sonnet 4.6 (Thinking)" },
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

  /** Models a provider offers (its own `list models` surface). */
  async function models(provider: ProviderKind): Promise<ModelDescriptor[]> {
    const api = bridge();
    if (!api) return MOCK_MODELS[provider] ?? [];
    try {
      return await api.models(provider);
    } catch {
      return [];
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
  };
}
