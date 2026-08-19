<script lang="ts">
/** Where the selection sits, in viewport coordinates. */
export type PadBarAnchor = {
  /** Horizontal centre of the selection's first line. */
  x: number;
  /** Top of the first line — the edge the bar sits above. */
  top: number;
  /** Bottom of the last line — the edge it sits below when there's no room. */
  bottom: number;
};
</script>

<script setup lang="ts">
/**
 * The scratchpad's selection toolbar.
 *
 * One row, always the same height: block kind, the four marks, the two pens, and
 * the eraser. The colours used to sit in two open rows of eleven dots, which made
 * the bar a panel — tall enough to cover the sentence it was acting on and slow to
 * read. They live behind their pens now, as split controls: pressing the pen paints
 * with the colour it's already carrying (the common case, one click), and the
 * chevron beside it opens the palette (the rare one).
 *
 * The bar also places itself. It's given where the selection is and works out
 * above-or-below and the horizontal clamp from its own measured box, so its layout
 * and its position can't fall out of step — which is what a hard-coded height in
 * the pane had been quietly doing.
 */
import { computed, ref, watch } from "vue";
import { useEventListener } from "@vueuse/core";
import { AnimatePresence, motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  ArrowDown01Icon,
  CheckListIcon,
  Heading01Icon,
  Heading02Icon,
  Heading03Icon,
  HighlighterIcon,
  LeftToRightBlockQuoteIcon,
  LeftToRightListBulletIcon,
  LeftToRightListNumberIcon,
  ParagraphIcon,
  SourceCodeIcon,
  TextBoldIcon,
  TextClearIcon,
  TextColorIcon,
  TextItalicIcon,
  TextStrikethroughIcon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import {
  PAD_HIGHLIGHTS,
  PAD_TEXT_COLORS,
  highlightById,
  textColorById,
} from "~/utils/padColors";
import type { PadMarker } from "~/composables/useScratchpad";
import type { PadBlockKind, PadMarkKind } from "~/composables/usePadEditor";

const props = defineProps<{
  visible: boolean;
  anchor: PadBarAnchor;
  /** Which marks the current selection already carries — the lit buttons. */
  marks: Record<PadMarkKind, boolean>;
  /** What kind of block the selection is in. */
  block: PadBlockKind;
  /** The armed pens; their swatches wear the ring. */
  marker: PadMarker;
}>();

const emit = defineEmits<{
  mark: [kind: PadMarkKind];
  block: [kind: PadBlockKind];
  highlight: [id: string];
  "text-color": [id: string];
  clear: [];
  dismiss: [];
}>();

// ── contents ─────────────────────────────────────────────────────────────────

const BLOCKS: { kind: PadBlockKind; icon: typeof ParagraphIcon; label: string; short: string; hint?: string }[] = [
  { kind: "p", icon: ParagraphIcon, label: "Body text", short: "Text" },
  { kind: "h1", icon: Heading01Icon, label: "Heading 1", short: "H1", hint: "# " },
  { kind: "h2", icon: Heading02Icon, label: "Heading 2", short: "H2", hint: "## " },
  { kind: "h3", icon: Heading03Icon, label: "Heading 3", short: "H3", hint: "### " },
  { kind: "ul", icon: LeftToRightListBulletIcon, label: "Bulleted list", short: "List", hint: "- " },
  { kind: "ol", icon: LeftToRightListNumberIcon, label: "Numbered list", short: "1. List", hint: "1. " },
  { kind: "task", icon: CheckListIcon, label: "Task", short: "Task", hint: "⌘⇧K" },
  { kind: "quote", icon: LeftToRightBlockQuoteIcon, label: "Quote", short: "Quote", hint: "> " },
];

const MARKS: { kind: PadMarkKind; icon: typeof TextBoldIcon; label: string; hint: string }[] = [
  { kind: "bold", icon: TextBoldIcon, label: "Bold", hint: "⌘B" },
  { kind: "italic", icon: TextItalicIcon, label: "Italic", hint: "⌘I" },
  { kind: "strike", icon: TextStrikethroughIcon, label: "Strikethrough", hint: "⌘⇧S" },
  { kind: "code", icon: SourceCodeIcon, label: "Code", hint: "⌘E" },
];

const activeBlock = computed(() => BLOCKS.find((b) => b.kind === props.block) ?? BLOCKS[0]!);
const armedHighlight = computed(() => highlightById(props.marker.highlight));
const armedText = computed(() => textColorById(props.marker.text));

// ── placement ────────────────────────────────────────────────────────────────

/** Breathing room between the bar and the words it acts on. */
const GAP = 10;
/** How close the bar may come to the window's edges. */
const EDGE = 12;

const bar = ref<HTMLElement | null>(null);

/** `motion.div` is a component, so its template ref is an instance — the element
 *  is what we need to measure and to walk for keyboard focus. */
function setBar(el: unknown): void {
  const node = el && typeof el === "object" && "$el" in el ? (el as { $el: unknown }).$el : el;
  bar.value = node instanceof HTMLElement ? node : null;
}

/** The bar's own box. Seeded with a plausible size so the very first frame — the
 *  one that is still fully transparent — lands close, then measured for real. */
const size = ref({ w: 316, h: 38 });

/** Offsets, not a client rect: the bar animates in under a scale transform, and a
 *  rect measured mid-flight would place it a few pixels off centre. */
function measure(): void {
  const el = bar.value;
  if (!el) return;
  if (el.offsetWidth && el.offsetHeight) {
    size.value = { w: el.offsetWidth, h: el.offsetHeight };
  }
}

watch(
  () => [props.visible, props.block, props.marker.highlight] as const,
  () => requestAnimationFrame(measure),
);

const placement = computed<"above" | "below">(() =>
  props.anchor.top >= size.value.h + GAP + EDGE ? "above" : "below",
);

const barTop = computed(() =>
  placement.value === "above" ? props.anchor.top - GAP - size.value.h : props.anchor.bottom + GAP,
);

const style = computed(() => {
  const w = size.value.w;
  const left = Math.min(
    Math.max(props.anchor.x - w / 2, EDGE),
    Math.max(EDGE, window.innerWidth - w - EDGE),
  );
  return { top: `${Math.round(barTop.value)}px`, left: `${Math.round(left)}px` };
});

// ── the two popovers ─────────────────────────────────────────────────────────

type Pop = "block" | "highlight" | "text";
const open = ref<Pop | null>(null);

/** Fixed layouts, so their heights are known without measuring: eight menu rows,
 *  or one row of swatches. Both include the panel's padding and its offset. */
const POP_HEIGHT = { block: 249, highlight: 40, text: 40 } satisfies Record<Pop, number>;

function toggle(pop: Pop): void {
  open.value = open.value === pop ? null : pop;
}

/**
 * Which side of the bar a popover opens on.
 *
 * It wants the side away from the selected text, so the panel never covers what
 * you're about to format. But a bar sitting near the top of the window has no
 * room up there — the block menu is eight rows tall — so when the preferred side
 * can't hold it, the popover takes whichever side is roomier.
 */
const popSide = computed<"above" | "below">(() => {
  const pop = open.value;
  if (!pop) return placement.value;
  const above = barTop.value - EDGE;
  const below = window.innerHeight - (barTop.value + size.value.h) - EDGE;
  const need = POP_HEIGHT[pop];
  if (placement.value === "above") return above >= need || above >= below ? "above" : "below";
  return below >= need || below >= above ? "below" : "above";
});

/**
 * Escape steps back out one layer at a time: an open palette first, the bar
 * second — so reaching for a colour and changing your mind doesn't also throw
 * away the selection.
 *
 * It listens on the window rather than the bar because focus is still in the
 * document the whole time: the bar refuses focus on mousedown precisely so the
 * selection it acts on survives being clicked at.
 */
useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (e.key !== "Escape" || !props.visible) return;
  e.preventDefault();
  if (open.value) open.value = null;
  else emit("dismiss");
});

