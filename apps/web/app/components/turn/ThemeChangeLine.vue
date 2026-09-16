<script setup lang="ts">
import { computed, toRef } from "vue";
import ThemeBeads from "~/components/theme/ThemeBeads.vue";
import { useThemeSummaryReading } from "~/composables/useThemeSummaryReading";
import { beadFor, beadsOf, type Bead } from "~/theme/beads";
import { findTheme } from "~/theme/library";
import type { ThemeDefinition } from "~/theme/roles";
import type { RuntimeItem } from "~/types/desktop";
import type { ThemeFacet, ThemeReceipt } from "~/utils/themeReceipts";

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
// Two sources, in order of fidelity. The receipt is what this window recorded as
// it applied the change, and is the only thing that knows a preview's own
// colours. Its absence is ordinary — a reloaded transcript has none — so the
// call's stored summary is read instead, which names both themes but not a
// palette that was never saved.

const props = defineProps<{
  item: RuntimeItem;
  /** The change this call made, when this window was the one that made it. */
  receipt?: ThemeReceipt | null;
}>();

const summary = useThemeSummaryReading(toRef(props, "item"));

/** A theme's own beads when the library still holds it — both faces of an
 *  adaptive theme, exactly as the appearance pane draws them. A preview built
 *  from custom colours is in no library, so it wears the single face it was
 *  actually painted in. */
function beadsForFacet(facet: ThemeFacet): Bead[] {
  const known = findTheme(facet.themeId);
  return known ? beadsOf(known) : [beadFor(facet.colors, facet.scheme)];
}

function beadsForTheme(theme: ThemeDefinition | null): Bead[] {
  return theme ? beadsOf(theme) : [];
}

const toLabel = computed(() => props.receipt?.after.label ?? summary.toTheme.value?.label ?? "");
const fromLabel = computed(
  () => props.receipt?.before.label ?? summary.fromTheme.value?.label ?? "",
);

const toBeads = computed(() =>
  props.receipt ? beadsForFacet(props.receipt.after) : beadsForTheme(summary.toTheme.value),
);

/** The side a change came from, drawn only when it is a different theme — a
 *  bare mode change would otherwise point the same mark at itself. */
const fromBeads = computed(() => {
  const r = props.receipt;
  if (r) return r.before.themeId === r.after.themeId ? [] : beadsForFacet(r.before);
  return beadsForTheme(summary.fromTheme.value);
});

/** A live preview is not the saved appearance, and a line that said nothing
 *  about that would present a change the next reload will undo as if it were
 *  settled. */
const isPreview = computed(() => props.receipt?.kind === "preview" && props.receipt.previewLive);
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
