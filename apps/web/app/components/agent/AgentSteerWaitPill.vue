<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import type { StepWait } from "~/types/desktop";
import { steerWaitLabel, steerWaitOffered } from "~/utils/steerWait";

// The user steered a turn whose provider cannot take a message mid-turn, so
// kone is holding the steer until the running tool call finishes. After 30 s
// this offers Interrupt now: the turn ends at once and the steer goes next.

const props = defineProps<{
  wait?: StepWait | null;
  agentName?: string | null;
}>();

const emit = defineEmits<{ "interrupt-now": [] }>();

const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;

// Ticks only while a wait is on screen.
watch(
  () => props.wait,
  (wait) => {
    now.value = Date.now();
    if (wait && !timer) timer = setInterval(() => (now.value = Date.now()), 1_000);
    if (!wait && timer) {
      clearInterval(timer);
      timer = null;
    }
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  if (timer) clearInterval(timer);
});

const shown = computed(() => steerWaitOffered(props.wait, now.value));
const label = computed(() => (props.wait ? steerWaitLabel(props.wait, props.agentName) : ""));
</script>

<template>
  <Transition name="steer-wait">
    <div v-if="shown" class="steer-wait" role="status">
      <span class="steer-wait__text" :title="`${label}. Your message goes in right after.`">{{ label }}</span>
      <button
        type="button"
        class="steer-wait__action"
        title="End the turn now; your message goes next"
        @click="emit('interrupt-now')"
      >
        Interrupt now
      </button>
    </div>
  </Transition>
</template>

<style scoped>
.steer-wait {
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 26px);
  margin-bottom: 6px;
  padding: 4px 4px 4px 12px;
  border-radius: 999px;
  background: var(--sunken);
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 11.5px;
  line-height: 14px;
  pointer-events: auto;
}
.steer-wait__text {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.steer-wait__action {
  flex: none;
  padding: 3px 9px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
  font: inherit;
  font-weight: 600;
  cursor: pointer;
  transition: background-color 0.12s ease;
}
.steer-wait__action:hover {
  background: color-mix(in srgb, var(--ink) 14%, transparent);
}
.steer-wait-enter-active,
.steer-wait-leave-active {
  transition: opacity 0.15s ease;
}
.steer-wait-enter-from,
.steer-wait-leave-to {
  opacity: 0;
}
</style>
