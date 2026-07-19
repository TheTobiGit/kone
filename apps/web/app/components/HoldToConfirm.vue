<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";

// A press-and-hold confirm for destructive actions — the calm replacement for a
// native confirm() dialog. Press and a danger wash sweeps across; hold it full
// and `confirm` fires. Let go early and it retracts — sliding the pointer off
// mid-hold aborts too. The hold *is* the safety, so there's no modal to
// interrupt the flow. The body (icon + label) comes from the default slot; the
// `lane-discard` variant sizes it to the lane-header sweep row.

const props = withDefaults(
  defineProps<{
    variant?: "lane-discard";
    /** Hold time to confirm, ms. */
    duration?: number;
    title?: string;
    ariaLabel?: string;
  }>(),
  { variant: "lane-discard", duration: 850 },
);

const emit = defineEmits<{ confirm: [] }>();
const { cue } = useSound();

const progress = ref(0); // 0 → 1, drives the danger wash
const holding = ref(false);
let raf = 0;
let startTs = 0;
let keyHeld = false;

function tick(now: number) {
  if (!startTs) startTs = now;
  const t = Math.min(1, (now - startTs) / props.duration);
  progress.value = t;
  if (t >= 1) {
    finish();
    return;
  }
  raf = requestAnimationFrame(tick);
}

function begin() {
  if (holding.value) return;
  holding.value = true;
  startTs = 0;
  cue("toggle"); // a soft tick the instant the hold takes
  raf = requestAnimationFrame(tick);
}

// Released or slid away before the hold completed — retract (CSS eases it back).
function cancel() {
  if (!holding.value) return;
  cancelAnimationFrame(raf);
  holding.value = false;
  progress.value = 0;
}

function finish() {
  cancelAnimationFrame(raf);
  holding.value = false;
  progress.value = 0;
  emit("confirm");
}

function onPointerDown(e: PointerEvent) {
  if (e.button !== 0) return; // primary button only
  e.preventDefault(); // no text selection while holding
  begin();
}

function onKeyDown(e: KeyboardEvent) {
  if (e.key !== " " && e.key !== "Enter") return;
  e.preventDefault();
  if (e.repeat || keyHeld) return; // ignore auto-repeat; the hold is real time
  keyHeld = true;
  begin();
}
function onKeyUp(e: KeyboardEvent) {
  if (e.key !== " " && e.key !== "Enter") return;
  keyHeld = false;
  cancel();
}

onBeforeUnmount(() => cancelAnimationFrame(raf));
</script>

<template>
  <button
    type="button"
    class="hold"
    :class="[`hold--${variant}`, { 'is-holding': holding }]"
    :style="{ '--p': progress }"
    :title="title"
    :aria-label="ariaLabel"
    @pointerdown="onPointerDown"
    @pointerup="cancel"
    @pointerleave="cancel"
    @pointercancel="cancel"
    @keydown="onKeyDown"
    @keyup="onKeyUp"
    @contextmenu.prevent
  >
    <span class="hold__fill" aria-hidden="true" />
    <span class="hold__body"><slot /></span>
  </button>
</template>

<style scoped>
.hold {
  --hold-danger: #e11d48;
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  overflow: hidden;
  cursor: pointer;
  isolation: isolate;
  -webkit-user-select: none;
  user-select: none;
  touch-action: none; /* let a hold be a hold, not a scroll/gesture on touch */
  transition:
    color 0.16s ease,
    background-color 0.16s ease,
    transform 0.12s ease;
}
.hold.is-holding {
  transform: scale(0.97); /* a small press-in while the hold is taking */
}

/* The danger wash tracks `--p`; during the hold it follows rAF frame-by-frame
   (no transition), and on release it eases back to empty. */
.hold__fill {
  position: absolute;
  inset: 0;
  z-index: -1;
  transform: scaleX(var(--p, 0));
  transform-origin: left center;
  transition: transform 220ms cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
  background-color: color-mix(in srgb, var(--hold-danger) 15%, transparent);
}
.hold.is-holding .hold__fill {
  transition: none;
}
.hold__body {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}

/* ── "lane-discard" — bare muted text matching the lane sweep, red wash on hold. */
.hold--lane-discard {
  --hold-danger: var(--diff-del);
  padding: 3px 6px;
  border-radius: 7px;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  color: var(--muted);
}
.hold--lane-discard:hover,
.hold--lane-discard.is-holding {
  color: var(--hold-danger);
}

@media (prefers-reduced-motion: reduce) {
  .hold,
  .hold__fill {
    transition: none;
  }
  .hold.is-holding {
    transform: none;
  }
}
</style>
