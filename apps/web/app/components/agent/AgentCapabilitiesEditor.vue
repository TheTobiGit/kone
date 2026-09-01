<script setup lang="ts">
import ModelPinPicker from "~/components/model/ModelPinPicker.vue";
import type { AgentModelRef } from "~/types/desktop";

// The editable half of capabilities: the model an agent runs on, and the
// ordered fallbacks behind it. No model means inherit — the thread (or the
// caller, when this agent is spawned) picks. Picking one pins the agent there;
// further picks append as fallbacks for a 429 or spent quota.

const props = defineProps<{
  model: AgentModelRef | null;
  fallbacks?: AgentModelRef[] | null;
}>();
const emit = defineEmits<{
  "update:model": [AgentModelRef | null];
  "update:fallbacks": [AgentModelRef[]];
}>();
</script>

<template>
  <div class="cap">
    <section class="cap__block">
      <ModelPinPicker
        :model="props.model"
        :fallbacks="props.fallbacks ?? []"
        @update:model="emit('update:model', $event)"
        @update:fallbacks="emit('update:fallbacks', $event)"
      />
    </section>
  </div>
</template>

<style scoped>
.cap {
  display: flex;
  flex-direction: column;
  gap: 24px;
}
.cap__block {
  display: flex;
  flex-direction: column;
  gap: 9px;
}
</style>
