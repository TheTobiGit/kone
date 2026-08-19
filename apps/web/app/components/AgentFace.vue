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
  <span
    v-if="identity.svg"
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
.agent-face :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  overflow: visible;
  shape-rendering: geometricPrecision;
}
</style>
