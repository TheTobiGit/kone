<script setup lang="ts">
// The thread strip — a project's live conversations as columns on one
// infinitely-wide, horizontally scrollable rail. Modelled on niri (the
// scrollable-tiling Wayland compositor): columns tile from the left edge once
// there's more than one, each has a fixed pixel width preset, the strip extends
// rightward as you open threads. A lone thread is centred in the panel; opening
// a second pushes it left and tiles out niri-style.
//
// Navigation, all of it niri's vocabulary:
//   · ⌘⌥← / ⌘⌥→ ....... focus the column left / right (clamped, never wraps)
//   · ⌘⌥⇧← / ⌘⌥⇧→ ..... carry the focused column along the strip
//   · ⌘⇧R ............. cycle the focused column's width preset
//   · ⌘⌥↑ / ⌘⌥↓ ....... widen / narrow the focused column one preset step
//   · ← / → ........... same as focus left/right when you aren't typing
//   · two-finger swipe . free-scroll the rail; the column nearest centre takes
//                        focus when you let go (snap-on-release)
//
// This component owns only the strip's own geometry — column order, focus, and
// closing are registry operations, so they go up to ProjectView as events. Column
// *width* is purely presentational, so it lives here.

import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
  useEventListener,
  usePreferredReducedMotion,
  useResizeObserver,
} from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ThreadSession } from "~/composables/useAgent";
import { SESSION_BRAND } from "~/types/session";

const props = defineProps<{
  /** Live sessions in strip order (left to right) — the registry's own array. */
  sessions: ThreadSession[];
  /** The focused column's stable registry key. */
  activeKey: string;
  /** Ticking clock from useAgent, so every column's "working · Xs" counts up. */
  now: number;
}>();

const emit = defineEmits<{
  /** Focus this column (a click, or the rail settling on it after a swipe). */
  focus: [key: string];
  /** Step focus this many columns along the strip. */
  shift: [delta: number];
  /** Carry the focused column this many places along the strip. */
  move: [delta: number];
  /** Close this column. */
  close: [key: string];
  /** Insert a blank thread to the right of seam `seamIndex`. */
  "insert-thread": [seamIndex: number];
}>();

const { cue } = useSound();

const rail = ref<HTMLElement | null>(null);
const railWidth = ref(0);
const reducedMotion = usePreferredReducedMotion();

// ── column widths ─────────────────────────────────────────────────────────────
// Fixed pixel rungs — unlike niri (output size is the monitor), our strip lives
// in a resizable app window, so vw presets would drift every time you drag the
// window edge. Each rung is an absolute width that holds until you step it;
// `min(px, 100%)` only kicks in when the window is narrower than the preset.
const LADDER_PX = [840, 960, 1120, 1240] as const;
const LAST_STEPPED = LADDER_PX.length - 2;
const DEFAULT_PRESET = 0; // 840px — default and narrowest rung

interface Preset {
  id: string;
  label: string;
  px: number;
  width: string;
}
const PRESETS: Preset[] = LADDER_PX.map((px) => ({
  id: `w${px}`,
  label: String(px),
  px,
  width: `min(${px}px, 100%)`,
}));

const presetByKey = ref<Record<string, number>>({});
const widthAnim = ref<Record<string, boolean>>({});
const WIDTH_ANIM_MS = 520;
const animTimers = new Map<string, ReturnType<typeof setTimeout>>();

function reducedMotionOn(): boolean {
  return reducedMotion.value === "reduce";
}
function scrollBehavior(): ScrollBehavior {
  return reducedMotionOn() ? "auto" : "smooth";
}

function presetIndexFor(key: string): number {
  return presetByKey.value[key] ?? DEFAULT_PRESET;
}
function presetFor(key: string): Preset {
  return PRESETS[presetIndexFor(key)] ?? PRESETS[DEFAULT_PRESET]!;
}
function setPreset(key: string, index: number): void {
  const next = Math.min(PRESETS.length - 1, Math.max(0, index));
  if (next === presetIndexFor(key)) return;
  presetByKey.value = { ...presetByKey.value, [key]: next };
  if (reducedMotionOn()) return;
  widthAnim.value = { ...widthAnim.value, [key]: true };
  const prev = animTimers.get(key);
  if (prev) clearTimeout(prev);
  animTimers.set(
    key,
    setTimeout(() => {
      const { [key]: _, ...rest } = widthAnim.value;
      widthAnim.value = rest;
      animTimers.delete(key);
    }, WIDTH_ANIM_MS),
  );
}

