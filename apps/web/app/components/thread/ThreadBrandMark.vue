<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { SolarChatRoundLineBrokenIcon } from "~/utils/solarChatIcons";
import { brandOf, handoffSourceBrand, isHandoff, threadHands } from "~/utils/stripColumnLabels";
import type { Pane } from "~/types/studio";

// Who is answering a thread, as the marks it wears: a single vendor mark, a
// handoff (source → live) or the chain of hands it has passed through, plus the
// side-chat flag. One component so every surface that names a thread — the
// column header and the dock header — agrees on the answer, and a handoff or a
// hand-in reads the same wherever it is drawn.

const props = withDefaults(defineProps<{ pane: Pane; size?: number }>(), { size: 15 });

// `pane.session` is a union across all three pane kinds, so narrow to a thread
// before reading its side-chat flag; the helpers below already ignore a pane
// that is not a thread.
const sideChat = computed(
  () => props.pane.kind === "thread" && (props.pane.session?.isSideChat.value ?? false),
);
</script>

<template>
  <span class="brand">
    <template v-if="isHandoff(props.pane)">
      <ProviderLogo :brand="handoffSourceBrand(props.pane)" :size="props.size" class="brand__source" />
      <span class="brand__arrow" aria-hidden="true">→</span>
      <ProviderLogo :brand="brandOf(props.pane)" :size="props.size" />
    </template>
    <template v-else-if="threadHands(props.pane).length > 0">
      <ProviderLogo
        v-for="(brand, hi) in threadHands(props.pane)"
        :key="`${brand}-${hi}`"
        :brand="brand"
        :size="props.size"
        :class="{ brand__past: hi < threadHands(props.pane).length - 1 }"
      />
    </template>
    <ProviderLogo v-else :brand="brandOf(props.pane)" :size="props.size" />
    <span
      v-if="sideChat"
      class="brand__sidechat"
      title="Side chat — forked from a conversation"
    >
      <HugeiconsIcon
        :icon="SolarChatRoundLineBrokenIcon"
        :size="props.size - 4"
        :stroke-width="2"
        aria-hidden="true"
      />
    </span>
  </span>
</template>

<style scoped>
.brand {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  min-width: 0;
  flex: none;
}
.brand :deep(.plogo) {
  flex: none;
}
/* The hands a thread has left behind read dimmer than the one holding it now —
   the live engine is what the eye should land on. A handoff's source sits a
   touch brighter than a chain of hands: it is the one other engine tied to this
   thread, not one of many it passed through. */
.brand__past {
  opacity: 0.45;
}
.brand__source {
  opacity: 0.55;
}
.brand__arrow {
  display: inline-flex;
  flex: none;
  align-items: center;
  line-height: 1;
  font-size: 10px;
  color: var(--muted);
  opacity: 0.8;
}
.brand__sidechat {
  display: inline-flex;
  flex: none;
  align-items: center;
  color: color-mix(in srgb, var(--accent) 72%, var(--ink-soft));
}
</style>
