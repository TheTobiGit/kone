import { onMounted, ref, watch } from "vue";
import type { TurnTraceRecord } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";

/** One turn's trace row, read once when a trace card opens, and again when the
 *  turn it opened on settles, so the card fills in rather than holding the
 *  partial numbers it opened with. */
export function useTurnTrace(source: () => { threadId: string | null; turnId: string | undefined; state: string | undefined }) {
  const trace = ref<TurnTraceRecord | null>(null);
  const loading = ref(true);

  async function load(): Promise<void> {
    const { threadId, turnId } = source();
    const read = desktopBridge()?.agent.history?.turnTraces;
    if (!turnId || !threadId || !read) {
      loading.value = false;
      return;
    }
    try {
      const rows = await read(threadId);
      trace.value = rows.find((r) => r.turnId === turnId) ?? null;
    } catch {
      // An unread trace says so on the card; the facts that don't need it still show.
    }
    loading.value = false;
  }

  onMounted(load);
  watch(
    () => source().state,
    (now, was) => {
      if (was === "running" && now !== "running") void load();
    },
  );

  return { trace, loading };
}
