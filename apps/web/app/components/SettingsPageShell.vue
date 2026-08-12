<script setup lang="ts">
import { ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowTurnBackwardIcon } from "@hugeicons/core-free-icons";
import { useEdgeFade } from "~/composables/useEdgeFade";

// The one frame every settings *page* sits in. A page (as opposed to the drawer's
// narrow root list) is the widened surface — Profile, Providers, Usage, Provider
// limits, Thread strip — and until this existed each one hand-rolled its own
// masthead, back glyph, scroll treatment and foot note, which is how they drifted
// (one pane smoked its scroll edges, the next showed a bar; one back button had no
// pointer cursor). This owns all of that so there is a single thing to change and
// a single thing a new section copies.
//
// Two body shapes:
//   • scroll (default) — a plain vertical scroller with the edge-fade smoke and no
//     visible bar. For panes that are just "content + foot" (the three data panes).
//   • scroll=false — a bare flex-column region the pane fills itself. For the two
//     panes with a bespoke interior (Providers' rail+panel, Thread strip's
//     preview+transport); they run their own scroller through useEdgeFade so the
//     smoke still matches.
//
// Slots: #actions sits at the masthead's right; #lede rides between masthead and
// body (a progress thread, an error line); default is the body; #foot is the one
// pinned note.

const props = withDefaults(
  defineProps<{
    open: boolean;
    /** The breadcrumb trail, e.g. "Agents / Providers". */
    breadcrumb: string;
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
        {{ breadcrumb }}
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

    <p v-if="$slots.foot" class="sps__foot">
      <slot name="foot" />
    </p>
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

/* ── foot ─────────────────────────────────────────────────────────────────── */
/* The pane's one note, pinned below the body and kept out of the masthead's way. */
.sps__foot {
  flex-shrink: 0;
  margin: 1.25rem 1rem 0;
  padding-top: 1rem;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  font-size: 11.5px;
  line-height: 1.55;
  color: var(--muted);
  max-width: 62ch;
  text-wrap: pretty;
}

@media (prefers-reduced-motion: reduce) {
  .sps__mast {
    animation: none;
  }
}
</style>
