<script setup lang="ts">
import { computed } from "vue";

// A turn's trace, as one quiet row under the turn it traces: the split drawn
// first as a small bar, then the numbers it belongs to, each fact kept whole
// so a narrow column wraps between facts rather than inside one.
//
// The bar leads because it is the only thing here that is a picture; the
// numbers read as its caption. Nothing opens over the thread.

export type TracePart = {
  key: string;
  label: string;
  value: number;
  /** The part's tone, as a CSS color. */
  color: string;
  /** The part's number, as the row reads it. */
  text: string;
};

const props = defineProps<{
  /** What the trace is, for assistive tech; the row itself needs no label. */
  label: string;
  /** The row's numbers, in reading order. */
  facts: string[];
  /** The split the bar draws and the row names after it. */
  parts?: TracePart[];
}>();

const shown = computed(() => (props.parts ?? []).filter((part) => part.value > 0));
const described = computed(() => [
  ...props.facts,
  ...shown.value.map((part) => `${part.label} ${part.text}`),
].join(", "));
</script>

<template>
  <p class="ti" role="group" :aria-label="`${label} trace: ${described}`">
    <span class="ti-core">
      <span v-if="shown.length" class="ti-bar" aria-hidden="true">
        <i
          v-for="part in shown"
          :key="part.key"
          :style="{ flexGrow: part.value, background: part.color }"
        />
      </span>
      <span v-for="(fact, i) in facts" :key="`f${i}`" class="ti-fact">{{ fact }}</span>
    </span>
    <span v-if="shown.length" class="ti-fams">
      <span v-for="part in shown" :key="part.key" class="ti-fam">
        <i class="ti-dot" :style="{ background: part.color }" aria-hidden="true" />
        <span>{{ part.label }}</span>
        <span class="ti-fam__value">{{ part.text }}</span>
      </span>
    </span>
  </p>
</template>

<style scoped>
.ti {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 10px;
  width: fit-content;
  max-width: 100%;
  min-width: 0;
  margin: 0;
  padding-block: 2px;
  font-size: 12px;
  line-height: 1.5;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}

/* The numbers stay one run: a narrow column breaks before the families, never
   inside a fact. */
.ti-core {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.ti-fact + .ti-fact::before {
  content: "·";
  margin-inline: 7px;
  color: color-mix(in srgb, var(--ink) 40%, var(--ground));
}

.ti-bar {
  display: flex;
  flex: none;
  width: 40px;
  height: 6px;
  margin-inline-end: 10px;
  overflow: hidden;
  border-radius: 3px;
}
.ti-bar i {
  flex-basis: 0;
}

.ti-fams {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 3px 12px;
}
.ti-fam {
  display: inline-flex;
  align-items: center;
  white-space: nowrap;
}
.ti-fam + .ti-fam::before {
  content: "·";
  margin-inline-end: 8px;
  color: color-mix(in srgb, var(--ink) 40%, var(--ground));
}
.ti-dot {
  flex: none;
  width: 6px;
  height: 6px;
  margin-inline-end: 4px;
  border-radius: 50%;
}
.ti-fam__value {
  margin-inline-start: 4px;
}
</style>
