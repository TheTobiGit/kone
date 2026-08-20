<script setup lang="ts">
import { computed, ref, useId, watch } from "vue";
import { onClickOutside, useEventListener } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon, InformationCircleIcon } from "@hugeicons/core-free-icons";
import { useEdgeFade } from "~/composables/useEdgeFade";

/** A Hugeicons glyph as the package hands it over — the icon exports are readonly
 *  tuples, and the package's own exported icon type isn't. */
type IconGlyph = readonly (readonly [string, Readonly<Record<string, string | number>>])[];

// The one frame every settings *page* sits in. A page (as opposed to the drawer's
// narrow root list) is the widened surface — Profile, Keyboard shortcuts,
// Providers, Usage, Provider limits, Thread strip — and until this existed each
// one hand-rolled its own
// masthead, back glyph, scroll treatment and foot note, which is how they drifted
// (one pane smoked its scroll edges, the next showed a bar; one back button had no
// pointer cursor). This owns all of that so there is a single thing to change and
// a single thing a new section copies.
//
// Two body shapes:
//   • scroll (default) — a plain vertical scroller with the edge-fade smoke and no
//     visible bar. For panes that are just "content + a note".
//   • scroll=false — a bare flex-column region the pane fills itself. For the two
//     panes with a bespoke interior (Providers' rail+panel, Thread strip's
//     preview+transport); they run their own scroller through useEdgeFade so the
//     smoke still matches.
//
// Slots: #actions sits at the masthead's right; #lede rides between masthead and
// body (a progress thread, an error line); default is the body; #foot is the pane
// note, reached by pressing the i at the bottom rather than sitting as a strip.

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The breadcrumb trail, e.g. "Ecosystem / Providers". */
    breadcrumb: string;
    /** Glyph of the settings row that opened this pane. Sits in front of the pane
     *  name, not the whole trail — so "Ecosystem / Providers" reads as a tree with
     *  the mark on the leaf, not as a third object before the path. */
    breadcrumbIcon?: IconGlyph;
    /** Section aria-label; falls back to the breadcrumb. */
    label?: string;
    /** Built-in edge-faded scroller for the body. Off for bespoke interiors. */
    scroll?: boolean;
  }>(),
  { scroll: true },
);

defineEmits<{ back: [] }>();

const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);

const noteOpen = ref(false);
const noteWrap = ref<HTMLElement>();
const noteId = useId();

watch(
  () => props.open,
  (open) => {
    if (!open) noteOpen.value = false;
  },
);

onClickOutside(noteWrap, () => {
  noteOpen.value = false;
});

// Capture so this Esc closes the note without also walking the drawer back.
useEventListener(
  window,
  "keydown",
  (e: KeyboardEvent) => {
    if (!noteOpen.value || e.key !== "Escape") return;
    e.preventDefault();
    e.stopImmediatePropagation();
    noteOpen.value = false;
  },
  { capture: true },
);

function toggleNote() {
  noteOpen.value = !noteOpen.value;
}

/** "Ecosystem / Skills / foo" → the mark belongs on Skills (the pane), not on foo
 *  (a nested leaf) and not on Agents (the group). One segment is the pane itself. */
const crumb = computed(() => {
  const parts = props.breadcrumb.split(" / ").filter(Boolean);
  if (parts.length <= 1) {
    return { group: "", pane: parts[0] ?? "", nested: [] as string[] };
  }
  return { group: parts[0]!, pane: parts[1]!, nested: parts.slice(2) };
});
</script>

<template>
  <section class="sps" :aria-label="label ?? breadcrumb">
    <header class="sps__mast" :class="{ 'sps__mast--split': $slots.actions }">
      <p class="sps__eyebrow">
        <button
          type="button"
          class="sps__back"
          :tabindex="open ? 0 : -1"
          aria-label="Back to settings"
          @click="$emit('back')"
        >
          <HugeiconsIcon
            :icon="ArrowTurnBackwardIcon"
            :size="13"
            :stroke-width="2"
            aria-hidden="true"
          />
        </button>
        <span class="sps__crumb">
          <template v-if="crumb.group">
            <span>{{ crumb.group }}</span>
            <span class="sps__slash" aria-hidden="true">/</span>
          </template>
          <span class="sps__pane">
            <HugeiconsIcon
              v-if="breadcrumbIcon"
              class="sps__crumbglyph"
              :icon="breadcrumbIcon"
              :size="12"
              :stroke-width="1.8"
              aria-hidden="true"
            />
            <span>{{ crumb.pane }}</span>
          </span>
          <template v-for="(seg, i) in crumb.nested" :key="i">
            <span class="sps__slash" aria-hidden="true">/</span>
            <span>{{ seg }}</span>
          </template>
        </span>
      </p>

      <div v-if="$slots.actions" class="sps__actions">
        <slot name="actions" />
      </div>
    </header>

    <slot name="lede" />

    <div
      v-if="scroll"
      ref="scroller"
      class="sps__scroll"
      :style="maskStyle"
      @scroll.passive="measure"
    >
      <slot />
    </div>
    <div v-else class="sps__body">
      <slot />
    </div>

    <div v-if="$slots.foot" ref="noteWrap" class="sps__note">
      <button
        type="button"
        class="sps__note-btn"
        :tabindex="open ? 0 : -1"
        :aria-expanded="noteOpen"
        :aria-controls="noteId"
        aria-label="About this page"
        @click="toggleNote"
      >
        <HugeiconsIcon
          :icon="InformationCircleIcon"
          :size="13"
          :stroke-width="1.8"
          aria-hidden="true"
        />
      </button>
      <Transition name="sps-note">
        <div
          v-if="noteOpen"
          :id="noteId"
          class="sps__note-pop"
          role="dialog"
          aria-label="About this page"
        >
          <slot name="foot" />
        </div>
      </Transition>
    </div>
  </section>
