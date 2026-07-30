<script setup lang="ts">
import { onKeyStroke } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowRight01Icon,
  BubbleChatAddIcon,
  ComputerTerminal01Icon,
} from "@hugeicons/core-free-icons";

const props = defineProps<{
  open: boolean;
  /** Viewport anchor — left edge of the seam trigger, vertically centred. */
  x: number;
  y: number;
}>();

const emit = defineEmits<{
  close: [];
  pick: [kind: "thread" | "terminal"];
}>();

onKeyStroke("Escape", (e) => {
  if (!props.open) return;
  e.preventDefault();
  emit("close");
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

const actions = [
  {
    kind: "thread" as const,
    label: "New thread",
    icon: BubbleChatAddIcon,
    disabled: false,
  },
  {
    kind: "terminal" as const,
    label: "Terminal",
    icon: ComputerTerminal01Icon,
    disabled: true,
  },
];

function onPick(kind: "thread" | "terminal", disabled: boolean): void {
  if (disabled) return;
  emit("pick", kind);
}
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <motion.div
        v-if="open"
        key="thread-insert-menu"
        class="insert-wrap"
        :initial="{ opacity: 0 }"
        :animate="{ opacity: 1 }"
        :exit="{ opacity: 0 }"
        :transition="{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }"
      >
        <div class="insert-layer" aria-hidden="true" @click="emit('close')" />
        <div
          class="insert-anchor"
          :style="{
            top: `${y}px`,
            left: `${x}px`,
          }"
        >
          <motion.div
            class="insert-pop"
            role="dialog"
            aria-modal="true"
            aria-label="Insert column"
            :initial="{ opacity: 0, scale: 0.94 }"
            :animate="{ opacity: 1, scale: 1 }"
            :exit="{ opacity: 0, scale: 0.96 }"
            :transition="cardSpring"
          >
            <div class="insert-card">
              <div class="insert-shell">
                <div class="insert-header">
                  <span class="insert-title">Insert</span>
                </div>
                <div class="insert-body">
                  <button
                    v-for="action in actions"
                    :key="action.kind"
                    type="button"
                    class="insert-row"
                    :class="{ 'insert-row--disabled': action.disabled }"
                    :disabled="action.disabled"
                    :title="
                      action.disabled ? `${action.label} (coming soon)` : action.label
                    "
                    @click="onPick(action.kind, action.disabled)"
                  >
                    <span class="insert-row__lead">
                      <HugeiconsIcon
                        :icon="action.icon"
                        :size="14"
                        :stroke-width="1.9"
                        aria-hidden="true"
                      />
                    </span>
                    <span class="insert-label">{{ action.label }}</span>
                    <span class="insert-row__trail">
                      <HugeiconsIcon
                        :icon="ArrowRight01Icon"
                        :size="11"
                        :stroke-width="2.2"
                        aria-hidden="true"
                      />
                    </span>
                  </button>
                </div>
              </div>
            </div>
          </motion.div>
        </div>
      </motion.div>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.insert-wrap {
  position: fixed;
  inset: 0;
  z-index: 44;
  pointer-events: none;
}

.insert-layer {
  position: absolute;
  inset: 0;
  pointer-events: auto;
  background: transparent;
}

.insert-anchor {
  position: fixed;
  z-index: 45;
  pointer-events: none;
  transform: translate(calc(-100% - 8px), -50%);
}

.insert-pop {
  width: min(11.5rem, calc(100vw - 2rem));
  pointer-events: auto;
  transform-origin: right center;
  will-change: transform, opacity;
}

.insert-card {
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
}

.insert-shell {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
  padding: 0 0 0.5rem 0.75rem;
}

.insert-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: calc(100% + 0.75rem);
  margin: 0 0 0 -0.75rem;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
  position: relative;
}

.insert-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.insert-header::before,
.insert-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.insert-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.insert-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.insert-body {
  display: flex;
  flex-direction: column;
  gap: 1px;
  padding: 0.35rem 0.75rem 0.35rem 0;
}

.insert-row {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  width: 100%;
  padding: 0.42rem 0.5rem;
  border: 0;
  border-radius: 10px;
  cursor: pointer;
  text-align: left;
  color: var(--ink-soft);
  background: transparent;
  transition:
    background-color 0.18s ease,
    color 0.18s ease,
    opacity 0.18s ease;
}
.insert-row:not(:disabled):hover {
  background: var(--hover);
  color: var(--ink);
}
.insert-row--disabled {
  cursor: not-allowed;
  opacity: 0.38;
}

.insert-row__lead,
.insert-row__trail {
  display: inline-flex;
  align-items: center;
  gap: 0.2rem;
  flex: none;
  color: var(--muted);
}
.insert-row__trail {
  margin-left: auto;
}

.insert-label {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.35;
}

@media (prefers-reduced-motion: reduce) {
  .insert-pop {
    will-change: auto;
  }
}
</style>
