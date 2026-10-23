<script setup lang="ts">
// The pane's switch recipe as a control: a bare track and knob, role=switch.
defineProps<{ on: boolean; label: string }>();
defineEmits<{ toggle: [] }>();
</script>

<template>
  <button
    type="button"
    role="switch"
    class="pp__switch pp__switchbtn"
    :class="{ 'pp__switch--on': on }"
    :aria-checked="on"
    :aria-label="label"
    @click="$emit('toggle')"
  >
    <i class="pp__knob" />
  </button>
</template>

<style scoped>
.pp__switchbtn {
  cursor: pointer;
}
.pp__switchbtn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
</style>
