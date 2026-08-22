<script setup lang="ts">
import ModelPinPicker from "~/components/ModelPinPicker.vue";
import type { AgentModelRef } from "~/types/desktop";

// The editable half of §1.2 capabilities: the one model an agent runs on. No
// model means no preference — the thread picks per turn, which is the shipped
// default — and picking one pins the agent there. The provider is implied by
// the model, so there is no separate provider axis and no fallback list: an
// agent runs on one model or on none. The provider→model drill-down itself
// lives in ModelPinPicker, shared with the preset editor.

const props = defineProps<{
  model: AgentModelRef | null;
}>();
const emit = defineEmits<{
  "update:model": [AgentModelRef | null];
}>();
</script>

<template>
  <div class="cap">
    <section class="cap__block">
      <ModelPinPicker :model="props.model" @update:model="emit('update:model', $event)" />
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
