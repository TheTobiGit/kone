<script setup lang="ts">
import { computed } from "vue";
import type { ThemeRole } from "~/theme/roles";

// A theme said in five dots: ground, accent, secondary, surface, ink.
//
// Ground and surface are the two that can land on a background of their own
// colour — a light theme's ground on the light app is an invisible dot — so
// both wear a hairline of the theme's own line colour. The other three are
// always saturated or inked enough to hold their own edge.

const props = withDefaults(
  defineProps<{
    /** A role table, or the subset of one an override carries. Roles the table
     *  doesn't hold are skipped rather than drawn as a hole. */
    colors: Partial<Record<ThemeRole, string>>;
    /** Dot diameter in px. */
    size?: number;
    /** Read out in place of the dots, which carry no meaning on their own. */
    label?: string;
  }>(),
  { size: 7 },
);

const ORDER: { role: ThemeRole; title: string; ringed: boolean }[] = [
  { role: "ground", title: "Ground", ringed: true },
  { role: "accent", title: "Accent", ringed: false },
  { role: "accentSecondary", title: "Secondary", ringed: false },
  { role: "raised", title: "Surface", ringed: true },
  { role: "ink", title: "Ink", ringed: false },
];

/** Only called for a role the table holds — `dots` filters the rest — so the
 *  colour is read without a stand-in for one that cannot be missing. */
function dotStyle(role: ThemeRole, ringed: boolean): Record<string, string> {
  const style: Record<string, string> = {
    backgroundColor: props.colors[role]!,
    width: `${props.size}px`,
    height: `${props.size}px`,
  };
  const line = props.colors.lineSoft;
  if (ringed && line) style.boxShadow = `inset 0 0 0 1px ${line}`;
  return style;
}

const dots = computed(() =>
  ORDER.filter((d) => !!props.colors[d.role]).map((d) => ({
    key: d.role,
    title: d.title,
    style: dotStyle(d.role, d.ringed),
  })),
);
</script>

<template>
  <span class="tsw" :role="label ? 'img' : undefined" :aria-label="label" :aria-hidden="label ? undefined : 'true'">
    <span v-for="dot in dots" :key="dot.key" class="tsw__dot" :style="dot.style" :title="dot.title" />
  </span>
</template>

<style scoped>
.tsw {
  display: inline-flex;
  align-items: center;
  gap: 3px;
}
.tsw__dot {
  border-radius: 50%;
  flex-shrink: 0;
}
</style>
