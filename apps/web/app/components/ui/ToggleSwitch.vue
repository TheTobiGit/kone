<script setup lang="ts">
import { ref } from "vue";

// A small on/off switch: a recessed track that fills with the accent when on.
// The launcher's one interactive colour. `v-model` carries the boolean; the
// host can grab focus via the exposed `focus()` (used to land focus on open).
const props = defineProps<{ modelValue: boolean; ariaLabel?: string }>();
const emit = defineEmits<{ "update:modelValue": [boolean] }>();

const el = ref<HTMLButtonElement | null>(null);
defineExpose({ focus: () => el.value?.focus() });

// Each flip plays the launcher's discrete "toggle" cue — a real user gesture,
// so it never trips the browser autoplay gate.
const { cue } = useSound();

function toggle() {
  cue("toggle");
  emit("update:modelValue", !props.modelValue);
}
</script>

<template>
  <button
    ref="el"
    type="button"
    role="switch"
    :aria-checked="modelValue"
    :aria-label="ariaLabel"
    class="switch"
    :class="{ 'is-on': modelValue }"
    @click="toggle"
  >
    <span class="knob" />
  </button>
</template>

<style scoped>
.switch {
  position: relative;
  flex: none;
  width: 40px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 13%, transparent);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.12);
  cursor: pointer;
  transition: background 0.24s ease;
}
.switch.is-on {
  background: var(--accent);
  box-shadow: inset 0 1px 2px rgb(0 0 0 / 0.14);
}
.knob {
  position: absolute;
  top: 3px;
  left: 3px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: #fff;
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.3);
  transition: transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.switch.is-on .knob {
  transform: translateX(16px);
}
.switch:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--accent) 60%, transparent);
  outline-offset: 2px;
}
</style>
