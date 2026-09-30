import { ref, watch, type Ref } from "vue";
import type { ContractTerms } from "~/types/desktop";
import { desktopBridge } from "~/utils/desktopBridge";

/**
 * A contractor's terms and project, read off its stored thread — what the
 * origin mark needs to say what it was contracted for and to offer hiring it.
 *
 * Read lazily and once per thread: the terms never change after the contract
 * is made, and only a contractor's thread ever asks.
 */
export function useThreadContract(threadId: Ref<string | null | undefined>, wanted: Ref<boolean>) {
  const contract = ref<ContractTerms | null>(null);
  const projectPath = ref<string | null>(null);

  watch(
    [threadId, wanted],
    async ([id, want]) => {
      contract.value = null;
      projectPath.value = null;
      if (!id || !want) return;
      const history = desktopBridge()?.agent?.history;
      if (!history) return;
      try {
        const page = await history.threadPage(id, { limit: 1 });
        if (threadId.value !== id) return;
        contract.value = page?.meta.contract ?? null;
        projectPath.value = page?.meta.projectPath ?? null;
      } catch {
        // The mark still says who handed the work over; it just offers no hire.
      }
    },
    { immediate: true },
  );

  return { contract, projectPath };
}
