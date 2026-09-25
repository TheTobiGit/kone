<script setup lang="ts">
import ThemeSwatch from "~/components/theme/ThemeSwatch.vue";
import type { ThemeColors } from "~/theme/roles";

// What an appearance call changed, role by role, under the row that reports it.
//
// Two palettes and an arrow: the window before, the window after. The row above
// says which tool ran; this says what it changed, for a reader who wants the
// values rather than the theme. The announcement next to the reply is the other
// reading of the same change — see components/turn/ThemeChangeLine.vue.

defineProps<{
  toLabel: string;
  toColors: ThemeColors;
  fromLabel?: string;
  fromColors?: ThemeColors | null;
}>();
</script>

<template>
  <div class="trec">
    <template v-if="fromColors">
      <ThemeSwatch :colors="fromColors" :label="fromLabel" />
      <span class="trec__name">{{ fromLabel }}</span>
      <span class="trec__arrow" aria-hidden="true">→</span>
    </template>

    <ThemeSwatch :colors="toColors" :label="toLabel" />
    <span class="trec__name trec__name--now">{{ toLabel }}</span>
  </div>
</template>

<style scoped>
/* The thread's own quiet line: no ground, no border. What makes it readable is
   the palette, so everything around the dots gives way to them. */
.trec {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-height: 24px;
  padding: 2px 0;
  font-size: 0.8rem;
  color: color-mix(in oklab, var(--ink) 55%, transparent);
}
.trec__name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* The side that won reads as the current state, so it carries the ink the rest
   of the line gives up. */
.trec__name--now {
  color: color-mix(in oklab, var(--ink) 78%, transparent);
}
.trec__arrow {
  flex: none;
  color: color-mix(in oklab, var(--ink) 34%, transparent);
}
</style>
