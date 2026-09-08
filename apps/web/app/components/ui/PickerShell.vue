<script setup lang="ts">
import { motion } from "motion-v";

// One shared picker shell: a band shell with a recessed header holding inset
// cards, split into data and actions. The project switcher and the context
// meter's popover share this family — click toggles, outside-click or Escape
// cancels (owned by the caller), hover never opens it, since a hover card
// can't host a working control.
//
// The tray body is a slot: callers lay out `<section class="picker-card">`
// blocks and `<button class="action-row">` rows inside, and the card/row
// styles below reach them. Positioning (absolute popover vs. inline card)
// stays with the caller via class fallthrough on the root.
const props = defineProps<{
  title: string;
  /** Accessible name for the dialog — defaults to the visible title. */
  dialogLabel?: string;
  /** Drives the enter animation: mount with false, flip true next frame. */
  shown: boolean;
}>();

const emit = defineEmits<{ close: [] }>();

const cardSpring = {
  type: "spring",
  stiffness: 340,
  damping: 24,
  mass: 0.85,
} as const;
</script>

<template>
  <motion.div
    class="modal-shell"
    :initial="{ opacity: 0, y: -6, scale: 0.97 }"
    :animate="{
      opacity: props.shown ? 1 : 0,
      y: props.shown ? 0 : -6,
      scale: props.shown ? 1 : 0.97,
    }"
    :transition="cardSpring"
    role="dialog"
    :aria-label="props.dialogLabel ?? props.title"
  >
    <div class="picker-inner">
      <div class="picker-header">
        <span class="picker-title">{{ props.title }}</span>
        <button type="button" class="picker-action text-muted" @click="emit('close')">
          Cancel
        </button>
      </div>

      <div class="picker-tray">
        <slot />
      </div>
    </div>
  </motion.div>
</template>

<style scoped>
.modal-shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  background: var(--band-bg);
  border-radius: 20px;
  /* Clips the header band to the rounded corners — without this its square
     top corners paint over the shell's curve. */
  overflow: hidden;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 10%, transparent),
    0 16px 36px -8px rgb(0 0 0 / 0.36);
}
.picker-inner {
  display: flex;
  flex-shrink: 0;
  flex-direction: column;
}
.picker-header {
  position: relative;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.5rem 0.8rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-title {
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}
.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover {
  opacity: 0.7;
}
.picker-tray {
  display: flex;
  flex-direction: column;
  gap: 5px;
  padding: 0 1px 1px;
}
/* Card and action-row blocks arrive through the slot, so these reach past the
   scope boundary into the caller's markup. */
.picker-tray :deep(.picker-card) {
  background: var(--panel);
  border-radius: 18px;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent),
    0 1px 2px rgb(0 0 0 / 0.05);
}
.picker-tray :deep(.action-row) {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  width: 100%;
  padding: 0.42rem 0.55rem;
  border-radius: 9px;
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink);
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.picker-tray :deep(.action-row:hover) {
  background-color: var(--hover);
}
.picker-tray :deep(.action-row:focus-visible) {
  outline: none;
  background-color: var(--hover);
}
.picker-tray :deep(.action-row:disabled) {
  cursor: default;
  color: var(--muted);
}
.picker-tray :deep(.action-row:disabled:hover) {
  background-color: transparent;
}
.picker-tray :deep(.action-row__icon) {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex: none;
  color: var(--ink-soft);
  transition: color 0.16s ease;
}
.picker-tray :deep(.action-row:hover .action-row__icon) {
  color: var(--ink);
}
.picker-tray :deep(.action-row__label) {
  flex: 1 1 auto;
  min-width: 0;
  text-align: left;
}
.picker-tray :deep(.action-row__arrow) {
  flex: none;
  opacity: 0;
  transform: translateX(-3px);
  transition: opacity 0.18s ease, transform 0.18s ease;
}
.picker-tray :deep(.action-row:hover .action-row__arrow) {
  opacity: 1;
  transform: translateX(0);
}
</style>
