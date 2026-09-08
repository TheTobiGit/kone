import { onBeforeUnmount, ref, toValue, watch, type MaybeRefOrGetter } from "vue";
import type { GitProjectFile } from "~/types/desktop";

const SEARCH_DEBOUNCE_MS = 90;

/** Search the current project for files used by the composer @ picker. */
export function useProjectFiles(
  projectPath: MaybeRefOrGetter<string>,
  query: MaybeRefOrGetter<string>,
  enabled: MaybeRefOrGetter<boolean> = true,
) {
  const entries = ref<GitProjectFile[]>([]);
  const pending = ref(false);
  const error = ref<string | null>(null);
  let requestId = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  watch(
    [() => toValue(projectPath), () => toValue(query), () => toValue(enabled)],
    ([nextPath, nextQuery, nextEnabled]) => {
      if (timer) clearTimeout(timer);
      const id = ++requestId;
      // Some surfaces have no project on disk to search — the global assistant
      // names projects instead of files — so there is nothing to query.
      if (!nextEnabled) {
        entries.value = [];
        pending.value = false;
        error.value = null;
        return;
      }
      pending.value = true;
      error.value = null;
      timer = setTimeout(async () => {
        try {
          const result = await useGit().files(nextPath, nextQuery);
          if (id !== requestId) return;
          entries.value = result;
        } catch {
          if (id !== requestId) return;
          entries.value = [];
          error.value = "Unable to search project files.";
        } finally {
          if (id === requestId) pending.value = false;
        }
      }, SEARCH_DEBOUNCE_MS);
    },
    { immediate: true },
  );
  onBeforeUnmount(() => {
    if (timer) clearTimeout(timer);
    requestId += 1;
  });

  return { entries, pending, error };
}
