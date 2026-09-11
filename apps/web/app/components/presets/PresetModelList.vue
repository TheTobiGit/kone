<script setup lang="ts">
import { computed } from "vue";
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

const state = computed(() => {
  if (!props.model) return "Inherits the caller";
  const tail = (props.fallbacks ?? []).map((f) => f.label ?? f.model);
  const head = props.model.label ?? props.model.model;
  return tail.length > 0 ? `${head} → ${tail.join(" → ")}` : `Pinned to ${head}`;
});

// The picker emits the primary and the tail as two events in the same tick —
// a promote restates the model beside its tail rewrite, an append restates the
// model beside the longer tail. Coalesce both into one chain event on the
// microtask, seeded from the current props, so a paired write never observes
// the primary without its tail (or vice versa) and no caller keeps its own
// queue to stitch the pair back together.
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
    <div class="pml__head">
      <span class="pml__label">Model</span>
      <span class="pml__state">{{ state }}</span>
    </div>
    <p class="pml__hint">
      The model a spawn from this preset runs on, then each fallback in order if
      that one is rate-limited or spent. Leave it off to run wherever the caller runs.
    </p>

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
  gap: 9px;
}
.pml__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.pml__label {
  font-size: 13px;
  color: var(--ink);
}
.pml__state {
  font-size: 11.5px;
  color: var(--muted);
}
.pml__hint {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 60ch;
  text-wrap: pretty;
}
</style>
