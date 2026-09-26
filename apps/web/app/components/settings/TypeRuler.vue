<script setup lang="ts">
import { computed, ref } from "vue";

// A ruler for a stepped typographic value: one tick per step, the set value
// standing tall in the accent, the default marked with a notch beneath its
// tick. Drag along it, click a tick, or arrow through it — each detent passed
// ticks once, so the value is felt as much as read. Ticks near the pointer rise
// a little, like a scale being looked at closely.

const props = withDefaults(
  defineProps<{
    title: string;
    modelValue: number;
    min: number;
    max: number;
    step?: number;
    /** The shipped value, notched on the scale so the way back is visible. */
    defaultValue: number;
    format: (value: number) => string;
    /** Whether the drawer is open: the slider only takes focus when it is. */
    open: boolean;
    /** Hold a drag's value until release. For a value that rescales the
     *  ruler itself: committed mid-drag, the ticks would slide out from under
     *  the pointer on every step. */
    settle?: boolean;
    /** A keyboard shortcut that moves the same value, shown beside the title. */
    keys?: string;
  }>(),
  { step: 1, settle: false },
);

const emit = defineEmits<{ "update:modelValue": [value: number] }>();

const { cue } = useSound();

const count = computed(() => Math.round((props.max - props.min) / props.step) + 1);
const valueAt = (i: number) => Math.round((props.min + i * props.step) * 100) / 100;
const indexOf = (v: number) =>
  Math.min(count.value - 1, Math.max(0, Math.round((v - props.min) / props.step)));

// A settling drag's value, shown on the ruler but not yet handed up.
const draft = ref<number | null>(null);
const shown = computed(() => draft.value ?? props.modelValue);
const at = computed(() => indexOf(shown.value));
const defaultAt = computed(() => indexOf(props.defaultValue));

function set(i: number, held = false) {
  const next = Math.min(count.value - 1, Math.max(0, i));
  if (next === at.value) return;
  if (held) draft.value = valueAt(next);
  else emit("update:modelValue", valueAt(next));
  cue("select");
}

// ── pointer ──────────────────────────────────────────────────────────────────
const track = ref<HTMLElement>();
const hover = ref<number | null>(null);
let dragging = false;

function indexFromX(clientX: number): number {
  const el = track.value;
  if (!el) return at.value;
  // Measure the ticks' run, not the padded track, so the end ticks sit at the
  // ends of the scale.
  const r = el.getBoundingClientRect();
  const pad = parseFloat(getComputedStyle(el).paddingLeft) || 0;
  const t = (clientX - r.left - pad) / (r.width - pad * 2);
  return Math.round(Math.min(1, Math.max(0, t)) * (count.value - 1));
}

function onDown(e: PointerEvent) {
  if (e.button !== 0) return;
  dragging = true;
  track.value?.setPointerCapture(e.pointerId);
  set(indexFromX(e.clientX), props.settle);
}
function onMove(e: PointerEvent) {
  const i = indexFromX(e.clientX);
  if (e.pointerType === "mouse") hover.value = i;
  if (dragging) set(i, props.settle);
}
function onUp(e: PointerEvent) {
  dragging = false;
  track.value?.releasePointerCapture(e.pointerId);
  if (draft.value !== null) {
    if (draft.value !== props.modelValue) emit("update:modelValue", draft.value);
    draft.value = null;
    // The page has just rescaled, so wherever the pointer hovered is stale.
    hover.value = null;
  }
}

/** How far a tick rises: the hovered one most, its neighbours less. */
function lift(i: number): number {
  if (hover.value === null) return 0;
  const d = Math.abs(i - hover.value);
  return d > 2 ? 0 : [1, 0.55, 0.2][d]!;
}

// ── keys ─────────────────────────────────────────────────────────────────────
function onKey(e: KeyboardEvent) {
  const big = Math.max(2, Math.round(count.value / 6));
  const moves: Record<string, number> = {
    ArrowLeft: at.value - 1,
    ArrowDown: at.value - 1,
    ArrowRight: at.value + 1,
    ArrowUp: at.value + 1,
    PageDown: at.value - big,
    PageUp: at.value + big,
    Home: 0,
    End: count.value - 1,
  };
  const next = moves[e.key];
  if (next === undefined) return;
  e.preventDefault();
  set(next);
}
</script>

<template>
  <div class="tr">
    <div class="tr__head">
      <span class="tr__title">
        {{ title }}
        <kbd v-if="keys" class="tr__keys">{{ keys }}</kbd>
      </span>
      <span class="tr__value" aria-hidden="true">{{ format(shown) }}</span>
    </div>
    <div
      ref="track"
      class="tr__track"
      role="slider"
      :aria-label="title"
      :aria-valuemin="min"
      :aria-valuemax="max"
      :aria-valuenow="shown"
      :aria-valuetext="format(shown)"
      :tabindex="open ? 0 : -1"
      :style="{ '--n': count }"
      @pointerdown="onDown"
      @pointermove="onMove"
      @pointerup="onUp"
      @pointercancel="onUp"
      @pointerleave="hover = null"
      @keydown="onKey"
    >
      <span
        v-for="i in count"
        :key="i"
        class="tr__tick"
        :class="{
          'is-on': i - 1 === at,
          'is-past': i - 1 < at,
          'is-default': i - 1 === defaultAt,
        }"
        :style="{ '--lift': lift(i - 1) }"
      />
    </div>
  </div>
</template>

<style scoped>
.tr {
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.tr__head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 12px;
}
.tr__title {
  font-size: 13.5px;
  line-height: 1.3;
  color: var(--ink);
}
.tr__keys {
  margin-left: 6px;
  font-family: inherit;
  font-size: 11px;
  color: var(--muted);
}
.tr__value {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  color: var(--ink-soft);
}

/* The ticks share the track evenly; the track is taller than they are so a
   press just above or below still lands on the scale. */
.tr__track {
  position: relative;
  display: flex;
  align-items: flex-end;
  justify-content: space-between;
  height: 30px;
  padding: 0 10px 8px;
  border-radius: 8px;
  cursor: ew-resize;
  touch-action: none;
  outline: none;
}
/* Focus as a quiet well rather than a ring: a ring hugging the track crowds
   the end ticks into its corners. */
.tr__track {
  transition: background-color 160ms ease;
}
.tr__track:focus-visible {
  background-color: color-mix(in srgb, var(--ink) 5%, transparent);
}
.tr:has(.tr__track:focus-visible) .tr__value {
  color: var(--ink);
}
.tr__tick {
  position: relative;
  flex: none;
  width: 1.5px;
  height: calc(9px + var(--lift) * 7px);
  border-radius: 1px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    height 260ms cubic-bezier(0.34, 1.56, 0.64, 1),
    background-color 180ms ease;
}
/* Ticks up to the set value read as filled, so the scale shows how far along
   it is at a glance, not only where. */
.tr__tick.is-past {
  background: color-mix(in srgb, var(--ink) 38%, transparent);
}
.tr__tick.is-on {
  width: 2.5px;
  height: 22px;
  background: var(--accent);
}
/* The default's notch: a dot under its tick, quiet enough to ignore until you
   want your way back. */
.tr__tick.is-default::after {
  content: "";
  position: absolute;
  left: 50%;
  bottom: -7px;
  width: 3px;
  height: 3px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 30%, transparent);
  transform: translateX(-50%);
}

@media (prefers-reduced-motion: reduce) {
  .tr__tick {
    transition: none;
  }
}
</style>
