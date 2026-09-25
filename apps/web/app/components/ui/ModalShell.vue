<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { EXIT_MS } from "~/composables/useModalExit";

// The frame every modal sits in: the overlay that places the card, the scrim
// under it, and the card's entrance and exit. A modal brings only its card, and
// binds the slot's `card` onto it (`v-bind="card"`), so the card stays the
// modal's own element with its own class and scoped styles; this owns only
// how it moves. Placement (`items-end justify-end p-6`, z-index) is the
// caller's class on the overlay.
//
// All of it is CSS keyframes rather than a JS spring: it runs on the compositor
// and keeps going while the card's content mounts on the same frames. Both the
// card's exit and the scrim's run for EXIT_MS, the window useModalExit waits
// before handing control back, so a modal never unmounts mid-exit.
//
// The card is held invisible until `shown` first rises. Modals mount with it
// false and raise it a tick later, and some wait for their content to measure
// first; a card that played its entrance on mount would rise in blank.

const props = withDefaults(
  defineProps<{
    shown: boolean;
    /**
     * "dismiss": a click on the scrim asks to close. "inert": the scrim blocks
     * the page but can't dismiss — the turn is waiting on an answer. "none": no
     * scrim and no overlay, for a card that pops over the page in its flow.
     */
    scrim?: "dismiss" | "inert" | "none";
    /** Cover the nearest positioned ancestor (a pane) instead of the window. */
    contained?: boolean;
    /** "below" rises into place; "above" drops in, for cards anchored high. */
    from?: "below" | "above";
  }>(),
  { scrim: "dismiss", contained: false, from: "below" },
);

const emit = defineEmits<{ dismiss: [] }>();

const seen = ref(props.shown);
watch(
  () => props.shown,
  (v) => {
    if (v) seen.value = true;
  },
);

// A false before the first true is the entrance still to come, not an exit.
const phase = computed(() => {
  if (!seen.value) return "is-pending";
  return props.shown ? "is-in" : "is-out";
});
const card = computed(() => ({
  class: ["modal-card-motion", `modal-card-motion--from-${props.from}`, phase.value],
}));
const exitVar = { "--modal-exit": `${EXIT_MS}ms` };

function onScrim(): void {
  if (props.scrim === "dismiss") emit("dismiss");
}
</script>

<template>
  <div v-if="scrim === 'none'" :style="exitVar">
    <slot :card="card" />
  </div>
  <div
    v-else
    :class="contained ? 'absolute' : 'fixed'"
    class="inset-0 flex overflow-hidden"
    :style="exitVar"
  >
    <div class="modal-scrim" :class="{ 'modal-scrim--out': phase === 'is-out' }" @click="onScrim" />
    <slot :card="card" />
  </div>
</template>

<style>
/* Unscoped on purpose: the card element belongs to the modal's template, not
   this one, so a scoped rule here couldn't reach it. */

/* A soft dim over whatever is underneath. Opacity only — no backdrop blur,
   which costs a full-window repaint every frame it animates. */
.modal-scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ground) 62%, transparent);
  animation: modal-scrim-in 240ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.modal-scrim--out {
  animation: modal-scrim-out var(--modal-exit) cubic-bezier(0.4, 0, 1, 1) forwards;
}
@keyframes modal-scrim-in {
  from {
    opacity: 0;
  }
}
@keyframes modal-scrim-out {
  to {
    opacity: 0;
  }
}

/* The card rises (or drops) a few pixels into place with a small overshoot,
   and leaves on an ease-in so it gets out of the way. Transform and opacity
   only. It paints over the scrim by coming after it; the card positions itself. */
.modal-card-motion--from-below {
  --modal-card-y: 12px;
  --modal-card-scale: 0.96;
}
.modal-card-motion--from-above {
  --modal-card-y: -10px;
  --modal-card-scale: 0.97;
}
.modal-card-motion.is-pending {
  opacity: 0;
}
.modal-card-motion.is-in {
  animation: modal-card-in 420ms cubic-bezier(0.34, 1.3, 0.64, 1) backwards;
}
.modal-card-motion.is-out {
  animation: modal-card-out var(--modal-exit) cubic-bezier(0.4, 0, 1, 1) forwards;
  pointer-events: none;
}
@keyframes modal-card-in {
  from {
    opacity: 0;
    transform: translateY(var(--modal-card-y)) scale(var(--modal-card-scale));
  }
  /* Opaque well before the move ends, so the card never reads as a ghost
     sliding into place. */
  45% {
    opacity: 1;
  }
}
@keyframes modal-card-out {
  to {
    opacity: 0;
    transform: translateY(var(--modal-card-y)) scale(var(--modal-card-scale));
  }
}

@media (prefers-reduced-motion: reduce) {
  .modal-scrim,
  .modal-card-motion {
    animation-duration: 1ms !important;
  }
}
</style>
