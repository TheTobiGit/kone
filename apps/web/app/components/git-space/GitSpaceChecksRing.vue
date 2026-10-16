<script setup lang="ts">
import { computed } from "vue";
import type { GitHubCheckCounts } from "~/types/desktop";

// A pull request's checks as a ring: one arc per verdict, sized by how many
// checks reached it, starting at twelve o'clock with a hairline gap between
// arcs. A single word ("failing") hides how much failed; the ring shows one red
// sliver in a green circle, or the other way round, at a glance.
//
// With no checks at all the ring is an empty track, so a row without CI still
// holds its place in the column.

const props = withDefaults(
  defineProps<{
    counts: GitHubCheckCounts;
    size?: number;
    stroke?: number;
  }>(),
  { size: 22, stroke: 3 },
);

const ORDER = ["passing", "failing", "pending", "skipped"] as const;

interface Arc {
  key: (typeof ORDER)[number];
  dash: string;
  offset: number;
}

const r = computed(() => (props.size - props.stroke) / 2);
const circumference = computed(() => 2 * Math.PI * r.value);
const total = computed(() => ORDER.reduce((n, k) => n + props.counts[k], 0));

const arcs = computed<Arc[]>(() => {
  const n = total.value;
  if (!n) return [];
  const c = circumference.value;
  const present = ORDER.filter((k) => props.counts[k] > 0);
  // One verdict is a closed circle; a gap there would read as a missing check.
  const gap = present.length > 1 ? Math.min(2, c / n / 3) : 0;
  const out: Arc[] = [];
  let at = 0;
  for (const key of present) {
    const len = (props.counts[key] / n) * c;
    out.push({ key, dash: `${Math.max(0.5, len - gap)} ${c}`, offset: -at });
    at += len;
  }
  return out;
});

const label = computed(() => {
  const parts: string[] = [];
  for (const k of ORDER) if (props.counts[k]) parts.push(`${props.counts[k]} ${k}`);
  return parts.length ? `Checks: ${parts.join(", ")}` : "No checks";
});
</script>

<template>
  <svg
    class="gcr"
    :width="size"
    :height="size"
    :viewBox="`0 0 ${size} ${size}`"
    role="img"
    :aria-label="label"
  >
    <title>{{ label }}</title>
    <circle
      class="gcr__track"
      :cx="size / 2"
      :cy="size / 2"
      :r="r"
      :stroke-width="stroke"
      fill="none"
    />
    <circle
      v-for="a in arcs"
      :key="a.key"
      class="gcr__arc"
      :class="`gcr__arc--${a.key}`"
      :cx="size / 2"
      :cy="size / 2"
      :r="r"
      :stroke-width="stroke"
      :stroke-dasharray="a.dash"
      :stroke-dashoffset="a.offset"
      fill="none"
      stroke-linecap="butt"
      :transform="`rotate(-90 ${size / 2} ${size / 2})`"
    />
  </svg>
</template>

<style scoped>
.gcr {
  display: block;
  flex-shrink: 0;
  overflow: visible;
}
.gcr__track {
  stroke: color-mix(in srgb, var(--ink) 9%, transparent);
}
.gcr__arc {
  transition: stroke-dasharray var(--gs-t-small, 200ms) ease;
}
.gcr__arc--passing {
  stroke: var(--ok);
}
.gcr__arc--failing {
  stroke: var(--danger);
}
.gcr__arc--pending {
  stroke: var(--warn);
}
.gcr__arc--skipped {
  stroke: color-mix(in srgb, var(--ink) 22%, transparent);
}
@media (prefers-reduced-motion: reduce) {
  .gcr__arc {
    transition: none;
  }
}
</style>
