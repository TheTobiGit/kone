<script setup lang="ts">
import { computed } from "vue";
import { compactionMarkerLabel } from "~/utils/compactionMarkers";
import type { CompactionRecord } from "~/types/desktop";

// One settled compaction boundary as a quiet centered line on the timeline.
// The centered `thread-date` look lives in the hosting timeline's stylesheet —
// this component only owns the line itself, so it stays a plain root the
// parent's scoped styles still reach.
const props = defineProps<{
  marker: CompactionRecord;
  /** The timeline's own clock (its "when" voice) — passed in rather than
   *  imported so every surface stamps the same time the same way. */
  formatTime: (at: number) => string;
}>();

const label = computed(() => compactionMarkerLabel(props.marker, props.formatTime));
</script>

<template>
  <div class="thread-date">
    <span class="thread-date__text">{{ label }}</span>
  </div>
</template>
