<script lang="ts">
// How long a wait sits before its orb escalates from pastille to "!".
export const ATTENTION_STALE_AFTER_MS = 30_000;
</script>

<script setup lang="ts">
// The global needs-a-human row: every parked thread in the app, one bot each,
// pinned top-right of the screen over whatever surface is showing.
//
// Two feeds merge here: resident parked asks from every project registry, and
// headless spawned-child approvals carrying their project's route. Threads
// already in front of the user report themselves inline (the studio's focused
// column, the inbox's reading pane) and are skipped — their ask answers in
// place, so no bot is needed.
//
// Each bot IS one waiting thread. A lone bot sits at the corner; when another
// thread parks, its bot joins beside it, and the row grows left from the
// corner. A wait wears the pastille (`notify`) while fresh; once it sits
// unanswered past ATTENTION_STALE_AFTER_MS its orb escalates to the "!"
// (`exclaim`). First-seen stamps are seeded when a key appears, dropped when
// it clears, never persisted — a reload re-seeds from the live feed, so a
// resumed wait starts fresh rather than inheriting a stamp from before the
// restart. The component owns its own 1s ticking clock, run only while bots
// are up.
//
// Picking a bot is a jump, not an answer: the component emits the project and
// the thread, and the page summons the inbox onto it, where the real ask
// waits. The native tooltip names the thread and its ask.
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import BloubOrb from "~/components/orb/BloubOrb.vue";
import { childApprovalsInbox } from "~/composables/agentPrefetch";
import { inlineThreadIds, liveAttention } from "~/composables/useAgent";
import type { ThreadAttentionKind } from "~/composables/useAgent";

const emit = defineEmits<{
  open: [projectPath: string, threadId: string];
}>();

type BotItem = {
  key: string;
  threadId: string;
  title: string;
  kind: ThreadAttentionKind;
  detail?: string;
  projectPath: string;
  /** Fresh waits wear the pastille; a stale one escalates this bot's orb. */
  orbState: "notify" | "exclaim";
};

type RawBot = Omit<BotItem, "orbState">;

const raw = computed<RawBot[]>(() => {
  const skipped = inlineThreadIds.value;
  const out: RawBot[] = [];
  for (const t of liveAttention.value) {
    if (skipped.has(t.threadId)) continue;
    out.push({
      key: t.key,
      threadId: t.threadId,
      title: t.title,
      kind: t.kind,
      detail: t.detail,
      projectPath: t.projectPath,
    });
  }
  for (const [childId, pending] of childApprovalsInbox.value) {
    // Route-less entries (recorded before the route was kept) answer in place
    // only — without a project there is nowhere to jump to. Every entry here
    // is a genuine headless spawned child (top-level threads with no session
    // wait in the orphan-approval pen until claimed), so the spawned label
    // below is exact, never a misfiled top-level thread.
    if (!pending.projectPath) continue;
    if (skipped.has(childId)) continue;
    out.push({
      key: `spawn:${childId}`,
      threadId: childId,
      title: "Spawned thread",
      kind: "parked-spawn",
      detail: pending.approval.title,
      projectPath: pending.projectPath,
    });
  }
  return out;
});

// When each wait was first seen, keyed by the item key.
const since = ref<Record<string, number>>({});
watch(
  () => raw.value.map((b) => b.key),
  (list) => {
    const at = Date.now();
    const live = new Set(list);
    const next = { ...since.value };
    let touched = false;
    for (const key of live) {
      if (next[key] === undefined) {
        next[key] = at;
        touched = true;
      }
    }
    for (const key of Object.keys(next)) {
      if (!live.has(key)) {
        delete next[key];
        touched = true;
      }
    }
    if (touched) since.value = next;
  },
  { immediate: true },
);

// Ticking clock for the staleness escalation — runs only while bots are up,
// the same 1s cadence as the agent clock.
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | null = null;
function stopClock(): void {
  if (timer !== null) {
    clearInterval(timer);
    timer = null;
  }
}
watch(
  () => raw.value.length > 0,
  (up) => {
    stopClock();
    if (up && import.meta.client) {
      now.value = Date.now();
      timer = setInterval(() => {
        now.value = Date.now();
      }, 1000);
    }
  },
  { immediate: true },
);
onBeforeUnmount(stopClock);

/** The orb a wait wears right now — pastille fresh, "!" once stale. */
function orbState(key: string, at: number): "notify" | "exclaim" {
  const seen = since.value[key];
  if (seen === undefined) return "notify";
  return at - seen > ATTENTION_STALE_AFTER_MS ? "exclaim" : "notify";
}