// The bar is transient: any new selection, or the bar going away, drops an open
// palette rather than leaving it hanging over the next sentence.
watch(() => props.visible, (v) => {
  if (!v) open.value = null;
});
watch(() => [props.anchor.x, props.anchor.top], () => {
  open.value = null;
});

function pickBlock(kind: PadBlockKind): void {
  open.value = null;
  emit("block", kind);
}

function pickHighlight(id: string): void {
  open.value = null;
  emit("highlight", id);
}

function pickText(id: string): void {
  open.value = null;
  emit("text-color", id);
}

/** Left/right walk the row, so the bar is usable once tabbed into. */
function onNav(e: KeyboardEvent): void {
  if (e.key !== "ArrowLeft" && e.key !== "ArrowRight") return;
  const items = Array.from(bar.value?.querySelectorAll<HTMLElement>("[data-nav]") ?? []);
  const here = items.indexOf(document.activeElement as HTMLElement);
  if (here < 0) return;
  e.preventDefault();
  const next = (here + (e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length;
  items[next]?.focus();
}
</script>

<template>
  <Teleport to="body">
    <AnimatePresence>
      <motion.div
        v-if="visible"
        :ref="setBar"
        key="pad-format-bar"
        class="tb"
        :class="[`tb--${placement}`, `tb--pop-${popSide}`, { 'tb--open': open }]"
        :style="style"
        role="toolbar"
        aria-label="Formatting"
        :initial="{ opacity: 0, y: placement === 'above' ? 5 : -5, scale: 0.97 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: popSide === 'above' ? 4 : -4, scale: 0.97 }"
        :transition="{ duration: 0.16, ease: [0.22, 1, 0.36, 1] }"
        @mousedown.prevent
        @keydown="onNav"
      >
        <!-- block kind ─────────────────────────────────────────────────────── -->
        <div class="tb__slot">
          <button
            type="button"
            class="tb__btn tb__btn--wide"
            data-nav
            :aria-expanded="open === 'block'"
            aria-haspopup="menu"
            :title="`Block kind · ${activeBlock.label}`"
            @click="toggle('block')"
          >
            <HugeiconsIcon :icon="activeBlock.icon" :size="14" :stroke-width="1.9" />
            <span class="tb__label">{{ activeBlock.short }}</span>
            <HugeiconsIcon class="tb__caret" :icon="ArrowDown01Icon" :size="12" :stroke-width="2.2" />
          </button>

          <AnimatePresence>
            <motion.div
              v-if="open === 'block'"
              key="block-menu"
              class="tb__pop tb__pop--menu"
              role="menu"
              aria-label="Block kind"
              :initial="{ opacity: 0, y: popSide === 'above' ? 4 : -4, scale: 0.98 }"
              :animate="{ opacity: 1, y: 0, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.98 }"
              :transition="{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }"
            >
              <button
                v-for="b in BLOCKS"
                :key="b.kind"
                type="button"
                class="tb__item"
                :class="{ 'is-on': block === b.kind }"
                role="menuitemradio"
                :aria-checked="block === b.kind"
                @click="pickBlock(b.kind)"
              >
                <HugeiconsIcon class="tb__item-icon" :icon="b.icon" :size="14" :stroke-width="1.9" />
                <span class="tb__item-label">{{ b.label }}</span>
                <span v-if="b.hint" class="tb__item-hint">{{ b.hint }}</span>
                <HugeiconsIcon
                  v-if="block === b.kind"
                  class="tb__item-tick"
                  :icon="Tick02Icon"
                  :size="13"
                  :stroke-width="2.4"
                />
              </button>
            </motion.div>
          </AnimatePresence>
        </div>

        <span class="tb__rule" aria-hidden="true" />

        <!-- marks ──────────────────────────────────────────────────────────── -->
        <button
          v-for="m in MARKS"
          :key="m.kind"
          type="button"
          class="tb__btn"
          data-nav
          :class="{ 'is-on': props.marks[m.kind] }"
          :title="`${m.label} · ${m.hint}`"
          :aria-label="m.label"
          :aria-pressed="props.marks[m.kind]"
          @click="emit('mark', m.kind)"
        >
          <HugeiconsIcon :icon="m.icon" :size="14" :stroke-width="1.9" />
        </button>

        <span class="tb__rule" aria-hidden="true" />

        <!-- highlighter: press to paint, chevron for the palette ───────────── -->
        <div class="tb__slot tb__split" :style="{ '--pen': armedHighlight.swatch }">
          <button
            type="button"
            class="tb__btn tb__btn--pen"
            data-nav
            :class="{ 'is-on': props.marks.highlight }"
            :title="`Highlight · ${armedHighlight.label} · ⌘⇧H`"
            :aria-label="`Highlight with ${armedHighlight.label}`"
            @click="emit('highlight', marker.highlight)"
          >
            <HugeiconsIcon :icon="HighlighterIcon" :size="14" :stroke-width="1.9" />
          </button>
          <button
            type="button"
            class="tb__chev"
            data-nav
            :aria-expanded="open === 'highlight'"
            aria-haspopup="true"
            aria-label="Choose highlight colour"
            title="Choose highlight colour"
            @click="toggle('highlight')"
          >
            <HugeiconsIcon :icon="ArrowDown01Icon" :size="11" :stroke-width="2.4" />
          </button>

          <AnimatePresence>
            <motion.div
              v-if="open === 'highlight'"
              key="hl-pop"
              class="tb__pop tb__pop--swatches"
              role="group"
              aria-label="Highlight colour"
              :initial="{ opacity: 0, y: popSide === 'above' ? 4 : -4, scale: 0.98 }"
              :animate="{ opacity: 1, y: 0, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.98 }"
              :transition="{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }"
            >
              <button
                v-for="c in PAD_HIGHLIGHTS"
                :key="`h-${c.id}`"
                type="button"
                class="tb__swatch"
                :class="{ 'is-armed': marker.highlight === c.id }"
                :style="{ '--dot': c.swatch }"
                :title="c.label"
                :aria-label="`Highlight ${c.label}`"
                :aria-pressed="marker.highlight === c.id"
                @click="pickHighlight(c.id)"
              />
            </motion.div>
          </AnimatePresence>
        </div>

        <!-- text colour ───────────────────────────────────────────────────── -->
        <div class="tb__slot tb__split" :style="{ '--pen': armedText.swatch }">
          <button
            type="button"
            class="tb__btn tb__btn--pen"
            data-nav
            :title="`Text colour · ${armedText.label}`"
            :aria-label="`Colour text ${armedText.label}`"
            @click="emit('text-color', marker.text)"
          >
            <HugeiconsIcon :icon="TextColorIcon" :size="14" :stroke-width="1.9" />
          </button>
          <button
            type="button"
            class="tb__chev"
            data-nav
            :aria-expanded="open === 'text'"
            aria-haspopup="true"
            aria-label="Choose text colour"
            title="Choose text colour"
            @click="toggle('text')"
          >
            <HugeiconsIcon :icon="ArrowDown01Icon" :size="11" :stroke-width="2.4" />
          </button>

          <AnimatePresence>
            <motion.div
              v-if="open === 'text'"
              key="tc-pop"
              class="tb__pop tb__pop--swatches"
              role="group"
              aria-label="Text colour"
              :initial="{ opacity: 0, y: popSide === 'above' ? 4 : -4, scale: 0.98 }"
              :animate="{ opacity: 1, y: 0, scale: 1 }"
              :exit="{ opacity: 0, scale: 0.98 }"
              :transition="{ duration: 0.14, ease: [0.22, 1, 0.36, 1] }"
            >
              <button
                v-for="c in PAD_TEXT_COLORS"
                :key="`t-${c.id}`"
                type="button"
                class="tb__swatch tb__swatch--text"
                :class="{ 'is-armed': marker.text === c.id, 'is-default': c.id === 'default' }"
                :style="{ '--dot': c.swatch }"
                :title="c.id === 'default' ? 'Default ink' : c.label"
                :aria-label="`Text colour ${c.label}`"
                :aria-pressed="marker.text === c.id"
                @click="pickText(c.id)"
              />
            </motion.div>
          </AnimatePresence>
        </div>

        <span class="tb__rule" aria-hidden="true" />

        <button
          type="button"
          class="tb__btn"
          data-nav
          title="Clear formatting"
          aria-label="Clear formatting"
          @click="emit('clear')"
        >
          <HugeiconsIcon :icon="TextClearIcon" :size="14" :stroke-width="1.9" />
        </button>

        <span class="tb__beak" aria-hidden="true" />
      </motion.div>
    </AnimatePresence>
  </Teleport>
</template>

<style scoped>
.tb {
  position: fixed;
  z-index: 52;
  display: flex;
  align-items: center;
  gap: 1px;
  padding: 4px;
  border-radius: 13px;
  background: color-mix(in srgb, var(--ground) 94%, transparent);
  backdrop-filter: blur(16px) saturate(1.4);
  /* A hairline holds the bar apart from the page; the lift is soft and wide,
   * never a slab. */
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  box-shadow:
    inset 0 1px 0 color-mix(in srgb, white 10%, transparent),
    0 1px 3px color-mix(in srgb, var(--ink) 5%, transparent),
    0 10px 28px color-mix(in srgb, var(--ink) 11%, transparent);
  pointer-events: auto;
}

/* ── the beak, pointing at the run of text the bar acts on ─────────────────── */
.tb__beak {
  position: absolute;
  left: 50%;
  width: 10px;
  height: 10px;
  background: inherit;
  transform: translateX(-50%) rotate(45deg);
  backdrop-filter: inherit;
  transition: opacity 0.12s ease;
}
.tb--above .tb__beak {
  bottom: -5px;
  border-right: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-bottom-right-radius: 2px;
}
.tb--below .tb__beak {
  top: -5px;
  border-left: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-top: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  border-top-left-radius: 2px;
}
/* With a palette out, the bar is a surface someone is working in rather than a
 * pointer at a phrase — the beak would just add noise under the panel. */
.tb--open .tb__beak {
  opacity: 0;
}

.tb__rule {
  width: 1px;
  height: 18px;
  margin: 0 4px;
  background: color-mix(in srgb, var(--ink) 11%, transparent);
}

/* ── buttons ──────────────────────────────────────────────────────────────── */
.tb__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 5px;
  height: 28px;
  min-width: 28px;
  padding: 0;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--ink-soft, var(--ink));
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease,
    transform 0.1s ease;
}
.tb__btn--wide {
  padding: 0 6px 0 7px;
}
.tb__label {
  font-size: 11.5px;
  line-height: 1;
  letter-spacing: 0.005em;
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.tb__caret {
  margin-left: -1px;
  color: var(--muted);
}

.tb__btn:hover,
.tb__chev:hover {
  background: var(--hover);
  color: var(--ink);
}
.tb__btn:active,
.tb__chev:active {
  transform: scale(0.93);
}
.tb__btn:focus-visible,
.tb__chev:focus-visible,
.tb__swatch:focus-visible,
.tb__item:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--ground), 0 0 0 3.5px var(--accent);
}
.tb__btn[aria-expanded="true"],
.tb__chev[aria-expanded="true"] {
  background: color-mix(in srgb, var(--ink) 8%, transparent);
  color: var(--ink);
}

