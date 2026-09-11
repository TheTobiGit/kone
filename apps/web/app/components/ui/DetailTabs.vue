<script setup lang="ts" generic="TabKey extends string">
import { HugeiconsIcon } from "@hugeicons/vue";

import { useDetailTabs, type DetailTab } from "~/composables/useDetailTabs";

// The pill switcher over one panel: the tab strip directly framing its
// content, without disconnected spacing. One home for the strip markup and
// its visuals, so a tweak lands on every detail page at once.
//
// The page reads the live tab through the default slot (`v-slot="{ tab }"`)
// and renders its own panels inside. `resetKey` is the opened entry's id —
// the tabs rest back to the first one whenever it changes. `canFocus` keeps
// the strip out of the tab order while its drawer is closed.
const props = defineProps<{
  tabs: readonly DetailTab<TabKey>[];
  resetKey: string;
  ariaLabel: string;
  canFocus: boolean;
}>();

const { tab, tabStrip, selectTab, stepTab } = useDetailTabs(props.tabs, () => props.resetKey);
</script>

<template>
  <div class="det__body">
    <div
      ref="tabStrip"
      class="det__tabs"
      role="tablist"
      :aria-label="ariaLabel"
      @keydown.left.prevent="stepTab(-1)"
      @keydown.right.prevent="stepTab(1)"
    >
      <button
        v-for="t in tabs"
        :key="t.key"
        type="button"
        role="tab"
        class="det__tab"
        :class="{ 'det__tab--on': tab === t.key }"
        :aria-selected="tab === t.key"
        :tabindex="canFocus && tab === t.key ? 0 : -1"
        @click="selectTab(t.key)"
      >
        <HugeiconsIcon
          class="det__tab-glyph"
          :icon="t.icon"
          :size="14"
          :stroke-width="1.6"
          aria-hidden="true"
        />
        <span class="det__tab-label">{{ t.label }}</span>
      </button>
    </div>

    <div class="det__panel" role="tabpanel" :aria-label="tabs.find((t) => t.key === tab)?.label">
      <slot :tab="tab" />
    </div>
  </div>
</template>

<style scoped>
.det__body {
  display: flex;
  flex-direction: column;
  gap: 16px;
}

.det__tabs {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  padding: 3px;
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  width: fit-content;
}

.det__tab {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  height: 28px;
  padding-inline: 11px;
  border-radius: 8px;
  font-size: 12px;
  font-weight: 500;
  color: var(--muted);
  background: transparent;
  border: 0;
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.det__tab:hover {
  color: var(--ink);
}
.det__tab--on {
  color: var(--ink);
  background-color: var(--panel);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08);
}

.det__panel {
  display: flex;
  flex-direction: column;
}

@media (prefers-reduced-motion: reduce) {
  .det__tab,
  .det__tab-glyph,
  .det__tab-label {
    transition: none;
  }
}
</style>
