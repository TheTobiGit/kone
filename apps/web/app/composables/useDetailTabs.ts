import { nextTick, ref, watch } from "vue";

import { useSound } from "~/composables/useSound";
import type { DetailIcon } from "~/utils/detailFormat";

// One tab of a detail page: what is true about the thing, and what it was
// told. The tabs are alternatives — the visitor comes for one of them — so the
// state below holds a single live key, not a set of folds.
export interface DetailTab<TabKey extends string> {
  key: TabKey;
  label: string;
  icon: DetailIcon;
}

// The tab state every detail page repeats: the live tab, the strip element,
// click and arrow-key movement, and the reset back to the first tab whenever
// the opened id changes (a tab left open on one entry must not greet you
// inside the next). The strip markup itself lives in DetailTabs, which is the
// only caller — this stays the boring logic half.
export function useDetailTabs<TabKey extends string>(
  tabs: readonly DetailTab<TabKey>[],
  resetOn: () => string,
) {
  const { cue } = useSound();

  const first = tabs[0];
  if (!first) throw new Error("useDetailTabs requires at least one tab");
  const initial = first.key;

  const tab = ref<TabKey>(initial);
  const tabStrip = ref<HTMLElement>();

  function selectTab(key: TabKey): void {
    if (tab.value === key) return;
    tab.value = key;
    cue("select");
  }

  // Left and right walk the strip, since only the live tab is in the tab
  // order. The moved-to tab takes focus with it — otherwise the arrows would
  // keep answering to a button that is no longer the one selected.
  async function stepTab(delta: number): Promise<void> {
    const keys = tabs.map((t) => t.key);
    const next = keys[(keys.indexOf(tab.value) + delta + keys.length) % keys.length];
    if (next === undefined) return;
    selectTab(next);
    await nextTick();
    tabStrip.value?.querySelector<HTMLElement>('[aria-selected="true"]')?.focus();
  }

  watch(resetOn, () => {
    tab.value = initial;
  });

  return { tab, tabStrip, selectTab, stepTab };
}
