<script setup lang="ts">
// One stepper row: the setting name on the left, its value with a nudge each
// side on the right. Tab order and spoken labels come in as props so the Sizes
// rows ("Decrease X size") and the Reading rows ("Decrease X") keep the exact
// phrasing they had before sharing this markup.

defineProps<{
  title: string;
  value: string;
  downDisabled: boolean;
  upDisabled: boolean;
  open: boolean;
  decreaseLabel: string;
  increaseLabel: string;
}>();

const emit = defineEmits<{
  step: [delta: 1 | -1];
}>();
</script>

<template>
  <div class="ty__row">
    <h3 class="ty__title">{{ title }}</h3>
    <div class="ty__stepper">
      <button
        type="button"
        class="ty__step"
        :disabled="downDisabled"
        :tabindex="open && !downDisabled ? 0 : -1"
        :aria-label="decreaseLabel"
        @click="emit('step', -1)"
      >
        −
      </button>
      <span class="ty__step-val">{{ value }}</span>
      <button
        type="button"
        class="ty__step"
        :disabled="upDisabled"
        :tabindex="open && !upDisabled ? 0 : -1"
        :aria-label="increaseLabel"
        @click="emit('step', 1)"
      >
        +
      </button>
    </div>
  </div>
</template>

<style scoped>
/* Setting / value row: the name on the left, what it's set to on the right. */
.ty__row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  align-items: start;
  gap: 12px 40px;
}
@media (max-width: 620px) {
  .ty__row {
    grid-template-columns: minmax(0, 1fr);
  }
}
.ty__title {
  font-size: 14px;
  line-height: 1.4;
  color: var(--ink);
}

/* Steppers: the value with a nudge each side. Tabular so it never reflows. */
.ty__stepper {
  display: flex;
  align-items: center;
  gap: 4px;
}
.ty__step {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 8px;
  font-size: 14px;
  line-height: 1;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.ty__step:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.ty__step:disabled {
  opacity: 0.3;
  cursor: default;
}
.ty__step:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.ty__step-val {
  min-width: 7ch;
  text-align: center;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}
</style>