/* A lit mark wears its own colour when it has one — the highlighter's armed pen. */
.tb__btn.is-on {
  background: color-mix(in srgb, var(--pen, var(--accent)) 18%, transparent);
  color: var(--ink);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--pen, var(--accent)) 32%, transparent);
}

/* ── split controls: pen + chevron in one shell ────────────────────────────── */
.tb__slot {
  position: relative;
  display: flex;
  align-items: center;
}
.tb__split .tb__btn--pen {
  border-top-right-radius: 3px;
  border-bottom-right-radius: 3px;
  padding-left: 2px;
}
.tb__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 28px;
  padding: 0;
  border: 0;
  border-radius: 9px 9px 9px 9px;
  border-top-left-radius: 3px;
  border-bottom-left-radius: 3px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease,
    transform 0.1s ease;
}

/* The pen carries the colour it will paint with as a bead of ink beneath it, so
 * the armed choice is legible without opening anything. */
.tb__btn--pen {
  position: relative;
}
.tb__btn--pen::after {
  content: "";
  position: absolute;
  left: 5px;
  right: 3px;
  bottom: 3px;
  height: 2px;
  border-radius: 999px;
  background: var(--pen);
}

/* ── popovers ─────────────────────────────────────────────────────────────── */
.tb__pop {
  position: absolute;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1;
  padding: 5px;
  border-radius: 12px;
  /* A menu is read through, not looked past: it sits opaque on the ground while
   * the bar itself stays a touch translucent. */
  background: var(--ground);
  backdrop-filter: blur(16px) saturate(1.4);
  border: 1px solid color-mix(in srgb, var(--ink) 12%, transparent);
  box-shadow:
    0 1px 3px color-mix(in srgb, var(--ink) 5%, transparent),
    0 10px 26px color-mix(in srgb, var(--ink) 12%, transparent);
}
/* A palette opens away from the text where there's room for it — see popSide. */
.tb--pop-above .tb__pop {
  bottom: calc(100% + 7px);
}
.tb--pop-below .tb__pop {
  top: calc(100% + 7px);
}

