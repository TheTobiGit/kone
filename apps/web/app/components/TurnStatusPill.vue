<script setup lang="ts">
// The "dynamic island" — a soft pill that perches bottom-right whenever a turn
// is still running after you've stepped back out of its thread. It carries the
// turn's live orb at the left (thinking / a tool family / the working band) and
// a one-line status that tracks the current activity: "Reading example.vue",
// "Searching for foo", "Editing example.md", "Thinking", "Working". Click it to
// drop straight back into the conversation.
//
// Purely presentational — it reads the running assistant block and derives the
// activity through the same vocabulary the thread's step rows use, so the two
// never disagree.
import { computed } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Tick02Icon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import type { AssistantBlock } from "~/composables/useAgent";
import type { BrandKey } from "~/utils/modelCatalog";
import { stateForToolFamily, type TurnOrbState } from "~/utils/thinkingOrb";
import { describeTurnActivity } from "~/utils/turnActivity";

const props = defineProps<{
  /** The running assistant turn, or null when nothing is in flight. */
  block: AssistantBlock | null;
  /** The thread's working title — the pill's identity, shown as a quiet overline
   *  so you know *which* conversation is cooking while you're away from it. */
  threadTitle?: string;
  /** Vendor logomark of the thread's provider — a quiet cue to whose turn it is. */
  brand?: BrandKey;
  /** Ticking clock from useAgent so the elapsed count creeps up live. */
  now: number;
}>();

// The identity overline — a trimmed title, or nothing (the pill falls back to a
// single status line until the thread earns a name).
const threadLabel = computed(() => props.threadTitle?.trim() || "");

const emit = defineEmits<{ open: [] }>();

const activity = computed(() => describeTurnActivity(props.block));

// The live orb's state — null while the turn is settled (a `done` badge shows
// instead). Mirrors the thread's family → motion mapping.
const orbState = computed<TurnOrbState | null>(() => {
  const a = activity.value;
  if (!a || a.orb === "done") return null;
  if (a.orb === "thinking") return "thinking";
  if (a.orb === "working") return "working";
  return stateForToolFamily(a.family);
});

// A stable identity for the current orb visual — changing it crossfades the orb
// (thinking → a tool → working → the settled badge) the same way the label swaps.
const orbKey = computed(() => orbState.value ?? `done-${activity.value?.tone ?? "ok"}`);

// The settled badge is a solid tinted disc — a plain scale-in reads as a pop, so
// it gets a softer spring landing (little scale, no overshoot) while the live
// canvas orbs keep their light, quick crossfade.
const orbIsDone = computed(() => activity.value?.orb === "done");
const orbInitial = computed(() =>
  orbIsDone.value ? { opacity: 0, scale: 0.86 } : { opacity: 0, scale: 0.7 },
);
const orbTransition = computed(() =>
  orbIsDone.value
    ? { type: "spring", stiffness: 320, damping: 26, mass: 0.7 }
    : { duration: 0.24, ease: [0.22, 1, 0.36, 1] },
);

const elapsed = computed(() => {
  const b = props.block;
  if (!b) return "";
  // A settled turn freezes at its final duration; a live one keeps counting.
  const end = b.endedAt ?? props.now;
  const secs = Math.max(0, Math.round((end - b.at) / 1000));
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return s ? `${m}m ${s}s` : `${m}m`;
});
</script>

