<script setup lang="ts">
// A thread's agent, as a face. Everything it draws comes from the seed alone —
// see `agentIdentity` — so the same thread is the same agent everywhere this is
// mounted.
import { computed } from "vue";
import { agentIdentity } from "~/utils/agentIdentity";

const props = withDefaults(
  defineProps<{
    /** The thread's durable id. Nothing renders until one exists. */
    seed?: string | null;
    /** Rendered size in px. */
    size?: number;
    /** Name the agent to assistive tech. Off where a visible name sits beside
     *  the face and would only be read out twice. */
    labelled?: boolean;
  }>(),
  { size: 26, labelled: false },
);

const identity = computed(() => agentIdentity(props.seed));
</script>

<template>
  <!-- An agent with a picture of itself is shown as itself. The drawn face is
       still there behind it and is what a guest — or an agent nobody has given a
       picture — gets, so this is one extra branch rather than a second
       component. -->
  <img
    v-if="identity.avatar"
    class="agent-face agent-face--photo"
    :style="{ '--face-size': `${size}px` }"
    :src="identity.avatar"
    :alt="labelled ? `${identity.name}, this thread's agent` : ''"
    :aria-hidden="labelled ? undefined : 'true'"
    draggable="false"
  />
  <span
    v-else-if="identity.svg"
    class="agent-face"
    :style="{ '--face-size': `${size}px` }"
    :role="labelled ? 'img' : undefined"
    :aria-label="labelled ? `${identity.name}, this thread's agent` : undefined"
    :aria-hidden="labelled ? undefined : 'true'"
    v-html="identity.svg"
  />
</template>

<style scoped>
.agent-face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--face-size);
  height: var(--face-size);
  filter: drop-shadow(0 1px 2px rgba(0, 0, 0, 0.16));
}
/* Round, to stay in the same family as every other mark an agent wears, and
   cropped rather than fitted — a face letterboxed into a circle reads as a
   picture of a picture. */
.agent-face--photo {
  border-radius: 50%;
  object-fit: cover;
  user-select: none;
}
.agent-face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  shape-rendering: geometricPrecision;
}
</style>
