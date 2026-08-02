<script setup lang="ts">
// The "dynamic island" — a soft pill that perches bottom-right whenever a turn
// is still running after you've stepped back out of its thread. Two rows of
// fixed lanes, so nothing ever jumps:
//
//   (orb)  ⌜logo⌝ Thread title           2/5  12s
//          Wiring the pill stack   • Reading useAgent.ts   (×)
//
// Nothing is shown by default — each part has to earn its place:
//   · the overline    once the thread has a name (until then it's one line)
//   · the counter     once a plan has more than one task
//   · the clock       once a running turn passes 15s, and gone again the moment
//                     it settles, where the outcome word is the whole story
//   · the tool lane   only for a genuinely named tool call beside a task
//   · the ×           only on hover, taking over the count/clock's slot
//
// The pill holds one height and one of two widths — narrow, or wide enough for
// a task and its tool call — and eases between them the once a plan appears.
// Nothing else resizes it: streaming text and the ticking clock only ellipsise
// inside their lanes. Click it to drop back into the conversation; the ×
// dismisses it, running or settled.
//
// Purely presentational — it reads the running assistant block and derives the
// activity through the same vocabulary the thread's step rows use, so the two
// never disagree.
import { computed } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Tick02Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import type { AssistantBlock } from "~/composables/useAgent";
import type { BrandKey } from "~/utils/modelCatalog";
import { stateForToolFamily, type TurnOrbState } from "~/utils/thinkingOrb";
import { describeTurnActivity } from "~/utils/turnActivity";
import type { ActivePlanTask } from "~/utils/planTasks";

const props = defineProps<{
  /** The running assistant turn, or null when nothing is in flight. */
  block: AssistantBlock | null;
  /** The thread's working title — the pill's identity, shown as a quiet overline
   *  so you know *which* conversation is cooking while you're away from it. */
  threadTitle?: string;
  /** Vendor logomark of the thread's model — a quiet cue to whose turn it is. */
  brand?: BrandKey;
  /** The checklist row the thread is on, when it has a plan. It outranks the
   *  moment-to-moment tool status as the pill's headline — "Wiring the pill
   *  stack" says more from across the app than "Reading useAgent.ts". */
  task?: ActivePlanTask | null;
  /** Ticking clock from useAgent so the elapsed count creeps up live. */
  now: number;
}>();

// The identity overline — a trimmed title, or nothing (the pill falls back to a
// single status line until the thread earns a name).
const threadLabel = computed(() => props.threadTitle?.trim() || "");

const emit = defineEmits<{ open: []; dismiss: [] }>();

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

// A settled turn's headline is its outcome ("Replied"), never a stale task —
// the plan only speaks while the turn is still running.
const liveTask = computed(() =>
  activity.value && activity.value.orb !== "done" ? (props.task ?? null) : null,
);

// The headline: the task the thread is working when it has a plan, otherwise the
// moment's activity. The orb keeps carrying the tool family either way.
const headline = computed(() => liveTask.value?.label ?? activity.value?.label ?? "");

// The second lane — the live tool call beside the task. Only a *named* tool
// earns it: "Wiring the pill • Thinking" would just be the pill talking to
// itself, so during thinking and quiet stretches the task stands alone.
const toolLine = computed(() =>
  liveTask.value && activity.value?.orb === "tool" ? activity.value.label : "",
);

// "3/5" — how far into the checklist this thread is. A one-item plan isn't
// progress, so it doesn't get a counter.
const progress = computed(() => {
  const t = liveTask.value;
  return t && t.total > 1 ? `${t.index}/${t.total}` : "";
});

// Seconds since the turn started (frozen at its final duration once settled).
const seconds = computed(() => {
  const b = props.block;
  if (!b) return 0;
  return Math.max(0, Math.round(((b.endedAt ?? props.now) - b.at) / 1000));
});

const elapsed = computed(() => {
  const s = seconds.value;
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const rest = s % 60;
  return rest ? `${m}m ${rest}s` : `${m}m`;
});

// The clock is for waiting, not for reporting. It appears only once a running
// turn has been away long enough that "how long has this been going?" is a real
// question — and it leaves the moment the turn settles, where the outcome word
// is the whole story.
const CLOCK_AFTER_SECONDS = 15;
const showClock = computed(
  () => props.block?.state === "running" && seconds.value >= CLOCK_AFTER_SECONDS,
);

// Without a title there's nothing to put on an overline, so the pill drops to a
// single centred line rather than balancing a lone status over empty space.
const hasOverline = computed(() => !!threadLabel.value);
</script>

