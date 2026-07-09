import { useLocalStorage } from "@vueuse/core";
import type { ProviderId } from "~/lib/model-catalog";
import { getModelLabel, getModelOption } from "~/lib/model-catalog";
import { getDroidModel, useDroidModelStore } from "~/lib/droid-model-store";

export interface RecentModelSelection {
  provider: ProviderId;
  model: string;
  fastMode: boolean;
}

const STORAGE_KEY = "kone:recent-models";
const MAX_RECENT = 4;

function selectionKey(entry: RecentModelSelection) {
  return `${entry.provider}:${entry.model}:${entry.fastMode}`;
}

export function useRecentModels() {
  const stored = useLocalStorage<RecentModelSelection[]>(STORAGE_KEY, []);
  const { droidModelsLoaded } = useDroidModelStore();

  function isValidRecent(entry: RecentModelSelection) {
    if (entry.provider === "droid") {
      if (getDroidModel(entry.model)) return true;
      return !droidModelsLoaded.value && Boolean(entry.model);
    }

    return Boolean(getModelOption(entry.provider, entry.model));
  }

  const recents = computed(() =>
    stored.value
      .filter(isValidRecent)
      .map((entry) => ({ ...entry, fastMode: false }))
      .slice(0, MAX_RECENT),
  );

  function recordSelection(entry: RecentModelSelection) {
    if (entry.provider !== "droid" && !isValidRecent(entry)) return;
    const normalizedEntry = { ...entry, fastMode: false };

    const next = [
      normalizedEntry,
      ...stored.value.filter(
        (item) => selectionKey(item) !== selectionKey(normalizedEntry),
      ),
    ].slice(0, MAX_RECENT);

    stored.value = next;
  }

  function getRecentLabel(entry: RecentModelSelection) {
    return getModelLabel(entry.provider, entry.model);
  }

  return {
    recents,
    recordSelection,
    getRecentLabel,
  };
}
