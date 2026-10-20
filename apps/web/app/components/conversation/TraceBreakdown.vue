<script setup lang="ts">
import { computed, ref } from "vue";
import { formatCount } from "~/utils/usageFormat";

// One proportional bar, each part its share of the whole, itemized beneath it
// with a count and a percentage. Pointing at (or tabbing to) a row dims every
// other part of the bar, so the row and its stretch of the bar read as one.

export type TracePart = {
  key: string;
  label: string;
  value: number;
  /** The part's tone, as a CSS color. */
  color: string;
};

const props = defineProps<{
  /** What the bar shows, for assistive tech. */
  label: string;
  parts: TracePart[];
}>();

const shown = computed(() => props.parts.filter((p) => p.value > 0));
const whole = computed(() => shown.value.reduce((sum, p) => sum + p.value, 0));

/** The row under the pointer; the bar dims every other part. */
const focus = ref<string | null>(null);

function share(value: number): string {
  const pct = whole.value ? (value / whole.value) * 100 : 0;
  return pct > 0 && pct < 1 ? "<1%" : `${Math.round(pct)}%`;
}
</script>

<template>
  <div class="tb">
    <div
      class="tb-bar"
      :class="{ 'tb-bar--focus': focus }"
      role="img"
      :aria-label="`${label}: ${shown.map((p) => `${p.label} ${formatCount(p.value)}`).join(', ')}`"
    >
      <i
        v-for="(p, i) in shown"
        :key="p.key"
        class="tb-seg"
        :class="{ 'is-on': focus === p.key }"
        :style="{ flexGrow: p.value, '--c': p.color, '--i': i }"
      />
    </div>
    <ul class="tb-rows">
      <li
        v-for="p in shown"
        :key="p.key"
        class="tb-row"
        tabindex="0"
        @mouseenter="focus = p.key"
        @mouseleave="focus = null"
        @focus="focus = p.key"
        @blur="focus = null"
      >
        <i class="tb-dot" :style="{ '--c': p.color }" aria-hidden="true" />
        <span class="tb-k">{{ p.label }}</span>
        <span class="tb-v">{{ formatCount(p.value) }}</span>
        <span class="tb-pct">{{ share(p.value) }}</span>
      </li>
    </ul>
  </div>
</template>

<style scoped>
.tb-bar {
  display: flex;
  gap: 3px;
  height: 10px;
}
.tb-seg {
  min-width: 4px;
  border-radius: 3px;
  background: var(--c);
  transition: opacity 0.2s ease;
}
@media (prefers-reduced-motion: no-preference) {
  .tb-seg {
    transform-origin: left center;
    animation: tb-seg-in 520ms var(--tr-ease) backwards;
    animation-delay: calc(120ms + var(--i, 0) * 60ms);
  }
}
@keyframes tb-seg-in {
  from { transform: scaleX(0); opacity: 0; }
}
.tb-bar--focus .tb-seg:not(.is-on) { opacity: 0.2; }

.tb-rows {
  display: flex;
  flex-direction: column;
  margin: 14px 0 0;
  padding: 0;
  list-style: none;
}
.tb-row {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr) auto 3.4em;
  align-items: center;
  gap: 10px;
  min-height: 30px;
  padding-inline: 8px;
  margin-inline: -8px;
  border-radius: 8px;
  font-size: 13px;
  color: var(--ink-soft);
  cursor: default;
  transition: background-color 0.15s ease;
}
@media (hover: hover) {
  .tb-row:hover { background: var(--hover); }
}
.tb-row:focus-visible {
  outline: 2px solid var(--tr-ring);
  outline-offset: 1px;
  background: var(--hover);
}
.tb-dot {
  width: 8px;
  height: 8px;
  border-radius: 2px;
  background: var(--c);
}
.tb-v,
.tb-pct {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  text-align: end;
}
.tb-v { color: var(--ink); }
.tb-pct { color: var(--tr-quiet); }
</style>
