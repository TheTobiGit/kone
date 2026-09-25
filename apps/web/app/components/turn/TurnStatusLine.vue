<script setup lang="ts">
// A running turn, said in one line — the whole of what a quiet transcript shows
// while the agent works.
//
// The quiet reading of a thread never opens the agent's work: no step rows, no
// thinking, no streaming narration. But "nothing" is not an honest picture of a
// turn that is running, so the turn keeps a single sentence — the orb it is
// carrying and the thing it is doing right now ("Reading useAgent.ts",
// "Thinking", "Working"), with the clock joining once the wait is long enough to
// be a question. When the turn settles this line goes away and the reply takes
// its place.
//
// The vocabulary is the pill's, through the same `describeTurnActivity`, so a
// thread says the same thing about itself whether you are reading it or watching
// it from the corner of the app.

import { computed } from "vue";
import { motion, AnimatePresence } from "motion-v";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import RollingText from "~/components/ui/RollingText.vue";
import type { AssistantBlock } from "~/composables/useAgent";
import { type TurnOrbState } from "~/utils/thinkingOrb";
import { describeTurnActivity } from "~/utils/turnActivity";

const props = defineProps<{
  /** The running turn. A settled one renders nothing — its reply is the story. */
  block: AssistantBlock;
  /** Ticking clock from useAgent, so the elapsed count creeps up live. */
  now: number;
}>();

/** The orb's box, and with it the line's rhythm: the label lane and the clock
 *  take their height from the same number so text sits on the orb's optical
 *  centre rather than on a shorter line box beside it. The canvas needs it as a
 *  prop and the stylesheet as a length, so it is declared once here and handed
 *  to both. */
const ORB_PX = 22;

const activity = computed(() => describeTurnActivity(props.block));

const orbState = computed<TurnOrbState | null>(() => {
  const a = activity.value;
  if (!a || a.orb === "done") return null;
  return a.orbState;
});

const seconds = computed(() =>
  Math.max(0, Math.round((props.now - props.block.at) / 1000)),
);

const elapsed = computed(() => {
  const s = seconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
});

// The clock is for waiting, not for reporting: it earns its place only once the
// turn has been going long enough that "how long has this been?" is a real
// question.
const CLOCK_AFTER_SECONDS = 15;
const showClock = computed(() => seconds.value >= CLOCK_AFTER_SECONDS);

// One sentence replacing another in the same slot, with no direction to the
// change — a `fade-through`: the old label drops out quickly (260ms, 4px up),
// the new one rises in behind it (420ms), without the effect's usual 2px blur
// so the label stays crisp. The exit is the
// shorter half so a turn hopping between tools never waits on the old words.
const LABEL_ENTER_FROM = { opacity: 0, y: 6, scale: 0.99 };
const LABEL_ENTER_TO = { opacity: 1, y: 0, scale: 1 };
const LABEL_ENTER_TRANSITION = { duration: 0.42, ease: [0.2, 0, 0, 1] };
const LABEL_EXIT = {
  opacity: 0,
  y: -4,
  transition: { duration: 0.26, ease: [0.4, 0, 1, 1] },
};
</script>

<template>
  <div
    v-if="activity && orbState"
    class="status"
    role="status"
    aria-live="polite"
    :style="{ '--orb-size': `${ORB_PX}px` }"
  >
    <!-- Fixed-size box: the orb crossfades between states in place, so a turn
         moving from thinking to a tool never nudges the line. -->
    <span class="status__orb">
      <AnimatePresence>
        <motion.span
          :key="orbState"
          class="status__orb-layer"
          :initial="{ opacity: 0, scale: 0.7 }"
          :animate="{ opacity: 1, scale: 1 }"
          :exit="{ opacity: 0, scale: 0.7 }"
          :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
        >
          <TurnOrb :state="orbState" :size="ORB_PX" :aria-label="activity.label" />
        </motion.span>
      </AnimatePresence>
    </span>

    <span class="status__lane">
      <AnimatePresence mode="wait">
        <motion.span
          :key="activity.label"
          class="status__label"
          :initial="LABEL_ENTER_FROM"
          :animate="LABEL_ENTER_TO"
          :exit="LABEL_EXIT"
          :transition="LABEL_ENTER_TRANSITION"
        >
          {{ activity.label }}
        </motion.span>
      </AnimatePresence>
    </span>

    <Transition name="clock">
      <RollingText v-if="showClock" class="status__time" :text="elapsed" />
    </Transition>
  </div>
</template>

<style scoped>
.status {
  display: flex;
  align-items: center;
  gap: 10px;
  min-height: 26px;
  padding: 2px 0;
  --hue: var(--muted);
}

.status__orb {
  position: relative;
  flex: none;
  width: var(--orb-size);
  height: var(--orb-size);
}
.status__orb-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* The label lane clips rather than grows: a status crossfading to a longer one
   must not widen the line mid-sentence. It is also a flex line as tall as the
   orb, so the label shares the orb's optical centre instead of centring a
   shorter normal line box against it. */
.status__lane {
  position: relative;
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
  min-height: var(--orb-size);
  overflow: hidden;
  white-space: nowrap;
}
.status__label {
  display: block;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.86rem;
  line-height: var(--orb-size);
  color: color-mix(in oklab, var(--ink) 62%, transparent);
}

.status__time {
  flex: none;
  display: inline-flex;
  align-items: center;
  line-height: var(--orb-size);
  white-space: nowrap;
  font-size: 0.76rem;
  font-variant-numeric: tabular-nums;
  color: color-mix(in oklab, var(--ink) 38%, transparent);
}

.clock-enter-active,
.clock-leave-active {
  transition: opacity 0.22s ease;
}
.clock-enter-from,
.clock-leave-to {
  opacity: 0;
}

@media (prefers-reduced-motion: reduce) {
  .clock-enter-active,
  .clock-leave-active {
    transition: none;
  }
}
</style>
