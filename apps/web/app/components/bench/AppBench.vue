<script setup lang="ts">
// AppBench — the third portal: work you put down, run one job at a time.
//
// The studio organises work by place and the inbox by what it wants from you.
// The bench organises work that has not started — things you wrote down and
// walked away from. It is the surface for when you are not in a conversation:
// you have five things in your head, you put them down, and they get worked
// through in order while you do something else.
//
// One job runs per project at a time, and that is not a throttle. It is what
// makes the list mean anything: a queue where six things start at once is six
// threads with extra steps, racing each other over the same checkout.
//
// The shell alone: it summons, it covers, it dismisses. What it shows is being
// designed from nothing, so the list inside it is a mock — the real read model
// and the real fields, in an arrangement still up for argument.

import { computed, ref } from "vue";
import { useEventListener } from "@vueuse/core";
import {
  BENCH_PADDING,
  BENCH_TITLEBAR_CLEARANCE,
} from "~/utils/benchLayout";
import BenchCompose from "~/components/bench/BenchCompose.vue";
import BenchList from "~/components/bench/BenchList.vue";
import type { PortalState } from "~/composables/usePortals";
import { useShortcuts } from "~/composables/useShortcuts";
import type { SurfaceId } from "~/utils/surfaceTop";
import { ownsKey } from "~/utils/surfaceKeys";

const props = defineProps<{
  /** Where the bench sits in the portal stack. `hidden` is away, `active` is
   *  the frontmost layer, `covered` is open underneath another portal. Hidden
   *  with `visibility`, never unmounted. */
  state: PortalState;
  /** Which viewport surface owns Escape, resolved once in the page. The bench
   *  answers only when named, so one press never dismisses two layers. */
  surfaceTop: SurfaceId;
}>();

const emit = defineEmits<{
  close: [];
}>();

const { matchesShortcut } = useShortcuts();
const { cue } = useSound();

/* The shelf and the traffic-light clearance, as numbers the stylesheet reads
   through custom properties, so the padding and anything measuring against it
   cannot drift. */
const padStyle = computed(() => ({
  "--bench-pad": `${BENCH_PADDING}px`,
  "--bench-titlebar": `${BENCH_TITLEBAR_CLEARANCE}px`,
}));

/** Writing a new job. The composer covers the list rather than sitting under
 *  it: the bench is a place you put work down, so while you are writing one the
 *  queue behind it is context, not something to keep reading. */
const composing = ref(false);

const isActive = computed(() => props.state === "active");
const isCovered = computed(() => props.state === "covered");

/* ⌘N writes a new job, on the same binding the studio makes a new thread on.
   One gesture, read against whatever is in front of you — and only ever one
   handler answers it, because the studio's own listener stands down while it is
   covered and this one only answers while the bench is the surface on top.

   Bound here rather than in the page for the same reason: the portal is the
   thing that knows whether its composer is already up. */
useEventListener(window, "keydown", (event: KeyboardEvent) => {
  if (!ownsKey(props.surfaceTop, "bench", event)) return;
  if (!matchesShortcut("new-thread", event)) return;
  event.preventDefault();
  // Already writing one: the press is a no-op rather than a reset, so it can
  // never wipe a draft that is halfway written.
  if (composing.value) return;
  cue("press");
  composing.value = true;
});

/** Escape leaves the portal. Stopping the event is what keeps one press from
 *  dismissing this and whatever is behind it. */
function onEscape(event: KeyboardEvent): void {
  if (props.surfaceTop !== "bench") return;
  event.stopPropagation();
  // The composer is the innermost thing open, so it goes first. One press
  // should never both abandon a draft and leave the portal.
  if (composing.value) {
    composing.value = false;
    return;
  }
  emit("close");
}
</script>

<template>
  <div
    class="bench portal-fade"
    :class="{
      'portal-fade--hidden': state === 'hidden',
      'portal-fade--covered': isCovered,
    }"
    :style="padStyle"
    :inert="!isActive"
    @keydown.escape="onEscape"
  >
    <div class="bench__pane">
      <BenchList @new-job="composing = true" />
    </div>

    <template v-if="composing">
      <div class="bench__scrim" @click="composing = false" />
      <div class="bench__compose">
        <BenchCompose @filed="composing = false" />
      </div>
    </template>
  </div>
</template>

<style scoped>
/* Opaque and full-bleed inside the stage, so it is clipped by the stage and
   rides the settings-drawer slide for free. Above the inbox: the portals are
   siblings in one stacking context, and the bench wins because summoning it is
   a decision to stop looking at both the work and the mail. */
.bench {
  position: absolute;
  inset: 0;
  z-index: 46;
  overflow: hidden;
  background: var(--ground);
  /* Hide/show timing lives with .portal-fade in assets/css/main.css. */

  /* The portal's own shelf. The ground only reads as ground when something is
     sitting on it, which is the same reason the inbox keeps a margin all the
     way round its panes rather than running them to the window's edge.
     Deeper at the top, where the window floats its own traffic lights over the
     renderer: the strip they sit in belongs to the window, so the pane starts
     under it and the row inside the pane keeps its ordinary padding. */
  padding: var(--bench-titlebar) var(--bench-pad) var(--bench-pad);
}

/* One surface for the whole bench. Not a card per status: six cards make six
   equal places, and the pane is the bench itself — what is inside it is where
   a job is sitting on it. */
/* The tray the picker and the intent menu are built from: the shell is the
   band, and what you act on is a raised card sitting in it. Clipped to the
   radius so the header band's square corners cannot paint over the curve. */
/* One surface for the whole bench, on the portal's shelf. Calm on purpose:
   the board inside it already carries a clock, lanes and three registers, and
   a tray's worth of raised cards around that would be furniture on furniture. */
/* One surface for the whole bench, on the portal's shelf, in the modal shell's
   own card: its fill, its radius, its hairline ring. What is inside it is the
   shell's arrangement too — a scooped band at the top, the rows on the panel,
   a scooped band at the foot. */
/* Dimming the queue rather than hiding it: the list is why you are writing,
   so it stays legible behind the draft, just no longer the thing in front. */
.bench__scrim {
  position: absolute;
  inset: 0;
  background: color-mix(in srgb, var(--ground) 62%, transparent);
}
/* Centred by auto margins rather than by a translate. A transform would make
   this the containing block for every `position: fixed` descendant, and the
   pickers the composer opens are full-window overlays — trapped in here they
   render inside the card's own 680px and get cut off by it. */
.bench__compose {
  position: absolute;
  left: 0;
  right: 0;
  bottom: calc(var(--bench-pad) + 44px);
  width: min(680px, calc(100% - var(--bench-pad) * 2 - 48px));
  margin-inline: auto;
}

.bench__pane {
  height: 100%;
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
}
</style>
