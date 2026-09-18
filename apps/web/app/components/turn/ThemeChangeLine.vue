<script setup lang="ts">
import { computed, toRef } from "vue";
import ThemeBeads from "~/components/theme/ThemeBeads.vue";
import { useThemeSummaryReading } from "~/composables/useThemeSummaryReading";
import { beadsOf, type Bead } from "~/theme/beads";
import type { ThemeDefinition } from "~/theme/roles";
import type { RuntimeItem } from "~/types/desktop";

// An appearance change, announced next to the reply that announced it.
//
// The step row inside the turn's work shows the same change as a reading — every
// role, in order. This is the other half: the theme worn as the appearance pane
// wears it, because by the time you are reading the reply the question is no
// longer "what did it set" but "what am I looking at".
//
// It shows whether or not the work is folded away, since the change is in force
// either way. It only tells: the appearance pane is where a theme is chosen, and
// a second place to change one from would be a second place to keep right.
//
// Both ends come from the call's own stored record, which names theme ids but
// no palette that was never saved — except a preview's custom overrides, which
// the reading lays over the library table so the preview keeps its own bead.

const props = defineProps<{
  item: RuntimeItem;
}>();

const summary = useThemeSummaryReading(toRef(props, "item"));

/** A theme's own beads when the library still holds it — both faces of an
 *  adaptive theme, exactly as the appearance pane draws them. */
function beadsForTheme(theme: ThemeDefinition | null): Bead[] {
  return theme ? beadsOf(theme) : [];
}

const toLabel = computed(() => summary.toTheme.value?.label ?? "");
const fromLabel = computed(() => summary.fromTheme.value?.label ?? "");

const toBeads = computed(() => beadsForTheme(summary.toTheme.value));

/** The side a change came from, drawn only when it names a theme of its own. */
const fromBeads = computed(() => beadsForTheme(summary.fromTheme.value));

/** A preview is not the saved appearance, and a line that said nothing about
 *  that would present a change the next reload will undo as if it were
 *  settled. */
const isPreview = computed(() => summary.change.value?.preview === true);
</script>

<template>
  <div v-if="toBeads.length" class="tchange">
    <template v-if="fromBeads.length">
      <span class="tchange__side">
        <ThemeBeads :beads="fromBeads" :size="24" :label="fromLabel" />
        <span class="tchange__name">{{ fromLabel }}</span>
      </span>
      <span class="tchange__arrow" aria-hidden="true">→</span>
    </template>

    <span class="tchange__side">
      <ThemeBeads :beads="toBeads" :size="24" :label="toLabel" />
      <span class="tchange__name tchange__name--now">{{ toLabel }}</span>
    </span>

    <span v-if="isPreview" class="tchange__note">preview</span>
  </div>
</template>

<style scoped>
.tchange {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
  width: 100%;
  max-width: 42rem;
  min-height: 28px;
  padding: 0;
  font-size: 0.86rem;
  color: color-mix(in oklab, var(--ink) 45%, transparent);
}
.tchange__side {
  display: inline-flex;
  align-items: center;
  gap: 7px;
  min-width: 0;
}
.tchange__name {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
/* The theme that won reads as the current state, so it carries the ink the
   replaced one gives up. */
.tchange__name--now {
  color: color-mix(in oklab, var(--ink) 80%, transparent);
}
.tchange__arrow {
  flex: none;
  color: color-mix(in oklab, var(--ink) 28%, transparent);
}
.tchange__note {
  flex: none;
  margin-left: auto;
  font-family: var(--font-mono);
  font-size: 11.5px;
  color: color-mix(in oklab, var(--ink) 32%, transparent);
}
</style>
