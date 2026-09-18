<script setup lang="ts">
import { computed } from "vue";
import ThemeChangeLine from "~/components/turn/ThemeChangeLine.vue";
import { isRecordedAppearanceCall } from "~/composables/useThemeSummaryReading";
import type { RuntimeItem } from "~/types/desktop";

// What a turn did to the app's appearance, standing next to its reply.
//
// A settled turn folds its work away, which is right for reading and wrong for a
// change that is still in force: "you are on Forge now" is a state you may want
// to see, and the mark for it cannot be inside a fold the reader has no reason
// to open.
//
// Each call carries its own change record, so there is nothing to pair: a call
// with a record gets a line, one without (a bare mode change, a cancel, a
// failure) gets none.

const props = defineProps<{
  /** The turn's parts, in arrival order. */
  items: RuntimeItem[];
}>();

const changes = computed(() => props.items.filter(isRecordedAppearanceCall));
</script>

<template>
  <div v-if="changes.length" class="tthemes">
    <ThemeChangeLine v-for="item in changes" :key="item.itemId" :item="item" />
  </div>
</template>

<style scoped>
.tthemes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