function cycleWidth(key: string): void {
  cue("press");
  const next =
    presetIndexFor(key) >= LAST_STEPPED
      ? 0
      : presetIndexFor(key) + 1 === LAST_STEPPED
        ? PRESETS.length - 1
        : presetIndexFor(key) + 1;
  setPreset(key, next);
  void nextTick(() => scrollToColumn(key));
}
function growWidth(key: string): void {
  cue("press");
  setPreset(key, presetIndexFor(key) + 1);
  void nextTick(() => scrollToColumn(key));
}
function shrinkWidth(key: string): void {
  cue("press");
  setPreset(key, presetIndexFor(key) - 1);
  void nextTick(() => scrollToColumn(key));
}

const isSolo = computed(() => props.sessions.length === 1);

/** Leading pad centres the lone thread; trailing pad lets the last column scroll
 *  to centre when there are two or more. */
const soloPadStart = computed(() => {
  if (!isSolo.value || !railWidth.value) return 0;
  const s = props.sessions[0];
  if (!s) return 0;
  const colW = Math.min(presetFor(s.key).px, railWidth.value);
  return Math.max(0, (railWidth.value - colW) / 2);
});
const railPads = computed(() => ({
  "--rail-pad-start": isSolo.value ? `${soloPadStart.value}px` : "0px",
  "--rail-pad-end": isSolo.value ? "0px" : `${railWidth.value / 2}px`,
}));

// ── the rail ──────────────────────────────────────────────────────────────────
const colEls = new Map<string, HTMLElement>();
function setCol(key: string, el: unknown): void {
  if (el instanceof HTMLElement) colEls.set(key, el);
  else colEls.delete(key);
}

/** Scroll so `key` is centred when possible — clamped so the left edge never
 *  shows empty space (niri tiles from the left). */
let programmaticAt = 0;
function scrollTargetFor(key: string): number | null {
  const r = rail.value;
  const el = colEls.get(key);
  if (!r || !el) return null;
  const ideal = el.offsetLeft + el.offsetWidth / 2 - r.clientWidth / 2;
  const max = Math.max(0, r.scrollWidth - r.clientWidth);
  return Math.max(0, Math.min(max, ideal));
}
function scrollToColumn(key: string, behavior: ScrollBehavior = scrollBehavior()): void {
  const r = rail.value;
  if (!r) return;
  if (isSolo.value) {
    r.scrollLeft = 0;
    return;
  }
  const target = scrollTargetFor(key);
  if (target === null) return;
  if (behavior !== "auto" && Math.abs(r.scrollLeft - target) < 6) return;
  programmaticAt = Date.now();
  if (behavior === "auto") r.scrollLeft = target;
  else r.scrollTo({ left: target, behavior });
}

const isResizing = ref(false);
let resizeEndTimer: ReturnType<typeof setTimeout> | null = null;
let resizeRaf = 0;
function onRailResize(): void {
  railWidth.value = rail.value?.clientWidth ?? 0;
  isResizing.value = true;
  if (resizeEndTimer) clearTimeout(resizeEndTimer);
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (props.activeKey) scrollToColumn(props.activeKey, "auto");
  });
  resizeEndTimer = setTimeout(() => {
    isResizing.value = false;
  }, 120);
}
useResizeObserver(rail, onRailResize);
onBeforeUnmount(() => {
  cancelAnimationFrame(resizeRaf);
  if (resizeEndTimer) clearTimeout(resizeEndTimer);
  if (settleTimer) clearTimeout(settleTimer);
  for (const t of animTimers.values()) clearTimeout(t);
});

/** Which column owns the viewport at a scroll position — seam-first, like niri. */
function nearestKey(scrollLeft?: number): string | null {
  const r = rail.value;
  if (!r || !props.sessions.length) return null;
  const mid = (scrollLeft ?? r.scrollLeft) + r.clientWidth / 2;
  const dir = scrollLeft === undefined ? 0 : Math.sign(scrollLeft - lastScrollLeft);

  let byCentre: string | null = null;
  let centreDist = Infinity;
  let seamOwner: string | null = null;
  let seamDist = Infinity;
  for (const s of props.sessions) {
    const el = colEls.get(s.key);
    if (!el) continue;
    const centre = el.offsetLeft + el.offsetWidth / 2;
    const dist = Math.abs(centre - mid);
    if (dist < centreDist || (dist === centreDist && dir && Math.sign(centre - mid) === dir)) {
      centreDist = dist;
      byCentre = s.key;
    }
    const seam = el.offsetLeft + el.offsetWidth;
    const sd = seam - mid;
    if (sd >= 0 && sd < seamDist) {
      seamDist = sd;
      seamOwner = s.key;
    }
  }
  return seamOwner ?? byCentre;
}

