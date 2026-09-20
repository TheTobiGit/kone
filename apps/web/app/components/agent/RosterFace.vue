<script setup lang="ts">
// A roster agent, as a face: their picture if they have one, and the face
// drawn from their own id if they don't.
//
// One branch, in one place, because it was five — and the five did not agree.
// Some asked whether the avatar record existed, some whether it had a source in
// it, so an agent whose picture had been cleared without its record going with
// it showed as a broken image on one surface and as its drawn face on the next.
// The question is the same question everywhere it is asked, so it is answered
// here and the answer is `src`: what there is to show, not what there is a
// record of.
//
// Not `AgentFace`, which is seeded by a thread id and draws whoever that thread
// rolled. This one is handed the roster row itself, for the surfaces that
// already know who they are naming — pickers, settings, the timeline's routing
// mark.
import { computed } from "vue";
import type { Agent } from "~/utils/agents";

const props = defineProps<{
  agent: Agent;
  /** Diameter in px. */
  size: number;
  /** The drawn face's diameter inside that. A picture always fills the disc —
   *  it *is* the portrait — while a drawn face usually sits inset on a disc of
   *  its own. Defaults to filling, which is what the small ones want. */
  faceSize?: number;
  /** A disc for the drawn face to sit on, painted only when one is drawn: a
   *  picture is the portrait, so a disc behind it would show as a rim around
   *  it rather than as ground under it. */
  ground?: string;
}>();

const photo = computed(() => props.agent.avatar?.src ?? null);
const inner = computed(() => props.faceSize ?? props.size);
</script>

<template>
  <!-- Decorative at every call site: each one puts the agent's name beside the
       face, and a picture that reads out the name again is the name twice. -->
  <span
    class="roster-face"
    :class="photo ? 'roster-face--photo' : 'roster-face--drawn'"
    :style="{
      '--roster-face-size': `${size}px`,
      '--roster-face-inner': `${inner}px`,
      '--roster-face-ground': photo ? 'transparent' : (ground ?? 'transparent'),
    }"
    aria-hidden="true"
  >
    <img v-if="photo" class="roster-face__photo" :src="photo" alt="" draggable="false" />
    <span v-else class="roster-face__drawn" v-html="agent.svg" />
    <!-- Anything that rides the face's corner — a bot mark, most often. The
         disc is the only thing here that can position it. -->
    <slot name="mark" />
  </span>
</template>

<style scoped>
.roster-face {
  position: relative;
  display: grid;
  place-items: center;
  flex: none;
  width: var(--roster-face-size);
  height: var(--roster-face-size);
  border-radius: 50%;
  background-color: var(--roster-face-ground);
}
/* Cropped rather than fitted — a face letterboxed into a circle reads as a
   picture of a picture. */
.roster-face__photo {
  display: block;
  width: 100%;
  height: 100%;
  border-radius: 50%;
  object-fit: cover;
  user-select: none;
}
.roster-face__drawn {
  display: block;
  width: var(--roster-face-inner);
  height: var(--roster-face-inner);
  border-radius: 50%;
}
.roster-face__drawn :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
}
</style>