.tb__pop--swatches {
  display: flex;
  align-items: center;
  gap: 5px;
  /* The armed swatch wears a ring outside its disc — the padding is what keeps
   * that ring off the panel's own edge. */
  padding: 6px;
}

.tb__pop--menu {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 194px;
  left: 0;
  transform: none;
}

.tb__item {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  height: 28px;
  padding: 0 7px;
  border: 0;
  border-radius: 8px;
  background: transparent;
  color: var(--ink-soft, var(--ink));
  font: inherit;
  font-size: 12px;
  line-height: 1;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.12s ease, color 0.12s ease;
}
.tb__item:hover {
  background: var(--hover);
  color: var(--ink);
}
.tb__item.is-on {
  color: var(--ink);
}
.tb__item-icon {
  flex: none;
  color: var(--muted);
}
.tb__item.is-on .tb__item-icon {
  color: var(--accent);
}
.tb__item-label {
  flex: 1;
  white-space: nowrap;
}
.tb__item-hint {
  flex: none;
  color: var(--muted);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  white-space: pre;
}
.tb__item-tick {
  flex: none;
  color: var(--accent);
  margin-right: -2px;
}
/* The tick takes the hint's place rather than adding a column, so the rows keep
 * one width whichever kind is active. */
.tb__item.is-on .tb__item-hint {
  display: none;
}