let settleTimer: ReturnType<typeof setTimeout> | null = null;
let lastScrollLeft = 0;
function onScroll(): void {
  closeJoint();
  if (isSolo.value) return;
  if (isResizing.value) return;
  if (Date.now() - programmaticAt < 480) return;
  const left = rail.value?.scrollLeft ?? 0;
  if (settleTimer) clearTimeout(settleTimer);
  settleTimer = setTimeout(() => {
    const key = nearestKey(left);
    lastScrollLeft = left;
    if (!key) return;
    if (key !== props.activeKey) emit("focus", key);
    else scrollToColumn(key);
  }, 170);
}

watch(
  () => props.activeKey,
  (key) => {
    if (key) void nextTick(() => scrollToColumn(key));
  },
);
watch(
  () => props.sessions.length,
  () => {
    if (props.activeKey) void nextTick(() => scrollToColumn(props.activeKey));
  },
);
onMounted(() => {
  railWidth.value = rail.value?.clientWidth ?? 0;
  if (props.activeKey) void nextTick(() => scrollToColumn(props.activeKey, "auto"));
});

function onColumnClick(key: string): void {
  if (key === props.activeKey) return;
  cue("press");
  emit("focus", key);
}

function onClose(key: string): void {
  cue("press");
  emit("close", key);
}

function onInsertThread(seamIndex: number): void {
  cue("press");
  emit("insert-thread", seamIndex);
}

// ── seam insert flyout ────────────────────────────────────────────────────────
const openSeam = ref<number | null>(null);
const menuAnchor = ref({ x: 0, y: 0 });

function closeJoint(): void {
  openSeam.value = null;
}

function toggleJoint(i: number, target: EventTarget | null): void {
  const el = target instanceof HTMLElement ? target : null;
  if (!el) return;
  if (openSeam.value === i) {
    closeJoint();
    cue("toggle");
    return;
  }
  const rect = el.getBoundingClientRect();
  menuAnchor.value = {
    x: rect.left,
    y: rect.top + rect.height / 2,
  };
  openSeam.value = i;
  cue("toggle");
}

function onInsertPick(kind: "thread" | "terminal"): void {
  if (kind !== "thread" || openSeam.value === null) return;
  onInsertThread(openSeam.value);
  closeJoint();
}

// ── keyboard ──────────────────────────────────────────────────────────────────
const { matchesShortcut } = useShortcuts();

function isTyping(): boolean {
  const el = document.activeElement as HTMLElement | null;
  if (!el) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (matchesShortcut("focus-thread-left", e)) {
    e.preventDefault();
    cue("press");
    return emit("shift", -1);
  }
  if (matchesShortcut("focus-thread-right", e)) {
    e.preventDefault();
    cue("press");
    return emit("shift", 1);
  }
  if (matchesShortcut("move-thread-left", e)) {
    e.preventDefault();
    cue("press");
    return emit("move", -1);
  }
  if (matchesShortcut("move-thread-right", e)) {
    e.preventDefault();
    cue("press");
    return emit("move", 1);
  }
  if (matchesShortcut("cycle-thread-width", e)) {
    e.preventDefault();
    if (props.activeKey) cycleWidth(props.activeKey);
    return;
  }
  if (matchesShortcut("grow-thread-width", e)) {
    e.preventDefault();
    if (props.activeKey) growWidth(props.activeKey);
    return;
  }
  if (matchesShortcut("shrink-thread-width", e)) {
    e.preventDefault();
    if (props.activeKey) shrinkWidth(props.activeKey);
    return;
  }
  if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey || isTyping()) return;
  if (e.key === "ArrowLeft") {
    e.preventDefault();
    cue("press");
    emit("shift", -1);
  } else if (e.key === "ArrowRight") {
    e.preventDefault();
    cue("press");
    emit("shift", 1);
  }
});

function brandOf(s: ThreadSession) {
  return SESSION_BRAND[s.provider.value] ?? "generic";
}

/** Blank slate — no transcript yet and not working. */
function isThreadEmpty(s: ThreadSession): boolean {
  return s.blocks.value.length === 0 && !s.busy.value;
}

/** A lone blank slate has nothing to dismiss — closing it would just spawn another. */
function canClose(s: ThreadSession): boolean {
  if (!isSolo.value) return true;
  return !isThreadEmpty(s);
}

