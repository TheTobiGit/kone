<script setup lang="ts">
import { computed, ref } from "vue";
import type { SpawnedThread } from "~/types/desktop";

// The agents working because of this thread, and the one way to stop all of
// it at once.
//
// An ordinary stop settles a thread's hand-offs the considerate way: its
// workers stop with it, and it decides — in a short turn of its own — whether
// each delegate and contractor carries on. "Stop everything" is the other
// answer, for when the user means all of it: the thread and every thread
// working under it stop now, and nobody is asked.

const props = defineProps<{
  threadId: string | null | undefined;
  spawned: SpawnedThread[];
}>();

const working = computed(() =>
  props.spawned.filter((child) => !child.terminal && (child.handOff === "delegation" || child.handOff === "contract")),
);

const stopping = ref(false);

async function stopEverything(): Promise<void> {
  const id = props.threadId;
  if (!id || stopping.value) return;
  stopping.value = true;
  try {
    await window.koneDesktop?.agent?.stopChain?.(id);
  } finally {
    stopping.value = false;
  }
}
</script>

<template>
  <div v-if="working.length" class="chain-bar" role="status">
    <span class="chain-bar__dot" aria-hidden="true" />
    <span class="chain-bar__text">
      {{ working.length === 1 ? "1 agent is" : `${working.length} agents are` }} working for this thread:
      <span class="chain-bar__names">{{ working.map((w) => w.agentName ?? w.title).join(", ") }}</span>
    </span>
    <button type="button" class="chain-bar__stop" :disabled="stopping" @click="stopEverything">
      Stop everything
    </button>
  </div>
</template>

<style scoped>
.chain-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin: 0 auto 6px;
  padding: 6px 8px 6px 12px;
  max-width: 100%;
  border: 1px solid color-mix(in oklab, var(--ink) 9%, transparent);
  border-radius: 999px;
  background: color-mix(in oklab, var(--ink) 2.5%, var(--ground));
  font-size: 12px;
  line-height: 1.3;
  color: color-mix(in oklab, var(--ink) 60%, transparent);
}
.chain-bar__dot {
  flex: none;
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: var(--accent, #7a8b6b);
  animation: chain-pulse 1.6s ease-in-out infinite;
}
.chain-bar__text {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.chain-bar__names {
  font-weight: 600;
  color: color-mix(in oklab, var(--ink) 80%, transparent);
}
.chain-bar__stop {
  flex: none;
  padding: 3px 10px;
  border: 1px solid color-mix(in oklab, var(--diff-del, #b4543c) 40%, transparent);
  border-radius: 999px;
  background: transparent;
  color: color-mix(in oklab, var(--diff-del, #b4543c) 85%, var(--ink));
  font: inherit;
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
}
.chain-bar__stop:hover {
  background: color-mix(in oklab, var(--diff-del, #b4543c) 8%, transparent);
}
@keyframes chain-pulse {
  50% {
    opacity: 0.35;
  }
}
@media (prefers-reduced-motion: reduce) {
  .chain-bar__dot {
    animation: none;
  }
}
</style>