/* ── swatches ─────────────────────────────────────────────────────────────── */
.tb__swatch {
  position: relative;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 999px;
  background: var(--dot);
  cursor: pointer;
  transition: transform 0.13s ease, box-shadow 0.13s ease;
}
.tb__swatch:hover {
  transform: scale(1.14);
}
.tb__swatch:active {
  transform: scale(0.94);
}
.tb__swatch--text {
  background: transparent;
  color: var(--dot);
}
/* A text swatch reads as a letter-coloured disc inside a ring, so the two
 * palettes can't be mistaken for each other. */
.tb__swatch--text::before {
  content: "";
  position: absolute;
  inset: 2px;
  border-radius: 999px;
  background: var(--dot);
}
.tb__swatch--text.is-default::before {
  background: var(--ink);
}
.tb__swatch.is-armed {
  box-shadow: 0 0 0 2px var(--ground), 0 0 0 3.5px var(--dot);
}

@media (prefers-reduced-motion: reduce) {
  .tb,
  .tb__beak,
  .tb__pop {
    backdrop-filter: none;
  }
  .tb__btn,
  .tb__chev,
  .tb__swatch {
    transition: background-color 0.14s ease, color 0.14s ease;
  }
  .tb__btn:active,
  .tb__chev:active,
  .tb__swatch:hover,
  .tb__swatch:active {
    transform: none;
  }
}
</style>
