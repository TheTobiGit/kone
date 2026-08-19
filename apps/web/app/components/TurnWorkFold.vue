<script setup lang="ts">
import { ref, watch } from "vue";
import AgentActivity from "~/components/AgentActivity.vue";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import { segText, type RenderGroup } from "~/utils/conversationSegments";

// A settled turn's work — every thinking beat, tool call AND the running
// narration between them — folded behind the agent-name toggler so the transcript
// reads as a clean exchange. Only the turn's final reply stays open below this;
// everything the agent said and did on the way there lives in here. Collapsed by
// default. Opening it replays the turn in arrival order: activity batches and the
// narration that framed them, each batch still expandable for detail.

const props = defineProps<{
  /** Everything before the final reply — steps and narration text, in arrival
   *  order. */
  groups: RenderGroup[];
  /** Whether the fold is open. */
  open: boolean;
  /** Loaded from storage — carried through to the batches. */
  historical?: boolean;
}>();

// Mount the body on first open and keep it, so the close animation has something
// to collapse and a re-open doesn't re-run the batches' entrance.
const everOpened = ref(props.open);
watch(
  () => props.open,
  (v) => {
    if (v) everOpened.value = true;
  },
);
</script>

<template>
  <div class="fold" :class="{ 'fold--open': open }">
    <div class="fold__region">
      <div class="fold__inner">
        <template v-if="everOpened">
          <template v-for="grp in groups" :key="grp.kind === 'steps' ? grp.key : grp.seg.key">
            <AgentActivity
              v-if="grp.kind === 'steps'"
              :segments="grp.segments"
              :running="false"
              :is-tail="false"
              :historical="historical"
            />
            <!-- The agent's between-tool narration — quieter than the reply, so it
                 reads as the story of the work, not the answer. -->
            <MarkdownMessage
              v-else
              class="fold__narration"
              :source="segText(grp.seg)"
              :historical="historical"
            />
          </template>
        </template>
      </div>
    </div>
  </div>
</template>

<style scoped>
.fold {
  width: 100%;
  max-width: 42rem;
}
/* Height animation without JS measurement: the region is a one-track grid that
   slides from a collapsed 0fr to content-height 1fr; the inner clips the body
   while it moves. */
.fold__region {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.fold--open .fold__region {
  grid-template-rows: 1fr;
}
.fold__inner {
  min-height: 0;
  overflow: hidden;
}
.fold--open .fold__inner {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding-top: 4px;
}
/* Narration inside the fold reads as recessed work notes, not the answer. */
.fold__narration {
  font-size: 0.9em;
  color: var(--muted);
}
@media (prefers-reduced-motion: reduce) {
  .fold__region {
    transition: none;
  }
}
</style>
