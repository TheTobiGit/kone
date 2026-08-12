import { readonly, ref } from "vue";
import type { ProfileStats } from "~/types/desktop";

// Reads the lifetime, fully-local usage stats for the profile board off the
// main-process ConversationStore (via the history bridge). Everything is
// aggregated in SQL over every project's threads — no cloud, no telemetry
// service. In `nuxt dev` (no bridge) there's nothing to read, so `stats` stays
// null and the board renders its empty state; this is a real read, not a mock.

export function useProfileStats() {
  const stats = ref<ProfileStats | null>(null);
  const loading = ref(false);
  const loaded = ref(false);

  async function load(): Promise<void> {
    const api = import.meta.client ? window.koneDesktop?.agent?.history : undefined;
    if (!api?.profileStats) {
      loaded.value = true;
      return;
    }
    loading.value = true;
    try {
      stats.value = await api.profileStats();
    } catch (err) {
      console.error("[useProfileStats] load failed:", err);
    } finally {
      loading.value = false;
      loaded.value = true;
    }
  }

  return {
    stats: readonly(stats),
    loading: readonly(loading),
    loaded: readonly(loaded),
    load,
    refresh: load,
  };
}
