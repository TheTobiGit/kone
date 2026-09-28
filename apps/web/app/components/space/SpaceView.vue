<script setup lang="ts">
import type { Project } from "~/composables/useProject";

// The project's fourth tab: a place to see (and later configure) what the agents
// are doing here. A board of compact cards, each answering one question at a
// glance and linking out for the full story. Setup (instructions, skills, MCP)
// and live sessions will join activity, spend and models.

const props = defineProps<{
  project: Project;
  /** This tab is the one on screen. Re-reads wait until it is. */
  visible: boolean;
}>();

// One set of usage reads for the whole board — every card draws from it.
const usage = useSpaceUsage(
  () => props.project.path,
  () => props.visible,
);
</script>

<template>
  <div class="sp">
    <div class="sp__board">
      <SpaceActivityCard class="sp__card--wide" :usage="usage" />
      <SpaceSpendCard :usage="usage" />
      <SpaceModelsCard :usage="usage" />
    </div>
  </div>
</template>

<style scoped>
.sp {
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  /* Clear the fixed chrome row (3.25rem) the back arrow and nav ride. */
  padding: 5rem 2rem 3rem;
  animation: sp-in 0.32s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@keyframes sp-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
}
/* Two columns of cards on a wide window, one on a narrow one; a wide card
   takes the whole row. */
.sp__board {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
  gap: 12px;
  max-width: 1040px;
  margin: 0 auto;
}
.sp__board > .sp__card--wide {
  grid-column: 1 / -1;
}
@media (prefers-reduced-motion: reduce) {
  .sp {
    animation: none;
  }
}
</style>
