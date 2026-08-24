<script setup lang="ts">
import { computed } from "vue";
import ModelPinPicker from "~/components/model/ModelPinPicker.vue";
import type { AgentModelRef } from "~/types/desktop";

// §3.5's model preference for a preset sub-agent: the one model a spawn from the
// preset runs on. No fallback ladder and no provider axis — a preset either
// names one model or names none. Null is a real answer: no preference, run where
// the caller runs. The provider→model drill-down lives in ModelPinPicker, shared
// with the agent-capabilities editor.

const props = defineProps<{ model: AgentModelRef | null }>();
const emit = defineEmits<{ "update:model": [AgentModelRef | null] }>();

const state = computed(() =>
  props.model ? `Pinned to ${props.model.label ?? props.model.model}` : "No preference",
);
</script>

<template>
  <div class="pml">
    <div class="pml__head">
      <span class="pml__label">Model</span>
      <span class="pml__state">{{ state }}</span>
    </div>
    <p class="pml__hint">
      The one model a spawn from this preset runs on. Leave it off to run wherever the caller runs.
    </p>

    <ModelPinPicker :model="props.model" @update:model="emit('update:model', $event)" />
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