/** Seam insert control trailing column `i` (or between `i` and `i+1` when not
 *  last). Hidden on empty columns except when the right neighbour has content.
 *  The last column gets a trailing joint too — so a 2nd active thread can open
 *  a 3rd without needing an existing seam to the right. */
const jointAfter = computed(() => {
  const list = props.sessions;
  return list.map((left, i) => {
    const leftOk = left.blocks.value.length > 0 || left.busy.value;
    if (list.length === 1) return leftOk;
    if (i >= list.length - 1) return leftOk;
    const right = list[i + 1];
    const rightOk = right && (right.blocks.value.length > 0 || right.busy.value);
    return leftOk || rightOk;
  });
});

watch(jointAfter, (flags) => {
  if (openSeam.value !== null && !flags[openSeam.value]) closeJoint();
});
</script>

<template>
  <div class="strip" :class="{ 'is-resizing': isResizing }">
    <nav v-if="sessions.length > 1" class="index" aria-label="Threads">
      <button
        v-for="(s, i) in sessions"
        :key="s.key"
        type="button"
        class="index__dash"
        :class="{
          'is-focused': s.key === activeKey,
          'is-live': s.busy.value && s.key !== activeKey,
        }"
        :aria-label="`Thread ${i + 1}: ${s.title.value || 'New thread'}`"
        :aria-current="s.key === activeKey"
        @click="onColumnClick(s.key)"
      />
    </nav>

    <!-- Solo: leading pad centres the thread. Multi: tile from the left, trailing
         pad lets the rightmost column scroll to centre when focused. -->
    <div
      ref="rail"
      class="rail"
      :class="{ 'is-solo': isSolo }"
      :style="railPads"
      @scroll="onScroll"
    >
      <div class="rail__pad rail__pad--start" aria-hidden="true" />

      <template v-for="(s, i) in sessions" :key="s.key">
        <section
          :ref="(el) => setCol(s.key, el)"
          class="col"
          :class="{
            'is-focused': s.key === activeKey,
            'is-width-anim': widthAnim[s.key],
          }"
          :style="{ '--col-w': presetFor(s.key).width }"
          @click="onColumnClick(s.key)"
        >
          <header class="col__head">
            <div class="col__title-wrap">
              <ProviderLogo :brand="brandOf(s)" :size="15" />
              <h2 class="col__title">{{ s.title.value || "New thread" }}</h2>
              <span v-if="s.busy.value" class="col__live" aria-label="Working" />
            </div>
            <div class="col__tools">
              <button
                type="button"
                class="col__tool col__tool--width"
                :aria-label="`Cycle width (currently ${presetFor(s.key).px}px)`"
                :title="`Width: ${presetFor(s.key).px}px`"
                @click.stop="cycleWidth(s.key)"
              >
                {{ presetFor(s.key).label }}
              </button>
              <button
                v-if="canClose(s)"
                type="button"
                class="col__tool"
                aria-label="Close thread"
                title="Close thread"
                @click.stop="onClose(s.key)"
              >
                <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div class="col__body selectable">
            <ConversationThread :blocks="s.blocks.value" :now="now" :session-error="s.error.value" />
          </div>
        </section>

        <button
          v-if="jointAfter[i]"
          type="button"
          class="col-joint"
          aria-label="Insert column"
          aria-haspopup="dialog"
          :aria-expanded="openSeam === i"
          @click.stop="toggleJoint(i, $event.currentTarget)"
        >
          <span class="col-joint__pill" aria-hidden="true" />
        </button>
      </template>

      <div class="rail__pad rail__pad--end" aria-hidden="true" />
    </div>

    <ThreadInsertMenu
      :open="openSeam !== null"
      :x="menuAnchor.x"
      :y="menuAnchor.y"
      @close="closeJoint"
      @pick="onInsertPick"
    />
  </div>
</template>

<style scoped>
.strip {
  position: relative;
  display: flex;
  min-width: 0;
  flex: 1;
  height: 100%;
}

.index {
  position: absolute;
  top: 1.7rem;
  left: 0;
  right: 0;
  z-index: 20;
  display: flex;
  justify-content: center;
  align-items: center;
  gap: 6px;
  pointer-events: none;
}
.index__dash {
  pointer-events: auto;
  cursor: pointer;
  width: 13px;
  height: 2px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 16%, transparent);
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.3s ease;
}
.index__dash:hover {
  background: color-mix(in srgb, var(--ink) 34%, transparent);
}
.index__dash.is-focused {
  width: 24px;
  background: var(--ink);
}
.index__dash.is-live {
  background: var(--accent);
  animation: dash-breathe 1.9s ease-in-out infinite;
}
@keyframes dash-breathe {
  0%,
  100% {
    opacity: 0.35;
  }
  50% {
    opacity: 1;
  }
}

