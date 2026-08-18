<script setup lang="ts">
import { ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import AgentActivity from "~/components/AgentActivity.vue";
import MarkdownMessage from "~/components/MarkdownMessage.vue";
import TurnOrb from "~/components/TurnOrb.vue";
import { segText, type RenderGroup } from "~/utils/conversationSegments";

// A settled turn's work — every thinking beat, tool call AND the running
// narration between them — folded behind one quiet receipt so the transcript
// reads as a clean exchange. Only the turn's final reply stays open below this;
// everything the agent said and did on the way there lives in here. Collapsed by
// default. Opening it replays the turn in arrival order: activity batches and the
// narration that framed them, each batch still expandable for detail.

const props = defineProps<{
  /** Everything before the final reply — steps and narration text, in arrival
   *  order. */
  groups: RenderGroup[];
  /** The receipt's duration, shown beside the work orb — e.g. "12s". */
  label: string;
  /** Loaded from storage — carried through to the batches. */
  historical?: boolean;
  /** Open on mount — a turn that ended on work, with no reply text to stand in
   *  for it, shouldn't collapse to nothing. */
  defaultOpen?: boolean;
}>();

const { cue } = useSound();
const open = ref(props.defaultOpen ?? false);
// Mount the body on first open and keep it, so the close animation has something
// to collapse and a re-open doesn't re-run the batches' entrance.
const everOpened = ref(open.value);
watch(open, (v) => {
  if (v) everOpened.value = true;
});
function toggle(): void {
  open.value = !open.value;
  cue(open.value ? "expand" : "collapse");
}
</script>

<template>
  <div class="fold" :class="{ 'fold--open': open }">
    <button type="button" class="fold__head" :aria-expanded="open" @click="toggle">
      <span class="fold__orb">
        <TurnOrb state="working" :size="14" :active="false" aria-label="Work" />
      </span>
      <span class="fold__label">{{ label }}</span>
      <HugeiconsIcon class="fold__chev" :icon="ArrowDown01Icon" :size="13" :stroke-width="2" />
    </button>

    <div class="fold__region">
      <div class="fold__inner">
        <template v-if="everOpened">
          <template v-for="(grp, i) in groups" :key="grp.kind === 'steps' ? grp.key : grp.seg.key">
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
.fold__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 6px;
  margin-left: -6px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.fold__head:hover {
  background: var(--hover);
  color: var(--ink);
}
.fold__orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
}
.fold__chev {
  transition: transform 0.24s ease;
  opacity: 0.75;
}
.fold--open .fold__chev {
  transform: rotate(180deg);
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
  padding-top: 8px;
}
/* Narration inside the fold reads as recessed work notes, not the answer. */
.fold__narration {
  font-size: 0.9em;
  color: var(--muted);
}
@media (prefers-reduced-motion: reduce) {
  .fold__region,
  .fold__chev {
    transition: none;
  }
}
</style>
