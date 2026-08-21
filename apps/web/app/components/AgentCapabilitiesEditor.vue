<script setup lang="ts">
import { computed } from "vue";
import { SquareLock01Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";
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

const modelState = computed(() => {
  const on = props.model;
  if (!on) return { pinned: false, text: "Any model" };
  return { pinned: true, text: `Pinned to ${on.label ?? on.model}` };
});
</script>

<template>
  <div class="cap">
    <section class="cap__block">
      <div class="cap__head">
        <span class="cap__label">Model</span>
        <span class="cap__state" :class="{ 'cap__state--pin': modelState.pinned }">
          <HugeiconsIcon v-if="modelState.pinned" :icon="SquareLock01Icon" :size="12" :stroke-width="1.9" />
          {{ modelState.text }}
        </span>
      </div>
      <p class="cap__hint">The one model this agent runs on. Leave it off to let each thread pick per turn; choose one to pin the agent there.</p>

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
.cap__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.cap__label {
  font-size: 13px;
  color: var(--ink);
}
.cap__state {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-size: 11.5px;
  color: var(--muted);
  text-align: right;
}
.cap__state--pin {
  color: var(--accent);
}
.cap__hint {
  margin: 0 0 4px;
  font-size: 12px;
  line-height: 1.5;
  color: var(--muted);
  max-width: 60ch;
  text-wrap: pretty;
}
</style>
