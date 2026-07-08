import { useLocalStorage } from "@vueuse/core";
import type { ProviderId } from "~/lib/model-catalog";
import { getModelLabel, getModelOption } from "~/lib/model-catalog";

export interface RecentModelSelection {
  provider: ProviderId;
  model: string;
  fastMode: boolean;
}

const STORAGE_KEY = "kone:recent-models";
const MAX_RECENT = 4;

const DEMO_RECENTS: RecentModelSelection[] = [
  { provider: "codex", model: "gpt-5.5", fastMode: false },
  { provider: "claudeAgent", model: "claude-sonnet-4-6", fastMode: false },
  { provider: "cursor", model: "claude-opus-4-6", fastMode: false },
  { provider: "gemini", model: "gemini-2.5-flash", fastMode: false },
];

function selectionKey(entry: RecentModelSelection) {
  return `${entry.provider}:${entry.model}:${entry.fastMode}`;
}

function isValidRecent(entry: RecentModelSelection) {
  return Boolean(getModelOption(entry.provider, entry.model));
}

export function useRecentModels() {
  const stored = useLocalStorage<RecentModelSelection[]>(STORAGE_KEY, []);

  const recents = computed(() => {
    const source = stored.value.length > 0 ? stored.value : DEMO_RECENTS;
    return source.filter(isValidRecent).slice(0, MAX_RECENT);
  });

  function recordSelection(entry: RecentModelSelection) {
    if (!isValidRecent(entry)) return;

    const next = [
      entry,
      ...stored.value.filter((item) => selectionKey(item) !== selectionKey(entry)),
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