.rail {
  display: flex;
  align-items: stretch;
  gap: 0;
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  overscroll-behavior-x: contain;
  scrollbar-width: none;
}
.rail.is-solo {
  overflow-x: hidden;
}
.rail::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.rail__pad {
  flex: none;
}
.rail__pad--start {
  width: var(--rail-pad-start, 0px);
  transition: width 0.5s cubic-bezier(0.22, 1, 0.36, 1);
}
.rail__pad--end {
  width: var(--rail-pad-end, 0px);
}
.strip.is-resizing .rail__pad--start {
  transition: none;
}

.col {
  display: flex;
  min-width: 0;
  flex: 0 0 var(--col-w);
  flex-direction: column;
  height: 100%;
  padding-top: 3.5rem;
  transition:
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.col.is-width-anim {
  transition:
    flex-basis 0.5s cubic-bezier(0.22, 1, 0.36, 1),
    opacity 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.45s cubic-bezier(0.22, 1, 0.36, 1),
    filter 0.45s ease;
}
.strip.is-resizing .col {
  transition: none;
}
.col:not(.is-focused) {
  cursor: pointer;
  opacity: 0.34;
  filter: saturate(0.7);
  transform: scale(0.985);
}
.col:not(.is-focused):hover {
  opacity: 0.52;
}

/* Seam trigger — fixed footprint; the insert menu floats above the rail. */
.col-joint {
  flex: none;
  align-self: center;
  z-index: 8;
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 14px;
  height: 28px;
  padding: 0;
  border: 0;
  background: transparent;
  color: inherit;
}
.col-joint__pill {
  width: 5px;
  height: 18px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--ink) 32%, transparent);
  transition:
    background-color 0.2s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.col-joint:hover .col-joint__pill,
.col-joint[aria-expanded="true"] .col-joint__pill {
  background: color-mix(in srgb, var(--ink) 48%, transparent);
  transform: scaleY(1.08);
}

.col__head {
  display: grid;
  grid-template-columns: 1fr auto;
  align-items: center;
  min-width: 0;
  padding: 0 0.4rem 0.85rem;
}
.col__title-wrap {
  grid-column: 1 / -1;
  grid-row: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 8px;
  min-width: 0;
  max-width: calc(100% - 3.25rem);
  justify-self: center;
}
.col__title-wrap :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.col__title {
  margin: 0;
  min-width: 0;
  flex: 0 1 auto;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 620;
  letter-spacing: -0.015em;
  line-height: 1.2;
  color: var(--muted);
  transition: color 0.3s ease;
}
.col.is-focused .col__title {
  color: var(--ink);
}
.col__live {
  flex: none;
  width: 5px;
  height: 5px;
  border-radius: 999px;
  background: var(--accent);
  animation: dash-breathe 1.9s ease-in-out infinite;
}

.col__tools {
  grid-column: 2;
  grid-row: 1;
  z-index: 1;
  display: flex;
  align-items: center;
  gap: 2px;
  justify-self: end;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.col:hover .col__tools,
.col__tools:focus-within {
  opacity: 1;
}
.col__tool {
  display: grid;
  place-items: center;
  cursor: pointer;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}
.col__tool:hover {
  background: var(--hover);
  color: var(--ink);
}
.col__tool--width {
  width: auto;
  min-width: 20px;
  padding-inline: 4px;
  font-family: var(--font-sans);
  font-size: 10px;
  font-weight: 650;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.col__body {
  --fade-top: 10px;
  --fade-end: 40px;

  display: flex;
  flex-direction: column;
  min-height: 0;
  flex: 1;
  overflow-x: hidden;
  overflow-y: auto;
  padding: var(--fade-end) 0.4rem 208px;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - 176px),
    transparent 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent var(--fade-top),
    #000 var(--fade-end),
    #000 calc(100% - 176px),
    transparent 100%
  );
  scrollbar-width: none;
}
.col__body::-webkit-scrollbar {
  width: 0;
  height: 0;
}

@media (prefers-reduced-motion: reduce) {
  .index__dash,
  .col,
  .col.is-width-anim,
  .col__tools,
  .col-joint__pill {
    transition: none;
  }
  .index__dash.is-live,
  .col__live {
    animation: none;
  }
}
</style>
