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
import type { AssistantBlock } from "~/composables/useAgent";
import { stateForToolFamily, type TurnOrbState } from "~/utils/thinkingOrb";
import { describeTurnActivity } from "~/utils/turnActivity";

const props = defineProps<{
  /** The running turn. A settled one renders nothing — its reply is the story. */
  block: AssistantBlock;
  /** Ticking clock from useAgent, so the elapsed count creeps up live. */
  now: number;
}>();

const activity = computed(() => describeTurnActivity(props.block));

const orbState = computed<TurnOrbState | null>(() => {
  const a = activity.value;
  if (!a || a.orb === "done") return null;
  if (a.orb === "thinking") return "thinking";
  if (a.orb === "working") return "working";
  return stateForToolFamily(a.family);
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
</script>

<template>
  <div v-if="activity && orbState" class="status" role="status" aria-live="polite">
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
          <TurnOrb :state="orbState" :size="22" :aria-label="activity.label" />
        </motion.span>
      </AnimatePresence>
    </span>

    <span class="status__lane">
      <AnimatePresence mode="wait">
        <motion.span
          :key="activity.label"
          class="status__label"
          :initial="{ opacity: 0, y: 3 }"
          :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, y: -3 }"
          :transition="{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }"
        >
          {{ activity.label }}
        </motion.span>
      </AnimatePresence>
    </span>

    <Transition name="clock">
      <span v-if="showClock" class="status__time">{{ elapsed }}</span>
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
  width: 22px;
  height: 22px;
}
.status__orb-layer {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
}

/* The label lane clips rather than grows: a status crossfading to a longer one
   must not widen the line mid-sentence. */
.status__lane {
  position: relative;
  flex: 1;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
}
.status__label {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.86rem;
  color: color-mix(in oklab, var(--ink) 62%, transparent);
}

.status__time {
  flex: none;
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
</style>
