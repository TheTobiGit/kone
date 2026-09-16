<script setup lang="ts">
import { computed } from "vue";
import ThemeChangeLine from "~/components/turn/ThemeChangeLine.vue";
import type { RuntimeItem } from "~/types/desktop";
import {
  assignThemeReceipts,
  isSettledThemeCall,
  themeReceiptsForTurn,
} from "~/utils/themeReceipts";

// What a turn did to the app's appearance, standing next to its reply.
//
// A settled turn folds its work away, which is right for reading and wrong for a
// change that is still in force: "you are on Forge now" is a state you may want
// to see, and the mark for it cannot be inside a fold the reader has no reason
// to open.
//
// This is also where a change is matched to the call that made it. The turn's
// parts arrive in order and so do its receipts, so the pairing is done once,
// here, by position — never by a row claiming a record as it mounts, which the
// live feed's windowing would have got wrong.

const props = defineProps<{
  /** The turn's parts, in arrival order. */
  items: RuntimeItem[];
  threadId?: string | null;
  /** The turn these parts belong to — what scopes its receipts. */
  turnId?: string | null;
}>();

const changes = computed(() => props.items.filter(isSettledThemeCall));

const assignment = computed(() =>
  assignThemeReceipts(changes.value, themeReceiptsForTurn(props.threadId, props.turnId)),
);
</script>

<template>
  <div v-if="changes.length" class="tthemes">
    <ThemeChangeLine
      v-for="item in changes"
      :key="item.itemId"
      :item="item"
      :receipt="assignment.get(item.itemId) ?? null"
    />
  </div>
</template>

<style scoped>
.tthemes {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
</style>