<template>
  <AnimatePresence>
    <motion.button
      v-if="activity"
      type="button"
      class="turn-pill"
      :style="{ '--hue': activity.hue ?? 'var(--muted)' }"
      aria-live="polite"
      :aria-label="`${activity.label} — ${elapsed}. Back to the conversation.`"
      :initial="{ opacity: 0, y: 18, scale: 0.92 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :exit="{ opacity: 0, y: 14, scale: 0.94 }"
      :transition="{ type: 'spring', stiffness: 210, damping: 30, mass: 0.9 }"
      @click="emit('open')"
    >
      <!-- The turn's orb, sized up — the pill's clearest signal at a glance.
           Layers crossfade in a fixed-size box (absolute + sync mode), so the
           orb morphs smoothly from one state to the next with no layout shift. -->
      <span class="turn-pill__orb">
        <AnimatePresence>
          <motion.span
            :key="orbKey"
            class="turn-pill__orb-layer"
            :initial="orbInitial"
            :animate="{ opacity: 1, scale: 1 }"
            :exit="{ opacity: 0, scale: 0.7 }"
            :transition="orbTransition"
          >
            <TurnOrb
              v-if="orbState"
              :state="orbState"
              :size="28"
              :aria-label="activity.label"
            />
            <!-- Settled — a quiet badge: a check for a finished reply, a tinted
                 dot for a failed / stopped one. The glyph springs in a touch
                 after the disc so it settles rather than snapping. -->
            <span
              v-else
              class="turn-pill__done"
              :class="`turn-pill__done--${activity.tone ?? 'ok'}`"
            >
              <motion.span
                class="turn-pill__done-glyph"
                :initial="{ opacity: 0, scale: 0.4 }"
                :animate="{ opacity: 1, scale: 1 }"
                :transition="{ type: 'spring', stiffness: 460, damping: 22, mass: 0.6, delay: 0.06 }"
              >
                <HugeiconsIcon
                  v-if="(activity.tone ?? 'ok') === 'ok'"
                  :icon="Tick02Icon"
                  :size="18"
                  :stroke-width="2.4"
                />
                <span v-else class="turn-pill__dot" />
              </motion.span>
            </span>
          </motion.span>
        </AnimatePresence>
      </span>

      <!-- A stacked column: the thread's title as a quiet overline (the pill's
           identity — which conversation this is), the live status beneath it. -->
      <span class="turn-pill__text">
        <span v-if="threadLabel" class="turn-pill__title">{{ threadLabel }}</span>
        <span class="turn-pill__body">
          <!-- A quick opacity swap in "wait" mode: no layout projection (which
               shook as the per-second timer changed the pill's width), just a
               clean, fast crossfade of the status text. -->
          <AnimatePresence mode="wait">
            <motion.span
              :key="activity.label"
              class="turn-pill__label"
              :class="activity.orb === 'done' ? `turn-pill__label--${activity.tone ?? 'ok'}` : ''"
              :initial="{ opacity: 0, y: 3 }"
              :animate="{ opacity: 1, y: 0 }"
              :exit="{ opacity: 0, y: -3 }"
              :transition="{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }"
            >
              {{ activity.label }}
            </motion.span>
          </AnimatePresence>
          <span class="turn-pill__time">{{ elapsed }}</span>
        </span>
      </span>

      <ProviderLogo v-if="brand" class="turn-pill__brand" :brand="brand" :size="15" />
    </motion.button>
  </AnimatePresence>
</template>

<style scoped>
/* A quiet capsule in the corner — a raised sliver of the ground, no elevation of
   its own. It rides above the folder / composer chrome without ever crowding
   them. */
.turn-pill {
  /* Positioned by the .pill-stack container in ProjectView (one pill per
     off-screen thread); the stack disables pointer events, so re-enable them
     here — only the pills themselves are clickable, not the gaps between. */
  pointer-events: auto;

  display: inline-flex;
  align-items: center;
  gap: 11px;
  max-width: min(22rem, calc(100vw - 4rem));
  padding: 7px 16px 7px 10px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ground) 88%, var(--ink) 5%);
  /* The pill sizes to its current status; clip so a crossfading previous status
     (briefly overlaid) dissolves inside the capsule instead of spilling past it.
     Safe now that width just snaps — no box animation to fight the clip. */
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.25s ease;
}
.turn-pill:hover {
  transform: translateY(-2px);
  background: color-mix(in oklab, var(--ground) 82%, var(--ink) 7%);
}
.turn-pill:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hue, var(--accent)) 70%, transparent);
  outline-offset: 2px;
}

.turn-pill__orb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 32px;
  height: 32px;
}
/* Each orb state occupies the same centered slot, so the outgoing and incoming
   orbs overlap and crossfade rather than shoving each other around. */
.turn-pill__orb-layer {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.turn-pill__done-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
/* Settled badge — a soft-tinted disc holding the check / dot. */
.turn-pill__done {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 30px;
  height: 30px;
  border-radius: 50%;
}
.turn-pill__done--ok {
  color: var(--diff-add);
  background: color-mix(in srgb, var(--diff-add) 14%, transparent);
}
.turn-pill__done--error {
  color: var(--diff-del);
  background: color-mix(in srgb, var(--diff-del) 14%, transparent);
}
.turn-pill__done--muted {
  color: var(--muted);
  background: color-mix(in srgb, var(--muted) 16%, transparent);
}
.turn-pill__dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: currentColor;
}

/* The stacked identity + status column. */
.turn-pill__text {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
/* Identity overline — quiet, one line, ellipsised. It names the thread without
   ever competing with the live status below it. */
.turn-pill__title {
  max-width: 13.5rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.01em;
  color: var(--muted);
}
.turn-pill__body {
  position: relative;
  display: flex;
  align-items: baseline;
  gap: 8px;
  min-width: 0;
}
.turn-pill__label--error {
  color: var(--diff-del);
}
.turn-pill__label--muted {
  color: var(--muted);
}
.turn-pill__label {
  display: inline-block;
  min-width: 0;
  max-width: 12.5rem;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-sans);
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.012em;
  color: var(--ink);
}
.turn-pill__time {
  flex: none;
  /* Right-aligned in a fixed slot so a ticking count (9s → 10s → 1m 5s) never
     reflows the pill's width — the source of the per-second jitter. */
  min-width: 2.4ch;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.turn-pill__brand {
  display: inline-flex;
  align-items: center;
  flex: none;
  opacity: 0.7;
}

@media (prefers-reduced-motion: reduce) {
  .turn-pill {
    transition: none;
  }
}
</style>
