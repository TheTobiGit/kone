<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { botMark, type AgentBot } from "~/utils/bot";

// An agent's bot, resting on the composer and watching the pointer.
//
// This is the mark for a thread that belongs to somebody: where a guest thread
// rests under a rolled face, an agent's thread rests under the creature that
// agent drives. Same place, same size, same behaviour — the only thing that
// changes is whose it is, which is the whole point of it being here.
//
// It follows the pointer rather than sitting still, because the mark it replaces
// does: a bead that stopped looking up when a thread acquired an owner would read
// as the thread going dead, not as it being claimed. The expression the agent
// chose is untouched — a wary bot follows you warily.

const props = withDefaults(
  defineProps<{
    bot: AgentBot;
    /** Diameter, in px. */
    size?: number;
    /** Turn toward the pointer as it comes near. */
    follow?: boolean;
    /** Something is covering it — hold still rather than tracking a pointer
     *  nobody can see it react to. */
    covered?: boolean;
    ariaLabel?: string;
  }>(),
  { size: 55, follow: true, covered: false, ariaLabel: "" },
);

const host = ref<HTMLElement | null>(null);
/** Degrees off the expression's own gaze. Zero is the bot exactly as the maker
 *  left it, which is where it sits until a pointer comes near. */
const aim = ref<{ yaw: number; pitch: number } | null>(null);

/** How far the head will turn. Enough to read at bead size and no further: past
 *  this the eyes ride the limb of the sphere and start to disappear, which reads
 *  as a bot looking away rather than at you. */
const YAW = 16;
const PITCH = 12;
/** Full attention out to this many body radii; released by twice that, so a
 *  pointer crossing the far side of the window doesn't yank the head about. */
const NEAR = 4;
const FAR = 11;

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

let queued = false;
let latest: { x: number; y: number } | null = null;
let reduced = false;

/** Resolved against the element's box at read time, not at move time: the
 *  composer grows and the page scrolls, and a gaze measured against where the
 *  bead used to be is a bot staring at nothing. */
function track() {
  queued = false;
  const el = host.value;
  const at = latest;
  if (!el || !at || !props.follow || props.covered || reduced) return;
  const rect = el.getBoundingClientRect();
  if (!rect.width) return;
  const r = Math.min(rect.width, rect.height) / 2;
  const dx = (at.x - (rect.left + rect.width / 2)) / r;
  const dy = (at.y - (rect.top + rect.height / 2)) / r;
  const dist = Math.hypot(dx, dy);
  const mix = 1 - clamp01((dist - NEAR) / (FAR - NEAR));
  if (mix <= 0) {
    aim.value = null;
    return;
  }
  // Past the near ring it is the direction that matters, not how far past it the
  // pointer has gone.
  const k = Math.max(1, dist);
  // Screen y runs down and pitch runs up, so the vertical term is inverted.
  aim.value = { yaw: (dx / k) * YAW * mix, pitch: (-dy / k) * PITCH * mix };
}

function onPointerMove(event: PointerEvent) {
  latest = { x: event.clientX, y: event.clientY };
  // One read per frame at most: a pointer sweep fires far more often than
  // anything can be drawn, and every read costs a layout.
  if (queued) return;
  queued = true;
  requestAnimationFrame(track);
}

const mark = computed(() =>
  botMark(props.bot, props.covered || !aim.value ? undefined : aim.value),
);

let media: MediaQueryList | null = null;
const onEnv = () => {
  reduced = media?.matches ?? false;
  // Back to the resting gaze rather than frozen mid-turn, which would leave a bot
  // permanently looking at where a pointer once was.
  if (reduced) aim.value = null;
};

onMounted(() => {
  media = window.matchMedia("(prefers-reduced-motion: reduce)");
  reduced = media.matches;
  media.addEventListener("change", onEnv);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
});

onBeforeUnmount(() => {
  media?.removeEventListener("change", onEnv);
  window.removeEventListener("pointermove", onPointerMove);
});
</script>

<template>
  <!-- The mark is inlined rather than sourced, so it paints in the same frame
       the bot changes in and carries no request or id with it. -->
  <span
    ref="host"
    class="bot-bead"
    :style="{ width: `${size}px`, height: `${size}px` }"
    :role="ariaLabel ? 'img' : undefined"
    :aria-label="ariaLabel || undefined"
    :aria-hidden="ariaLabel ? undefined : 'true'"
    v-html="mark"
  />
</template>

<style scoped>
.bot-bead {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.bot-bead :deep(svg) {
  display: block;
  width: 100%;
  height: 100%;
  /* The outline's smoothing bulges a hair past the tile; clipping it would flatten
     the widest shapes against their own edge. */
  overflow: visible;
}
</style>