<template>
  <AnimatePresence>
    <motion.div
      v-if="activity"
      class="turn-pill-wrap"
      :initial="{ opacity: 0, y: 18, scale: 0.92 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :exit="{ opacity: 0, y: 14, scale: 0.94 }"
      :transition="{ type: 'spring', stiffness: 210, damping: 30, mass: 0.9 }"
    >
      <button
        type="button"
        class="turn-pill"
        :class="{ 'turn-pill--tasked': !!liveTask, 'turn-pill--bare': !hasOverline }"
        :style="{ '--hue': activity.hue ?? 'var(--muted)' }"
        aria-live="polite"
        :aria-label="`${threadLabel ? `${threadLabel}: ` : ''}${headline}${
          progress ? ` — task ${progress}` : ''
        }${toolLine ? `. ${toolLine}` : ''} — ${elapsed}. Back to the conversation.`"
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
              <TurnOrb v-if="orbState" :state="orbState" :size="28" :aria-label="activity.label" />
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
                  :transition="{
                    type: 'spring',
                    stiffness: 460,
                    damping: 22,
                    mass: 0.6,
                    delay: 0.06,
                  }"
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

        <!-- Nothing here is unconditional. The overline appears once the thread
             has a name; the counter once a plan has more than one task; the clock
             once a running turn has been away long enough to wonder about; the
             tool lane only for a genuinely named tool call. Everything fades in
             its own fixed slot, so appearing costs no layout. -->
        <span class="turn-pill__text">
          <span v-if="hasOverline" class="turn-pill__row">
            <ProviderLogo v-if="brand" class="turn-pill__brand" :brand="brand" :size="13" />
            <span class="turn-pill__title">{{ threadLabel }}</span>

            <!-- The meta slot is shared: it carries the count and clock at rest,
                 and steps aside for the dismiss × on hover. Sharing one slot is
                 what keeps the pill from reserving a lane for a button that's
                 invisible most of its life. -->
            <span class="turn-pill__meta">
              <Transition name="meta">
                <span v-if="progress" class="turn-pill__count">{{ progress }}</span>
              </Transition>
              <Transition name="meta">
                <span v-if="showClock" class="turn-pill__time">{{ elapsed }}</span>
              </Transition>
            </span>
          </span>

          <!-- A quick opacity swap in "wait" mode: the outgoing line leaves before
               the incoming one lands, so a status change is a clean crossfade with
               no layout projection (that was the old jitter). -->
          <span class="turn-pill__row">
            <span class="turn-pill__lane">
              <AnimatePresence mode="wait">
                <motion.span
                  :key="headline"
                  class="turn-pill__label"
                  :class="
                    activity.orb === 'done' ? `turn-pill__label--${activity.tone ?? 'ok'}` : ''
                  "
                  :initial="{ opacity: 0, y: 3 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -3 }"
                  :transition="{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }"
                >
                  {{ headline }}
                </motion.span>
              </AnimatePresence>
            </span>

            <span v-if="toolLine" class="turn-pill__lane turn-pill__lane--tool">
              <span class="turn-pill__tool-dot" />
              <AnimatePresence mode="wait">
                <motion.span
                  :key="toolLine"
                  class="turn-pill__tool"
                  :initial="{ opacity: 0, y: 3 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -3 }"
                  :transition="{ duration: 0.19, ease: [0.22, 1, 0.36, 1] }"
                >
                  {{ toolLine }}
                </motion.span>
              </AnimatePresence>
            </span>
          </span>
        </span>
      </button>

      <!-- Dismiss — send the pill away without opening the thread (the turn keeps
           running; you just stop being told about it). A sibling of the pill, not
           a nested button, and it takes over the meta slot on hover rather than
           holding a lane of its own. -->
      <button
        type="button"
        class="turn-pill__close"
        :class="{ 'turn-pill__close--bare': !hasOverline }"
        aria-label="Dismiss this status pill"
        @click.stop="emit('dismiss')"
      >
        <HugeiconsIcon :icon="Cancel01Icon" :size="13" :stroke-width="2.2" />
      </button>
    </motion.div>
  </AnimatePresence>
</template>

<style scoped>
/* The wrapper holds the pill and its dismiss button together, so the × can sit
   over the pill's right edge without being a button inside a button. */
.turn-pill-wrap {
  /* Positioned by the .pill-stack container in ProjectView (one pill per
     off-screen thread); the stack disables pointer events, so re-enable them
     here — only the pills themselves are clickable, not the gaps between. */
  pointer-events: auto;
  position: relative;
  display: inline-block;
}

/* A quiet capsule in the corner — a raised sliver of the ground, no elevation of
   its own. It rides above the folder / composer chrome without ever crowding
   them. */
.turn-pill {
  display: flex;
  align-items: center;
  gap: 11px;
  /* The pill has two widths and nothing in between: narrow, and wide enough to
     carry a task and its tool call. Text ellipsises inside them rather than
     pushing the box around, so streaming status and the ticking clock never
     resize it — the constant twitching was the worst of the old pill. The one
     real change (a plan appearing) eases across. */
  width: min(15.5rem, calc(100vw - 4rem));
  /* One height too — the same two rows whether or not there's a plan. */
  height: 52px;
  padding: 0 14px 0 9px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ground) 88%, var(--ink) 5%);
  /* Clip so a crossfading previous line (briefly overlaid) dissolves inside the
     capsule instead of spilling past it. */
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  transition:
    width 0.4s cubic-bezier(0.22, 1, 0.36, 1),
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.25s ease;
}
.turn-pill--tasked {
  width: min(23rem, calc(100vw - 4rem));
}
/* Before a thread earns a title there's no overline, so the pill collapses to a
   single line — and the dismiss × moves to the middle of the right edge, which
   is the only place it can go, so that edge gets its lane back. */
.turn-pill--bare {
  height: 44px;
  padding-right: 30px;
}
.turn-pill:hover,
.turn-pill-wrap:focus-within .turn-pill {
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

/* The stacked identity + status column — it takes the rest of the pill, and each
   row clips inside it. */
.turn-pill__text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  flex: 1;
  min-width: 0;
}

/* Both rows share one shape: a flex line whose cells clip rather than grow. */
.turn-pill__row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
/* The status row hangs together as one phrase, so it aligns on the baseline and
   sits tight under the overline. */
.turn-pill__row + .turn-pill__row {
  align-items: baseline;
}
.turn-pill__brand {
  display: inline-flex;
  align-items: center;
  flex: none;
  opacity: 0.65;
}
/* Identity — quiet, one line, ellipsised. It names the thread without ever
   competing with the live status below it. */
.turn-pill__title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.01em;
  color: var(--muted);
}
/* The shared right-hand slot: count + clock at rest, the dismiss × on hover. It
   fades as a whole so the two never fight for the same pixels. */
.turn-pill__meta {
  display: flex;
  align-items: baseline;
  gap: 6px;
  flex: none;
  transition:
    opacity 0.2s ease,
    transform 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.turn-pill-wrap:hover .turn-pill__meta,
.turn-pill-wrap:focus-within .turn-pill__meta {
  opacity: 0;
  transform: translateX(4px);
}

/* Checklist position — a quiet "3/5" beside the clock, so the pill says how far
   in the thread is without spending a line on it. */
.turn-pill__count {
  flex: none;
  font-family: var(--font-mono);
  font-size: 10px;
  font-variant-numeric: tabular-nums;
  color: color-mix(in srgb, var(--muted) 75%, transparent);
}
.turn-pill__time {
  flex: none;
  /* A fixed slot, right-aligned, so a ticking count (16s → 1m 5s) can't nudge
     the title beside it. */
  min-width: 4.2ch;
  text-align: right;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

/* The status row reads as one flowing line — the task, then the live tool call
   trailing quietly behind it. The task holds its ground and the tool call gives
   way first, so a long tool target clips instead of squeezing the headline. */
.turn-pill__lane {
  display: flex;
  align-items: baseline;
  gap: 5px;
  flex: 1 1 auto;
  min-width: 0;
  height: 18px;
}
/* The tool call gets a fixed slot rather than a share of the row, so the task
   keeps every pixel it can and one long file path can't shove it aside. */
.turn-pill__lane--tool {
  flex: none;
  width: 7.6rem;
}
.turn-pill__label,
.turn-pill__tool {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.turn-pill__label {
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.012em;
  color: var(--ink);
}
.turn-pill__label--error {
  color: var(--diff-del);
}
.turn-pill__label--muted {
  color: var(--muted);
}
/* The live tool call beside the task — subordinate, led by a dot in the tool's
   family hue so it echoes the orb without shouting. */
.turn-pill__tool {
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.004em;
  color: color-mix(in srgb, var(--muted) 85%, transparent);
}
.turn-pill__tool-dot {
  flex: none;
  align-self: center;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--hue, var(--muted));
  opacity: 0.85;
}

/* Dismiss — a small ghost × that takes the meta slot's place on hover. It costs
   the resting pill nothing: no reserved lane, no visible chrome, and revealing
   it shifts nothing because the slot it lands in was already there. */
.turn-pill__close {
  position: absolute;
  /* Sits on the overline's optical centre — the slot it's taking over — rather
     than drifting into the gap between the two rows. */
  top: 7px;
  right: 10px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  padding: 0;
  border: 0;
  border-radius: 50%;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  opacity: 0;
  transform: translateX(4px);
  transition:
    opacity 0.22s ease,
    transform 0.26s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.2s ease,
    color 0.2s ease;
}
/* On the single-line pill there's no overline to sit in, so it centres instead. */
.turn-pill__close--bare {
  top: 50%;
  margin-top: -10px;
}
.turn-pill-wrap:hover .turn-pill__close,
.turn-pill__close:focus-visible {
  opacity: 1;
  transform: translateX(0);
}

/* Count and clock arriving: a soft fade in place, never a jump. */
.meta-enter-active,
.meta-leave-active {
  transition:
    opacity 0.28s ease,
    transform 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.meta-enter-from,
.meta-leave-to {
  opacity: 0;
  transform: translateY(-2px);
}
.turn-pill__close:hover {
  color: var(--ink);
  background: color-mix(in oklab, var(--ink) 9%, transparent);
}
.turn-pill__close:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hue, var(--accent)) 70%, transparent);
  outline-offset: 1px;
}

@media (prefers-reduced-motion: reduce) {
  .turn-pill,
  .turn-pill__meta,
  .turn-pill__close,
  .meta-enter-active,
  .meta-leave-active {
    transition: none;
  }
  .turn-pill__close,
  .meta-enter-from,
  .meta-leave-to {
    transform: none;
  }
}
</style>
