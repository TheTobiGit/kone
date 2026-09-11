<script setup lang="ts">
import ModelPinPicker from "~/components/model/ModelPinPicker.vue";
import type { AgentModelRef } from "~/types/desktop";

// Model preference for a preset sub-agent: inherit (null) or an assigned chain.
// Null is a real answer: no preference, run where the caller runs.

export type PresetModelChain = {
  model: AgentModelRef | null;
  fallbacks: AgentModelRef[];
};

const props = defineProps<{
  model: AgentModelRef | null;
  fallbacks?: AgentModelRef[] | null;
}>();
const emit = defineEmits<{
  "update:chain": [PresetModelChain];
}>();

// The picker emits the primary and the tail as two events in the same tick —
// a promote restates the model beside its tail rewrite, an append restates the
// model beside the longer tail. Coalesce both into one chain event on the
// microtask, seeded from the current props, so a paired write never observes
// the primary without its tail (or vice versa) and no caller keeps its own
// queue to stitch the pair back together. Stays here rather than in the picker,
// which must keep emitting both events for its separate v-model:model /
// v-model:fallbacks consumers.
let pendingChain: PresetModelChain | null = null;
let chainFlushQueued = false;

function queueChain(patch: Partial<PresetModelChain>): void {
  pendingChain = {
    model: props.model,
    fallbacks: props.fallbacks ?? [],
    ...pendingChain,
    ...patch,
  };
  if (chainFlushQueued) return;
  chainFlushQueued = true;
  queueMicrotask(() => {
    const next = pendingChain;
    pendingChain = null;
    chainFlushQueued = false;
    if (!next) return;
    emit("update:chain", { model: next.model, fallbacks: [...next.fallbacks] });
  });
}
</script>

<template>
  <div class="pml">
    <ModelPinPicker
      :model="props.model"
      :fallbacks="props.fallbacks ?? []"
      @update:model="queueChain({ model: $event })"
      @update:fallbacks="queueChain({ fallbacks: $event })"
    />
  </div>
</template>

<style scoped>
.pml {
  display: flex;
  flex-direction: column;
}
</style>
