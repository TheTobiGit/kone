<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import AgentActivity from "~/components/agent/AgentActivity.vue";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import { segText, type WorkGroup } from "~/utils/conversationSegments";
import type { ActivityFold } from "~/utils/responseDisplay";

// A settled turn's work — every thinking beat, tool call AND the running
// narration between them — folded behind the agent-name toggler so the transcript
// reads as a clean exchange. Only the turn's final reply stays open below this;
// everything the agent said and did on the way there lives in here. Collapsed by
// default. Opening it replays the turn in arrival order: activity batches and the
// narration that framed them, each batch still expandable for detail.

const props = defineProps<{
  /** Everything before the final reply — steps and narration text, in arrival
   *  order. */
  groups: WorkGroup[];
  /** Whether the fold is open. */
  open: boolean;
  /** Loaded from storage — carried through to the batches. */
  historical?: boolean;
  /** How the batches hold themselves once the fold is open — the reader's
   *  tool-call choice, carried through. */
  fold?: ActivityFold;
}>();

// Mount the body on first open (or immediately for live turns so the initial close
// animates rather than popping), so the close animation has something to collapse
// and a re-open doesn't re-run the batches' entrance.
const everOpened = ref(props.open || !props.historical);
watch(
  () => props.open,
  (v) => {
    if (v) everOpened.value = true;
  },
);

// A live turn settling into a closed fold mounts it *open* and closes it a
// frame later. Mounted closed, the track would already be at 0fr with nothing
// to transition from, and the work above the reply would vanish in one frame —
// the reply jumping up the column by the whole height of the turn.
const settling = ref(!props.historical && !props.open);
onMounted(() => {
  if (!settling.value) return;
  requestAnimationFrame(() => requestAnimationFrame(() => (settling.value = false)));
});
</script>

<template>
  <div class="fold" :class="{ 'fold--open': open || settling }">
    <div class="fold__region">
      <div class="fold__inner">
        <template v-if="everOpened">
          <template v-for="grp in groups" :key="grp.kind === 'steps' ? grp.key : grp.seg.key">
            <!-- Everything in here is finished work, already read once as it
                 streamed: it renders settled, so folding a live turn away
                 doesn't replay a single row's or word's entrance. -->
            <AgentActivity
              v-if="grp.kind === 'steps'"
              :segments="grp.segments"
              :running="false"
              :is-tail="false"
              :historical="true"
              :fold="fold"
            />
            <!-- The agent's between-tool narration — quieter than the reply, so it
                 reads as the story of the work, not the answer. -->
            <MarkdownMessage
              v-else
              class="fold__narration"
              :source="segText(grp.seg)"
              :historical="true"
            />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* A closed fold has to take up no room at all, which is not the same as having
   no height. A collapsed fold costs no gap — the parent stack hands that back
   with a discrete negative margin (see .stack in ConversationThread), so this
   side carries no compensation and no margin animation: collapsed or not is a
   binary fact, and the grid track below carries the motion. */
.fold {
  width: 100%;
  min-width: 0;
}
/* Height animation without JS measurement: the region is a one-track grid that
   slides from a collapsed 0fr to content-height 1fr; the inner clips the body
   while it moves. */
.fold__region {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.38s cubic-bezier(0.22, 1, 0.36, 1);
}
.fold--open .fold__region {
  grid-template-rows: 1fr;
}
.fold__inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
}
/* Narration inside the fold reads as recessed work notes, not the answer. */
.fold__narration {
  min-width: 0;
  max-width: 100%;
  font-size: 0.9em;
  color: var(--muted);
}
@media (prefers-reduced-motion: reduce) {
  .fold__region {
    transition: none;
  }
}
</style>