const bots = computed<BotItem[]>(() =>
  raw.value.map((b) => ({ ...b, orbState: orbState(b.key, now.value) })),
);

const KIND_HEADLINE = {
  permission: "Needs your permission",
  question: "Waiting on your answer",
  "parked-spawn": "A spawned thread is parked",
} satisfies Record<ThreadAttentionKind, string>;

function botLabel(a: BotItem): string {
  const headline = KIND_HEADLINE[a.kind];
  const title = a.title.trim();
  return `${title ? `${title}: ` : ""}${headline}${a.detail ? ` — ${a.detail}` : ""}. Open the conversation.`;
}

function onOpen(threadId: string): void {
  const hit = raw.value.find((b) => b.threadId === threadId);
  if (!hit) return;
  emit("open", hit.projectPath, threadId);
}
</script>

<template>
  <AnimatePresence>
    <motion.div
      v-if="bots.length"
      class="global-bots"
      :initial="{ opacity: 0, y: -8 }"
      :animate="{ opacity: 1, y: 0 }"
      :exit="{ opacity: 0, y: -8 }"
      :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
    >
      <motion.div
        class="bots"
        :initial="{ opacity: 0, y: 26, scale: 0.7 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 18, scale: 0.72 }"
        :transition="{ type: 'spring', stiffness: 200, damping: 26, mass: 1.1 }"
        role="group"
        aria-label="Threads waiting on you"
      >
        <AnimatePresence :initial="false">
          <motion.div
            v-for="a in bots"
            :key="a.key"
            layout
            class="bots__cell"
            :initial="{ opacity: 0, scale: 0.6 }"
            :animate="{ opacity: 1, scale: 1 }"
            :exit="{ opacity: 0, scale: 0.6 }"
            :transition="{ type: 'spring', stiffness: 260, damping: 26, mass: 0.9 }"
          >
            <button
              type="button"
              class="bots__orb"
              :aria-label="botLabel(a)"
              :title="botLabel(a)"
              @click="onOpen(a.threadId)"
            >
              <span class="bots__halo" aria-hidden="true" />
              <BloubOrb :state="a.orbState" :size="88" :aria-label="botLabel(a)" />
            </button>
          </motion.div>
        </AnimatePresence>
      </motion.div>
    </motion.div>
  </AnimatePresence>
</template>

<style scoped>
.global-bots {
  position: fixed;
  top: 20px;
  right: 20px;
  z-index: 60;
  display: flex;
  justify-content: flex-end;
  max-width: min(560px, calc(100vw - 40px));
  /* Only a rail for alignment; each bot takes its own clicks, and everything
     around the row belongs to the surface beneath. */
  pointer-events: none;
}

.bots {
  /* The row is only a rail for alignment; each bot takes its own clicks, and
     everything around the row belongs to the surface beneath. Right-aligned so
     the row grows left from the corner as threads park. */
  pointer-events: none;
  display: flex;
  flex-direction: row;
  align-items: flex-start;
  justify-content: flex-end;
  flex-wrap: wrap;
  gap: 14px;
  max-width: 100%;
}

.bots__cell {
  pointer-events: auto;
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

/* The button hugs the bloub's VISIBLE body — the drawn orb fills only the middle
   ~63% of its SVG box, so a 88px bloub reads as a ~55px marble, matching the
   composer's own resting orb. The SVG overflows this box; the box is what the
   halo pins to. */
.bots__orb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 55px;
  height: 55px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--ink);
  overflow: visible;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.bots__orb:hover {
  transform: translateY(-2px) scale(1.04);
}
.bots__orb:focus-visible {
  outline: none;
}
.bots__orb:focus-visible .bots__halo {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 55%, transparent);
}

/* A soft warm halo that breathes — the eye-catch. It never hardens into a ring;
   it's a low glow that swells and settles, the calm "over here" the corner pill
   could never give. */
.bots__halo {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--warn) 20%, transparent) 0%,
    transparent 72%
  );
  animation: bots-breathe 3.4s ease-in-out infinite;
}
@keyframes bots-breathe {
  0%,
  100% {
    transform: scale(0.96);
    opacity: 0.4;
  }
  50% {
    transform: scale(1.08);
    opacity: 0.66;
  }
}

@media (prefers-reduced-motion: reduce) {
  .bots__halo {
    animation: none;
    opacity: 0.5;
  }
  .bots__orb {
    transition: none;
  }
}
</style>
