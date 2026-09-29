<script setup lang="ts">
import { onBeforeUnmount, ref } from "vue";
import { useResizeObserver } from "@vueuse/core";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUp01Icon } from "@hugeicons/core-free-icons";
import SpaceSectionHeader from "./SpaceSectionHeader.vue";

// One full-height column of the Space board: its header (the title, and
// whatever the caller sets beside it), then its cards in a feed that scrolls
// on its own. Scroll past the header and a small pill
// with the title stands in for it, the content fading out beneath; the pill
// takes the column back to the top. The feed fades out at the foot too, for as
// long as there is more beneath it. The board sets the column's width, and
// flags it `landed` when the camera has just been sent here.

defineProps<{
  title: string;
  /** The camera just landed here: the column washes grey, then settles. */
  landed?: boolean;
}>();

/** How far the feed scrolls before the pill stands in for the header. */
const PILL_AT = 32;
/** What is left to scroll once the last card is fully in view: the feed's own
 *  bottom padding, which the style below is bound to. Past this, there is still
 *  more beneath. */
const END_PAD = 40;
const endPad = `${END_PAD}px`;

const scroller = ref<HTMLElement | null>(null);
const feed = ref<HTMLElement | null>(null);
const away = ref(false);
/** There is more feed beneath the fold. */
const more = ref(false);

/** Where the feed is: scrolled off its top, and short of its end. Cards arrive
 *  late (usage, a scan), so this also runs when the feed or the column changes
 *  size, not only on scroll. Cheap to call: the refs only notify when a flag
 *  actually flips. */
function measure(): void {
  const el = scroller.value;
  if (!el) return;
  away.value = el.scrollTop > PILL_AT;
  more.value = el.scrollHeight - el.scrollTop - el.clientHeight > END_PAD;
}
useResizeObserver([scroller, feed], measure);

// While the feed moves, its contents ignore the pointer: a resting cursor
// would otherwise fire hover on every heatmap square that slides under it, and
// each one re-renders the card. The class goes on and off the element directly,
// so scrolling costs no render, and it lifts a beat after the last scroll.
const SETTLE_MS = 150;
let settle: ReturnType<typeof setTimeout> | null = null;

function onScroll(): void {
  const el = scroller.value;
  if (!el) return;
  // Every layout read comes before the class write below, or each scroll event
  // would force a layout.
  measure();
  el.classList.add("is-scrolling");
  if (settle) clearTimeout(settle);
  settle = setTimeout(() => el.classList.remove("is-scrolling"), SETTLE_MS);
}

onBeforeUnmount(() => {
  if (settle) clearTimeout(settle);
});

function toTop(): void {
  const reduceMotion = window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
  scroller.value?.scrollTo({ top: 0, behavior: reduceMotion ? "auto" : "smooth" });
}
</script>

<template>
  <section class="col" :class="{ 'is-landed': landed }" :aria-label="title">
    <div ref="scroller" class="col__scroll" @scroll.passive="onScroll">
      <div ref="feed" class="col__feed">
        <SpaceSectionHeader :title="title">
          <template #aside>
            <slot name="aside" />
          </template>
        </SpaceSectionHeader>
        <slot />
      </div>
    </div>
    <div class="col__fade" :class="{ 'is-on': away }" aria-hidden="true" />
    <div class="col__fade col__fade--end" :class="{ 'is-on': more }" aria-hidden="true" />
    <button type="button" class="col__pill" :class="{ 'is-on': away }" @click="toTop">
      <HugeiconsIcon :icon="ArrowUp01Icon" :size="12" :stroke-width="2" aria-hidden="true" />
      {{ title }}
    </button>
  </section>
</template>

<style scoped>
.col {
  position: relative;
  flex: none;
  height: 100%;
  min-width: 0;
}

/* Landing wash: a veil over the column that fades out, so the eye finds where
   the camera stopped. */
.col::before {
  content: "";
  position: absolute;
  inset: 0;
  z-index: 2;
  background-color: color-mix(in srgb, var(--ink) 6%, transparent);
  opacity: 0;
  pointer-events: none;
}
.col.is-landed::before {
  animation: col-land 1.1s ease-out;
}
@keyframes col-land {
  from {
    opacity: 1;
  }
  to {
    opacity: 0;
  }
}

.col__scroll {
  height: 100%;
  overflow-y: auto;
  overscroll-behavior-y: contain;
  /* Opaque, so the browser can scroll it on the compositor without repainting. */
  background-color: var(--ground);
  /* No bar: the fades at the top and foot say there is more, and the wheel or a
     swipe moves it. */
  scrollbar-width: none;
}
.col__scroll::-webkit-scrollbar {
  display: none;
}
/* The feed is one box around everything scrolling, so its size is the thing to
   watch. The board sets --col-pad-l / --col-pad-r where a column sits close
   against a neighbour it belongs with. */
.col__feed {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 1.5rem var(--col-pad-r, 1.5rem) v-bind(endPad) var(--col-pad-l, 1.5rem);
  box-sizing: border-box;
}
/* A feed longer than the column scrolls; its cards never shrink to fit. */
.col__feed > :deep(*) {
  flex: none;
}
/* The scroller itself keeps the pointer, so the wheel stays with it. */
.col__scroll.is-scrolling > .col__feed {
  pointer-events: none;
}

/* Under the pill, the feed fades into the ground; at the foot it does the same
   for as long as there is more beneath. */
.col__fade {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  z-index: 1;
  height: 64px;
  background: linear-gradient(to bottom, var(--ground) 35%, transparent);
  opacity: 0;
  pointer-events: none;
  transition: opacity 0.2s ease;
}
.col__fade--end {
  top: auto;
  bottom: 0;
  background: linear-gradient(to top, var(--ground) 35%, transparent);
}
.col__fade.is-on {
  opacity: 1;
}

.col__pill {
  position: absolute;
  top: 12px;
  left: var(--col-pad-l, 1.5rem);
  z-index: 3;
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 4px 11px 4px 8px;
  border-radius: 999px;
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
  background-color: var(--ground);
  font-size: 11.5px;
  color: var(--ink);
  cursor: pointer;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-4px);
  transition:
    opacity 0.2s ease,
    transform 0.2s ease,
    visibility 0s linear 0.2s,
    background-color 0.15s ease;
}
.col__pill.is-on {
  opacity: 1;
  visibility: visible;
  transform: none;
  transition-delay: 0s;
}
.col__pill:hover {
  background-color: var(--hover);
}
.col__pill:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--accent) 40%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .col.is-landed::before {
    animation: none;
  }
  .col__fade,
  .col__pill {
    transition: none;
  }
}
</style>