</template>

<style scoped>
.sps {
  --sps-ease: cubic-bezier(0.22, 1, 0.36, 1);
  --sps-t-enter: 320ms;
  --sps-t-micro: 140ms;
  display: flex;
  flex-direction: column;
  width: 100%;
  height: 100%;
  min-height: 0;
  padding: 1.25rem 1.5rem;
  overflow: hidden;
}

@keyframes sps-in {
  from {
    opacity: 0;
    transform: translateY(6px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

/* ── masthead ─────────────────────────────────────────────────────────────── */
.sps__mast {
  display: flex;
  flex-direction: column;
  gap: 7px;
  flex-shrink: 0;
  padding-inline: 1rem;
  animation: sps-in var(--sps-t-enter) var(--sps-ease) backwards;
}
/* A page with a masthead action (Providers' "Check again") puts the breadcrumb and
   the action on one line instead of stacking. */
.sps__mast--split {
  flex-direction: row;
  align-items: flex-start;
  justify-content: space-between;
  gap: 24px;
}

.sps__eyebrow {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 10px;
  letter-spacing: 0.08em;
  line-height: 1;
  text-transform: uppercase;
  color: var(--muted);
}

.sps__crumb {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
}
.sps__slash {
  opacity: 0.5;
}
/* Icon + pane name as one unit, tighter than the trail's slash gaps so the mark
   reads as belonging to the leaf rather than sitting in the path. */
.sps__pane {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.sps__crumbglyph {
  flex-shrink: 0;
  color: var(--muted);
}

.sps__actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
  /* Nudged down so a masthead action sits against the breadcrumb rather than
     riding above it (the mast is top-aligned so a tall action doesn't drag the
     breadcrumb down). */
  padding-top: 4px;
}

/* The corner-return glyph every pane wears: the return arrow turned upside down,
   then mirrored. Pointer cursor, soft wash on hover, the app's focus ring. */
.sps__back {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  margin-inline-start: -4px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--sps-t-micro) ease,
    color var(--sps-t-micro) ease;
}
.sps__back:hover {
  background-color: var(--hover);
  color: var(--ink);
}
.sps__back:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.sps__back :deep(svg) {
  transform: rotate(180deg) scaleX(-1);
}

/* ── body ─────────────────────────────────────────────────────────────────── */
/* The built-in scroller: no visible track/thumb — the edge-fade smoke (bound from
   useEdgeFade) stands in for the bar. */
.sps__scroll {
  flex: 1;
  min-height: 0;
  margin-top: 1.5rem;
  padding-inline: 1rem;
  overflow-y: auto;
  scrollbar-width: none;
}
.sps__scroll::-webkit-scrollbar {
  width: 0;
  height: 0;
}

/* The bare region a bespoke interior fills itself. A flex column so a pane can
   stack a scroller and a transport, or hand its whole height to one child. */
.sps__body {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  margin-top: 1.5rem;
}

/* ── note ─────────────────────────────────────────────────────────────────── */
/* The pane's one note, as an i rather than a strip — the body keeps the height
   the paragraph used to steal, and the copy only appears when asked for. */
.sps__note {
  /* Against the drawer, not the content — short pages used to sit the i under
     the last row, and stretching the shell to pin it collapsed the bodies. */
  position: fixed;
  left: calc(1.5rem + 1rem);
  bottom: 1.25rem;
  z-index: 2;
}
.sps__note-btn {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color var(--sps-t-micro) ease,
    color var(--sps-t-micro) ease;
}
.sps__note-btn:hover,
.sps__note-btn[aria-expanded="true"] {
  background-color: var(--hover);
  color: var(--ink);
}
.sps__note-btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
.sps__note-pop {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 2;
  width: max-content;
  max-width: min(36ch, calc(100vw - 4rem));
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--panel);
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 6px 24px rgba(0, 0, 0, 0.12);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  text-wrap: pretty;
}
.sps-note-enter-active,
.sps-note-leave-active {
  transition:
    opacity 180ms ease,
    transform 180ms var(--sps-ease);
}
.sps-note-enter-from,
.sps-note-leave-to {
  opacity: 0;
  transform: translateY(4px);
}

@media (prefers-reduced-motion: reduce) {
  .sps__mast {
    animation: none;
  }
  .sps-note-enter-active,
  .sps-note-leave-active {
    transition: opacity 120ms ease;
  }
  .sps-note-enter-from,
  .sps-note-leave-to {
    transform: none;
  }
}
</style>
