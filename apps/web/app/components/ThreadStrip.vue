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
import type { Pane, PaneKind } from "~/types/board";
import { PANE_KINDS, paneKindMeta } from "~/utils/paneKinds";
import { SESSION_BRAND } from "~/types/session";

const props = defineProps<{
  /** Live panes in strip order (left to right). A pane's session may be null
   *  (dormant) — every read here is null-safe. */
  panes: Pane[];
  /** The focused pane's stable id. */
  focusedId: string;
  /** Ticking clock from useAgent, so every column's "working · Xs" counts up. */
  now: number;
  /** Briefly pulse a pad column's index dash after a thread → pad append. */
  pulseKey?: string | null;
  /** Whether the board surface is the visible one. The strip stays mounted while
   *  hidden (so panes and scroll positions survive), but a hidden rail measures
   *  zero width — so re-centre once it's revealed, not while it's hidden. */
  visible?: boolean;
  /** The desktop is bare — zero panes — so there's no column to hang an insert
   *  affordance off. Show the centered "new column" chooser over the rail.
   *  Picking a kind emits `choose`; ProjectView acts on it. A lone *blank thread*
   *  is deliberately NOT this case: that column shows plainly, with its trailing
   *  seam pill offering terminal / scratchpad. */
  chooser?: boolean;
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
  "insert-column": [seamIndex: number, kind: "thread" | "terminal" | "scratchpad"];
  /** Write terminal input data */
  "terminal-write": [key: string, data: string];
  /** Resize terminal PTY */
  "terminal-resize": [key: string, cols: number, rows: number];
  /** Append assistant reply markdown to a scratchpad. */
  "to-scratchpad": [text: string, sourceKey: string];
  "scratchpad-flush": [key: string];
  /** A column's width preset index changed — persist it onto the pane entry. */
  width: [key: string, index: number];
  /** The empty-board chooser picked a kind — start the board with that pane
   *  (or, for a thread, just reveal the waiting blank column). */
  choose: [kind: "thread" | "terminal" | "scratchpad"];
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

/** The width preset a column shows: a local override from cycling it this
 *  session, else the value persisted on its pane entry (a restored board), else
 *  the default rung. */
function presetIndexFor(key: string): number {
  const local = presetByKey.value[key];
  if (local !== undefined) return local;
  const fromEntry = props.panes.find((c) => c.id === key)?.entry.width;
  return typeof fromEntry === "number" ? clampPreset(fromEntry) : DEFAULT_PRESET;
}
function clampPreset(index: number): number {
  return Math.min(PRESETS.length - 1, Math.max(0, index));
}
function presetFor(key: string): Preset {
  return PRESETS[presetIndexFor(key)] ?? PRESETS[DEFAULT_PRESET]!;
}
function setPreset(key: string, index: number): void {
  const next = clampPreset(index);
  if (next === presetIndexFor(key)) return;
  presetByKey.value = { ...presetByKey.value, [key]: next };
  // Mirror the choice onto the pane entry so it persists across restart.
  emit("width", key, next);
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

const isSolo = computed(() => props.panes.length === 1);

/** Leading pad centres the lone thread; trailing pad lets the last column scroll
 *  to centre when there are two or more. */
const soloPadStart = computed(() => {
  if (!isSolo.value || !railWidth.value) return 0;
  const s = props.panes[0];
  if (!s) return 0;
  const colW = Math.min(presetFor(s.id).px, railWidth.value);
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
  // A hidden layer measures zero width; scrolling against it would clamp the
  // rail to 0 and lose the real position. The re-centre on reveal restores it.
  if (r.clientWidth === 0) return;
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
  const width = rail.value?.clientWidth ?? 0;
  // Ignore the zero-width tick a hidden layer reports — keep the last real
  // width so the rail's padding/centre maths stay intact until it's shown again.
  if (width === 0) return;
  railWidth.value = width;
  isResizing.value = true;
  if (resizeEndTimer) clearTimeout(resizeEndTimer);
  cancelAnimationFrame(resizeRaf);
  resizeRaf = requestAnimationFrame(() => {
    if (props.focusedId) scrollToColumn(props.focusedId, "auto");
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
  if (!r || !props.panes.length) return null;
  const mid = (scrollLeft ?? r.scrollLeft) + r.clientWidth / 2;
  const dir = scrollLeft === undefined ? 0 : Math.sign(scrollLeft - lastScrollLeft);

  let byCentre: string | null = null;
  let centreDist = Infinity;
  let seamOwner: string | null = null;
  let seamDist = Infinity;
  for (const s of props.panes) {
    const el = colEls.get(s.id);
    if (!el) continue;
    const centre = el.offsetLeft + el.offsetWidth / 2;
    const dist = Math.abs(centre - mid);
    if (dist < centreDist || (dist === centreDist && dir && Math.sign(centre - mid) === dir)) {
      centreDist = dist;
      byCentre = s.id;
    }
    const seam = el.offsetLeft + el.offsetWidth;
    const sd = seam - mid;
    if (sd >= 0 && sd < seamDist) {
      seamDist = sd;
      seamOwner = s.id;
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
    if (key !== props.focusedId) emit("focus", key);
    else scrollToColumn(key);
  }, 170);
}

watch(
  () => props.focusedId,
  (key) => {
    if (key) void nextTick(() => scrollToColumn(key));
  },
);
watch(
  () => props.panes.length,
  () => {
    if (props.focusedId) void nextTick(() => scrollToColumn(props.focusedId));
  },
);
// Re-centre on reveal. While hidden the rail measured zero and skipped every
// scroll; once the board surface is shown again, re-read the width and snap the
// focused column back to centre (no animation — it was already there before the
// surface flip; this just restores what the zero-width guard held back).
watch(
  () => props.visible,
  (visible) => {
    if (!visible) return;
    void nextTick(() => {
      railWidth.value = rail.value?.clientWidth ?? railWidth.value;
      if (props.focusedId) scrollToColumn(props.focusedId, "auto");
    });
  },
);
onMounted(() => {
  railWidth.value = rail.value?.clientWidth ?? 0;
  if (props.focusedId) void nextTick(() => scrollToColumn(props.focusedId, "auto"));
});

function onColumnClick(key: string): void {
  if (key === props.focusedId) return;
  cue("press");
  emit("focus", key);
}

function onClose(key: string): void {
  cue("press");
  emit("close", key);
}

function onInsertColumn(seamIndex: number, kind: "thread" | "terminal" | "scratchpad"): void {
  cue("press");
  emit("insert-column", seamIndex, kind);
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

function onInsertPick(kind: "thread" | "terminal" | "scratchpad"): void {
  if (openSeam.value === null) return;
  onInsertColumn(openSeam.value, kind);
  closeJoint();
}

// ── keyboard ──────────────────────────────────────────────────────────────────
const { matchesShortcut, bindingFor, displayTokens } = useShortcuts();

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
    if (props.focusedId) cycleWidth(props.focusedId);
    return;
  }
  if (matchesShortcut("grow-thread-width", e)) {
    e.preventDefault();
    if (props.focusedId) growWidth(props.focusedId);
    return;
  }
  if (matchesShortcut("shrink-thread-width", e)) {
    e.preventDefault();
    if (props.focusedId) shrinkWidth(props.focusedId);
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

function brandOf(c: Pane) {
  if (c.kind !== "thread" || !c.session) return "generic";
  return SESSION_BRAND[c.session.provider.value] ?? "generic";
}

/** Is a pane of this kind already on the strip? Drives the seam menu's greying
 *  of singleton kinds (the scratchpad, today). */
function hasKind(kind: PaneKind): boolean {
  return props.panes.some((c) => c.kind === kind);
}
/** The project's single scratchpad is on the strip — the seam menu greys its row. */
const hasScratchpad = computed(() => {
  const singleton = PANE_KINDS.find((m) => m.singleton);
  return singleton ? hasKind(singleton.kind) : false;
});

function columnLabel(c: Pane): string {
  if (c.kind === "thread") return c.session?.title.value || "New thread";
  return paneKindMeta(c.kind).label;
}

// ── bare-board chooser ──────────────────────────────────────────────────────
// The same pane-kind registry the seam menu offers, laid out as a centered pick
// for a desktop with no windows at all. No singleton greying here: the chooser
// only shows on a zero-pane board, so nothing is ever already open.
const chooserActions = computed(() =>
  PANE_KINDS.map((meta) => ({
    kind: meta.kind,
    label: meta.insertLabel,
    icon: meta.icon,
    // The kind's own shortcut, resolved through any user rebind and split into
    // display chips (⌘-glyphs on mac, words elsewhere) — so the empty state
    // teaches the gesture that opens each column.
    keys: displayTokens(bindingFor(meta.shortcutId)),
  })),
);
function onChoose(kind: PaneKind): void {
  cue("press");
  emit("choose", kind);
}

/** Every column is closeable: the board is a desktop, so closing the last window
 *  leaves it bare and the chooser takes over. Nothing is respawned behind it. */
function canClose(): boolean {
  return true;
}

/** Is this pane a thread that has never been used — no turns, not running? */
function isBlankThread(p: Pane | undefined): boolean {
  if (!p || p.kind !== "thread" || !p.session) return false;
  return p.session.blocks.value.length === 0 && !p.session.busy.value;
}

/** The whole board is one untouched thread — the fresh-project boot state. The
 *  seam pill still shows beside it (that's the only way to reach a terminal or a
 *  scratchpad from here), but its menu greys "New thread": this blank column
 *  already is one. */
const loneBlankThread = computed(
  () => props.panes.length === 1 && isBlankThread(props.panes[0]),
);

/** Seam insert control trailing column `i` (or between `i` and `i+1` when not
 *  last). Hidden on empty columns except when the right neighbour has content.
 *  The last column gets a trailing joint too — so a 2nd active thread can open
 *  a 3rd without needing an existing seam to the right. */
const jointAfter = computed(() => {
  const list = props.panes;
  return list.map((left, i) => {
    const leftOk =
      left.kind !== "thread" ||
      !left.session ||
      left.session.blocks.value.length > 0 ||
      left.session.busy.value;
    // A lone column always gets its pill, blank or not: with nothing else on the
    // strip it's the only route to a second pane.
    if (list.length === 1) return true;
    if (i >= list.length - 1) return leftOk;
    const right = list[i + 1];
    const rightOk =
      right &&
      (right.kind !== "thread" ||
        !right.session ||
        right.session.blocks.value.length > 0 ||
        right.session.busy.value);
    return leftOk || rightOk;
  });
});

watch(jointAfter, (flags) => {
  if (openSeam.value !== null && !flags[openSeam.value]) closeJoint();
});
</script>

<template>
  <div class="strip" :class="{ 'is-resizing': isResizing }">
    <nav v-if="panes.length > 1 && !chooser" class="index" aria-label="Columns">
      <button
        v-for="(c, i) in panes"
        :key="c.id"
        type="button"
        class="index__dash"
        :class="[
          paneKindMeta(c.kind).dashClass,
          {
            'is-focused': c.id === focusedId,
            'is-dormant': !c.session && c.id !== focusedId,
            'is-live': c.kind === 'thread' && !!c.session && c.session.busy.value && c.id !== focusedId,
            'is-pulse': c.id === props.pulseKey,
          },
        ]"
        :aria-label="`Column ${i + 1}: ${columnLabel(c)}`"
        :aria-current="c.id === focusedId"
        @click="onColumnClick(c.id)"
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

      <template v-for="(c, i) in panes" :key="c.id">
        <section
          :ref="(el) => setCol(c.id, el)"
          class="col"
          :data-column-key="c.id"
          :class="{
            'is-focused': c.id === focusedId,
            'is-width-anim': widthAnim[c.id],
          }"
          :style="{ '--col-w': presetFor(c.id).width }"
          @click="onColumnClick(c.id)"
        >
          <header class="col__head">
            <div class="col__title-wrap">
              <template v-if="c.kind === 'thread' && c.session">
                <ProviderLogo :brand="brandOf(c)" :size="15" />
                <h2 class="col__title">{{ c.session.title.value || "New thread" }}</h2>
                <span v-if="c.session.busy.value" class="col__live" aria-label="Working" />
              </template>
              <template v-else>
                <HugeiconsIcon :icon="paneKindMeta(c.kind).icon" :size="15" :stroke-width="2" class="text-muted" />
                <h2 class="col__title">{{ columnLabel(c) }}</h2>
              </template>
            </div>
            <div class="col__tools">
              <button
                type="button"
                class="col__tool col__tool--width"
                :aria-label="`Cycle width (currently ${presetFor(c.id).px}px)`"
                :title="`Width: ${presetFor(c.id).px}px`"
                @click.stop="cycleWidth(c.id)"
              >
                {{ presetFor(c.id).label }}
              </button>
              <button
                v-if="canClose()"
                type="button"
                class="col__tool"
                aria-label="Close column"
                title="Close column"
                @click.stop="onClose(c.id)"
              >
                <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2" aria-hidden="true" />
              </button>
            </div>
          </header>

          <div
            class="col__body selectable"
            :class="paneKindMeta(c.kind).bodyClass"
            :data-column-type="c.kind"
          >
            <template v-if="c.kind === 'thread' && c.session">
              <ConversationThread
                :blocks="c.session.blocks.value"
                :now="now"
                :session-error="c.session.error.value"
                :source-key="c.id"
                @to-scratchpad="(text) => emit('to-scratchpad', text, c.id)"
              />
            </template>
            <template v-else-if="c.kind === 'terminal' && c.session">
              <TerminalPane
                :session="c.session"
                @write="(data) => emit('terminal-write', c.id, data)"
                @resize="(cols, rows) => emit('terminal-resize', c.id, cols, rows)"
              />
            </template>
            <template v-else-if="c.kind === 'scratchpad' && c.session">
              <ScratchpadPane
                :session="c.session"
                @flush="emit('scratchpad-flush', c.id)"
              />
            </template>
            <!-- Dormant: the pane is restored but nothing has attached yet. It
                 attaches on focus, so this is what an unfocused restored pane
                 shows — a single muted line, no card / border / button / spinner.
                 A dormant scratchpad shows nothing (its empty-state idiom is an
                 empty page); a thread's "Opening…" is transient (focus attaches
                 immediately); a terminal invites the click that starts its PTY. -->
            <template v-else-if="c.kind === 'terminal'">
              <p class="col__dormant">Click to start a shell.</p>
            </template>
            <template v-else-if="c.kind === 'thread'">
              <p class="col__dormant">Opening…</p>
            </template>
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

    <!-- Bare desktop — every window closed, zero panes. Offer the same pick the
         seam menu gives (thread / terminal / scratchpad), centered. The rail
         stays mounted behind this so it keeps measuring. -->
    <div v-if="chooser" class="chooser" role="dialog" aria-label="Start a column">
      <div class="chooser__panel">
        <div class="chooser__actions">
          <button
            v-for="action in chooserActions"
            :key="action.kind"
            type="button"
            class="chooser__row"
            @click="onChoose(action.kind)"
          >
            <span class="chooser__row-lead">
              <HugeiconsIcon :icon="action.icon" :size="16" :stroke-width="1.9" aria-hidden="true" />
            </span>
            <span class="chooser__row-label">{{ action.label }}</span>
            <span v-if="action.keys.length" class="chooser__keys" aria-hidden="true">
              <kbd v-for="(k, ki) in action.keys" :key="ki" class="chooser__key">{{ k }}</kbd>
            </span>
          </button>
        </div>
      </div>
    </div>

    <ThreadInsertMenu
      :open="openSeam !== null"
      :x="menuAnchor.x"
      :y="menuAnchor.y"
      :scratchpad-open="hasScratchpad"
      :blank-thread-open="loneBlankThread"
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
.index__dash.is-pad {
  width: 10px;
  height: 2px;
}
/* A dormant pane (restored, not yet attached) reads even quieter than a resting
   dash — present, but clearly "asleep". */
.index__dash.is-dormant {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.index__dash.is-dormant:hover {
  background: color-mix(in srgb, var(--ink) 22%, transparent);
}
.index__dash.is-pulse {
  animation: dash-pulse 0.7s cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes dash-pulse {
  0%,
  100% {
    background: color-mix(in srgb, var(--ink) 16%, transparent);
  }
  40% {
    background: var(--accent);
    width: 18px;
  }
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

/* Empty-board chooser — an opaque layer over the rail, its pick stack centred.
   Borderless and soft, in keeping with the rest of the board (no card, no
   divider, no heavy shadow). */
.chooser {
  position: absolute;
  inset: 0;
  z-index: 15;
  display: grid;
  place-items: center;
  background: var(--ground);
  padding: 3.5rem 1rem 1rem;
}
.chooser__panel {
  display: flex;
  flex-direction: column;
  align-items: stretch;
  width: min(16rem, 100%);
}
.chooser__actions {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.chooser__row {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  width: 100%;
  padding: 0.6rem 0.7rem;
  border: 0;
  border-radius: 12px;
  cursor: pointer;
  text-align: left;
  color: var(--ink-soft);
  background: transparent;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.chooser__row:hover {
  background: var(--hover);
  color: var(--ink);
}
.chooser__row-lead {
  display: inline-flex;
  flex: none;
  color: var(--muted);
}
.chooser__row:hover .chooser__row-lead {
  color: var(--ink-soft);
}
.chooser__row-label {
  min-width: 0;
  flex: 1;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.3;
}
.chooser__keys {
  display: inline-flex;
  flex: none;
  align-items: center;
  gap: 3px;
  margin-left: auto;
  opacity: 0.7;
  transition: opacity 0.18s ease;
}
.chooser__row:hover .chooser__keys {
  opacity: 1;
}
.chooser__key {
  display: inline-grid;
  place-items: center;
  min-width: 17px;
  height: 17px;
  padding: 0 4px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1;
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

/* Dormant body — a single muted line, centred, no chrome. */
.col__dormant {
  margin: 0;
  padding: 2.5rem 0.4rem 0;
  text-align: center;
  font-family: var(--font-sans);
  font-size: 12.5px;
  letter-spacing: -0.01em;
  color: var(--muted);
  opacity: 0.7;
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

/* A terminal column is a PTY, not a chat log: it must NOT inherit the thread
 * body's tall top/bottom padding, its top/bottom mask fade, or its own scroll
 * container — all of which fade out, mis-size and clip xterm (which manages its
 * own viewport + scrollback). Give it a clean full-height box so FitAddon can
 * measure the real height. */
.col__body--terminal {
  padding: 0.5rem 0.65rem 0.65rem;
  overflow: hidden;
  -webkit-mask-image: none;
  mask-image: none;
}

/* Scratchpad columns are prose editors, not chat logs: drop the thread body's
 * tall bottom padding and bottom mask fade, but keep a small top fade so text
 * scrolling under the header stays soft. */
.col__body--scratchpad {
  padding: 0.65rem 0.4rem 1.25rem;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  -webkit-mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 10px,
    #000 100%
  );
  mask-image: linear-gradient(
    to bottom,
    transparent 0,
    #000 10px,
    #000 100%
  );
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
  .index__dash.is-pulse,
  .col__live {
    animation: none;
  }
}
</style>
