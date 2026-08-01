<script setup lang="ts">
import { computed, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon } from "@hugeicons/core-free-icons";
import ActivityStep from "~/components/ActivityStep.vue";
import {
  activityEntries,
  segStreaming,
  segText,
  type ActivityEntry,
  type Segment,
} from "~/utils/conversationSegments";
import { toolMeta, type HugeIcon } from "~/utils/toolPresentation";
import { THINKING_ORB_HUE } from "~/utils/toolOrbDraw";

// ── Agent activity ─────────────────────────────────────────────────────────────
//
// One batch of thinking + tool calls, rendered inline — no header, no collapse.
// A batch has two lives:
//
//   • ACTIVE (still working) — up to five step rows show in full at once. When a
//     sixth arrives the oldest row slides up and fades, its icon filed into a
//     compact horizontal strip above the list; consecutive same-type actions
//     merge into one ×N chip so the strip stays tight across a long run. The
//     latest steps always stay in view at the bottom.
//
//   • DONE (the agent has moved on to streaming text, or the turn ended) — the
//     remaining rows fold up into the strip too, so a finished batch reads as a
//     single horizontal row of icons sitting above its result. The next batch of
//     tool calls opens a fresh window and repeats.
//
// For a short active batch (≤5 steps) there's no strip yet — it looks exactly
// like the plain inline step list it always was.

const props = defineProps<{
  segments: Segment[];
  /** Is the parent turn still running? */
  running: boolean;
  /** Is this the turn's final (tail) batch? A tail batch stays active through a
   *  quiet lull; a batch already overtaken by streamed text is done. */
  isTail?: boolean;
  /** Mount without entrance motion (a thread loaded from storage). */
  historical?: boolean;
}>();

const WINDOW = 5;
const SPRING = { type: "spring", stiffness: 420, damping: 34, mass: 0.9 } as const;

const entries = computed(() => activityEntries(props.segments));
const total = computed(() => entries.value.length);

// The batch is active while the turn runs and this is still its tail group. Once
// text streams after it (no longer the tail) or the turn ends, it is done.
const active = computed(() => props.running && props.isTail !== false);

// Active: the last five steps stay in view, everything earlier files to the
// strip. Done: nothing stays in view — every step goes to the strip.
const visible = computed(() => (active.value ? entries.value.slice(-WINDOW) : []));
const archived = computed(() =>
  active.value ? entries.value.slice(0, Math.max(0, total.value - WINDOW)) : entries.value,
);

type Glyph = { icon: HugeIcon; hue: string; label: string };
function glyphOf(e: ActivityEntry): Glyph {
  if (e.type === "thinking") return { icon: AiBrain01Icon, hue: THINKING_ORB_HUE, label: "Thinking" };
  const m = toolMeta(e.item.name);
  return { icon: m.icon, hue: m.hue, label: m.label };
}

type Chip = { key: string; icon: HugeIcon; hue: string; label: string; count: number };

// History strip — merge *consecutive* same-type actions into one ×N chip, keyed
// by the run's first entry so the element stays put while its count climbs (the
// count bumps rather than the chip being torn down and rebuilt).
const historyChips = computed<Chip[]>(() => {
  const out: Chip[] = [];
  for (const e of archived.value) {
    const g = glyphOf(e);
    const last = out[out.length - 1];
    if (last && last.label === g.label) last.count++;
    else out.push({ key: e.key, icon: g.icon, hue: g.hue, label: g.label, count: 1 });
  }
  return out;
});

// ── per-item timing (for a thinking row's "Thought for Xs") ─────────────────────
// Items carry no timestamps, so we clock them: first-seen and settle. A thinking
// segment's duration spans its earliest first-seen to its latest settle.
const seenAt = new Map<string, number>();
const doneAt = new Map<string, number>();
watch(
  () => props.segments.flatMap((s) => s.items.map((i) => `${i.itemId}:${i.status}`)).join(","),
  () => {
    const t = Date.now();
    for (const s of props.segments) {
      for (const it of s.items) {
        if (!seenAt.has(it.itemId)) seenAt.set(it.itemId, t);
        if ((it.status === "completed" || it.status === "failed") && !doneAt.has(it.itemId)) doneAt.set(it.itemId, t);
      }
    }
  },
  { immediate: true },
);
function thinkingDuration(seg: Segment): number | null {
  if (segStreaming(seg)) return null;
  const starts = seg.items.map((i) => seenAt.get(i.itemId)).filter((x): x is number => x != null);
  const ends = seg.items.map((i) => doneAt.get(i.itemId)).filter((x): x is number => x != null);
  if (!starts.length || !ends.length) return null;
  return Math.max(1, Math.round((Math.max(...ends) - Math.min(...starts)) / 1000));
}
function stepProps(e: ActivityEntry) {
  if (e.type !== "thinking") return {};
  return {
    streaming: segStreaming(e.seg),
    thinkingText: segText(e.seg),
    thinkingDuration: thinkingDuration(e.seg),
  };
}
</script>

<template>
  <motion.section class="activity" layout :transition="SPRING" aria-label="Agent activity">
    <!-- History strip — icons of steps that have slid out of the window. -->
    <div v-if="historyChips.length" class="strip" aria-label="Earlier actions">
      <AnimatePresence :initial="false">
        <motion.span
          v-for="chip in historyChips"
          :key="chip.key"
          class="strip__chip"
          :style="{ '--hue': chip.hue }"
          layout
          :initial="{ opacity: 0, scale: 0.6, y: -4 }"
          :animate="{ opacity: 1, scale: 1, y: 0 }"
          :exit="{ opacity: 0, scale: 0.6 }"
          :transition="SPRING"
          :title="chip.count > 1 ? `${chip.label} ×${chip.count}` : chip.label"
        >
          <HugeiconsIcon :icon="chip.icon" :size="14" :stroke-width="1.8" />
          <span v-if="chip.count > 1" class="strip__count">×{{ chip.count }}</span>
        </motion.span>
      </AnimatePresence>
    </div>

    <!-- Sliding window — up to five latest steps, in full. -->
    <div class="window">
      <AnimatePresence mode="popLayout" :initial="false">
        <motion.div
          v-for="(e, i) in visible"
          :key="e.key"
          class="window__row"
          layout
          :initial="historical ? false : { opacity: 0, y: 10 }"
          :animate="{ opacity: 1, y: 0 }"
          :exit="{ opacity: 0, y: -8, scale: 0.96 }"
          :transition="SPRING"
        >
          <ActivityStep :entry="e" :rail="i > 0" v-bind="stepProps(e)" />
        </motion.div>
      </AnimatePresence>
    </div>
  </motion.section>
</template>

<style scoped>
.activity {
  display: flex;
  flex-direction: column;
  gap: 6px;
  width: 100%;
}

/* ── History strip ─────────────────────────────────────────────────────────── */
.strip {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 8px;
  padding: 2px 0 4px 1px;
}
.strip__chip {
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--hue, var(--muted));
  opacity: 0.85;
}
.strip__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}

/* ── Sliding window ────────────────────────────────────────────────────────── */
.window {
  position: relative;
  display: flex;
  flex-direction: column;
}
.window__row {
  will-change: transform, opacity;
}
</style>
