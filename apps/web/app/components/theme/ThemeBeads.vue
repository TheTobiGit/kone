<script setup lang="ts">
import { computed } from "vue";
import type { Bead } from "~/theme/beads";

// The beads of one theme, overlapping: the mark the appearance pane wears,
// drawn wherever a theme has to be recognised at a glance.
//
// Everything here is the drawing and nothing is the recipe — the caller hands
// beads already mixed (see `~/theme/beads`), so the pane's list and a thread's
// announcement cannot end up lighting the same theme differently.

const props = withDefaults(
  defineProps<{
    beads: Bead[];
    /** Diameter in px. The pane wears these at 40; a line of text wants ~22. */
    size?: number;
    label?: string;
  }>(),
  { size: 40 },
);

/** Beads overlap by just over a third, which is what makes a pair read as one
 *  mark rather than two circles side by side. */
const overlap = computed(() => `${-Math.round(props.size * 0.35)}px`);

const style = computed(() => ({
  width: `${props.size}px`,
  height: `${props.size}px`,
}));
</script>

<template>
  <span
    class="tbeads"
    :role="label ? 'img' : undefined"
    :aria-label="label"
    :aria-hidden="label ? undefined : 'true'"
  >
    <span
      v-for="(bead, i) in beads"
      :key="bead.key"
      class="tbead"
      :style="{
        ...style,
        backgroundColor: bead.ground,
        marginLeft: i > 0 ? overlap : undefined,
        zIndex: beads.length - i,
        boxShadow: `inset 0 0 0 1px color-mix(in srgb, ${bead.ink} 12%, transparent)`,
      }"
    >
      <span class="tbead__wash" :style="{ backgroundImage: bead.wash }" />
    </span>
  </span>
</template>

<style scoped>
.tbeads {
  display: inline-flex;
  align-items: center;
}
.tbead {
  position: relative;
  display: block;
  border-radius: 50%;
  overflow: hidden;
  transition: transform 320ms cubic-bezier(0.22, 1, 0.36, 1);
}
/* The wash overspills and blurs, so the accent reads as light in the ground
   rather than a disc printed on it. */
.tbead__wash {
  position: absolute;
  inset: -12%;
  border-radius: 50%;
  filter: blur(3px);
}
@media (prefers-reduced-motion: reduce) {
  .tbead {
    transition: none;
  }
}
</style>
