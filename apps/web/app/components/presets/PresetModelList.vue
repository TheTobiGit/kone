<script setup lang="ts">
import { computed } from "vue";
import ModelPinPicker from "~/components/model/ModelPinPicker.vue";
import type { AgentModelRef } from "~/types/desktop";

// Model preference for a preset sub-agent: inherit (null) or an assigned chain.
// Null is a real answer: no preference, run where the caller runs.

const props = defineProps<{
  model: AgentModelRef | null;
  fallbacks?: AgentModelRef[] | null;
}>();
const emit = defineEmits<{
  "update:model": [AgentModelRef | null];
  "update:fallbacks": [AgentModelRef[]];
}>();

const state = computed(() => {
  if (!props.model) return "Inherits the caller";
  const tail = (props.fallbacks ?? []).map((f) => f.label ?? f.model);
  const head = props.model.label ?? props.model.model;
  return tail.length > 0 ? `${head} → ${tail.join(" → ")}` : `Pinned to ${head}`;
});
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
      @update:model="emit('update:model', $event)"
      @update:fallbacks="emit('update:fallbacks', $event)"
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
