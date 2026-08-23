<script lang="ts">
// Module scope — deliberately NOT in `<script setup>`, whose top level is the
// per-instance setup body. This map is a hand-off *between* instances.
//
// A batch's open height, carried across the component swap that ends its live
// life. When the agent starts streaming text, ConversationThread stops rendering
// the live tail activity and renders the *same batch* as a settled one instead —
// a different component instance. Without the hand-off the new instance mounts
// flat at 0 and the reply below eats the whole collapse in a single frame, which
// is exactly the lurch this component exists to prevent. Keyed by the batch's
// first entry, and consumed once.
const carriedHeights = new Map<string, number>();

// One announcement plus the wall-clock time it was made — the key the
// module-scope dedupe compares against.
type Announcement = { text: string; at: number };

// The screen-reader announcer is shared across instances too: one turn renders
// several AgentActivity instances (the live tail plus every settled step batch),
// and they all see the same `running`→false transition in a single Vue flush.
// The module-scope dedupe turns that into one announcement, not one per batch.
const lastAnnounce: Announcement = { text: "", at: 0 };
</script>

<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiBrain01Icon, ArrowRight01Icon } from "@hugeicons/core-free-icons";
import ActivityStep from "~/components/ActivityStep.vue";
import TurnOrb from "~/components/TurnOrb.vue";
import {
  activityEntries,
  segStreaming,
  segText,
  type ActivityEntry,
  type Segment,
} from "~/utils/conversationSegments";
import { toolMeta, type HugeIcon } from "~/utils/toolPresentation";
import { thinkingOrbHue } from "~/utils/toolOrbDraw";

// ── Agent activity ─────────────────────────────────────────────────────────────
//
// One batch of thinking + tool calls, rendered inline — no header, no collapse.
// A batch has two lives:
//
//   • ACTIVE (still working) — the batch is headed by the working orb, and the
//     first step's rail runs up into it (orb → line → thinking). Up to five step
//     rows show in full at once. When a sixth arrives the oldest row slides up and
//     fades, its icon filed into a compact horizontal strip above the list;
//     consecutive same-type actions merge into one ×N chip so the strip stays
//     tight across a long run. The latest steps always stay in view at the bottom.
//
//   • DONE (the agent has moved on to streaming text, or the turn ended) — the
//     remaining rows fold up into the strip too, so a finished batch reads as a
//     single horizontal row of icons beside a settled orb. The strip is a toggle:
//     click it to unfold the whole batch back into the full step list
//     (every call, its target, and its result), click again to re-compact it.
//     The next batch of tool calls opens a fresh window and repeats.
//
// For a short active batch (≤5 steps) there's no strip yet — it looks exactly
// like the plain inline step list it always was.
//
// ── How the rows move (the whole point of this file's machinery) ───────────────
//
// Everything below the batch — the streaming reply, the next exchange — sits on
// top of this component's height. So *every* row appearing, leaving, or folding
// into the strip is a shove felt by the reader mid-sentence. The old version let
// rows enter and exit the flex flow directly: five rows collapsing into one strip
// deleted ~140px of layout in a single frame and yanked the reply up with it.
//
// So the rows don't live in the flow at all. They live in a **bottom-anchored
// viewport**: `.window` is an explicitly sized, clipped box whose height we
// animate, and `.window__inner` is absolutely pinned to its bottom edge, free to
// overflow upward. That gives two guarantees:
//
//   1. Height is the only thing the rest of the thread ever sees, and it always
//      transitions — folding into the strip is a smooth 380ms close, never a jump.
//   2. New rows always grow the stack *upward* from a fixed bottom edge, so the
//      pinned-window ticker needs no per-row exit animation and rows never
//      reflow each other.
//
// Adding a row still moves the inner box's top edge instantly (it just got
// taller). We cancel that exactly: right after the DOM update we offset the inner
// by the height it gained, with transitions off, then release it to 0. The offset
// and the height transition then run in lockstep, and the algebra cancels — rows
// already on screen hold *perfectly* still while the new one is revealed by the
// growing edge. That's the difference between "the list grew" and "the page moved".

const props = defineProps<{
  segments: Segment[];
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

// The batch is active only while the turn runs and this is the live tail group.
const active = computed(() => props.running && props.isTail === true);

// A done batch can be unfolded back into its full step list. `expanded` is the
// user's toggle; it only applies once the batch is done (an active batch owns
// its own sliding window).
const { cue } = useSound();
const expanded = ref(false);
const canExpand = computed(() => !active.value && total.value > 0);

// The chip strip folds and unfolds in lockstep with the window below — same
// duration, same curve. Without this the strip only shrinks when AnimatePresence
// finally unmounts the exiting chips, so the rows finish opening before the
// chevron (which rides the strip's edge) jumps toward the orb.
const STRIP_FOLD = "width 380ms cubic-bezier(0.22, 0.61, 0.36, 1)";

function settleStrip(el: HTMLElement): void {
  el.style.transition = "";
  el.style.width = "";
}

function onStripSettled(e: TransitionEvent): void {
  if (e.propertyName !== "width") return;
  const el = e.target as HTMLElement | null;
  if (!el || el !== stripEl.value) return;
  el.removeEventListener("transitionend", onStripSettled);
  settleStrip(el);
}

function foldStrip(): void {
  const el = stripEl.value;
  // Fold from what it occupies right now — a clamped long run must not widen
  // first just because its content is longer than the row.
  if (!el || el.clientWidth === 0) return;
  el.style.transition = "none";
  el.style.width = `${el.clientWidth}px`;
  void el.offsetWidth; // resolve styles: this is the transition's start
  if (reduced()) {
    settleStrip(el);
    return;
  }
  el.style.transition = STRIP_FOLD;
  el.style.width = "0px";
  el.addEventListener("transitionend", onStripSettled);
}

async function unfurlStrip(): Promise<void> {
  await nextTick(); // chips are back in the DOM at their natural size
  const el = stripEl.value;
  if (!el) return;
  el.style.transition = "none";
  el.style.width = "";
  void el.offsetWidth;
  const target = el.clientWidth; // natural width, clamped by the head's max
  if (target === 0 || reduced()) return;
  el.style.width = "0px";
  void el.offsetWidth;
  el.style.transition = STRIP_FOLD;
  el.style.width = `${target}px`;
  el.addEventListener("transitionend", onStripSettled);
}

function toggleExpanded(): void {
  if (!canExpand.value) return;
  if (expanded.value) void unfurlStrip();
  else foldStrip();
  expanded.value = !expanded.value;
  cue("toggle");
}

// ── Screen-reader announcements ────────────────────────────────────────────────
// The turn's full state (running / completed / failed / interrupted) lives in
// ConversationThread and reaches this component only as the `running` boolean,
// so we announce on THAT prop's transitions:
//   · the live tail batch mounts exactly when a turn starts → "kone is responding"
//   · `running` flipping to false on a still-mounted batch means the turn settled
//     → "kone replied", or "kone stopped" / "Response interrupted" when the batch's
//       own items show a failure or an in-progress item cut short mid-work.
// The message goes into a `ref` bound to a single polite live region — never the
// streamed text — and the transition watch fires once per state change, so a
// blind user gets one announcement per event, never one per streamed token.
const liveText = ref("");
function announce(text: string): void {
  const now = Date.now();
  if (text === lastAnnounce.text && now - lastAnnounce.at < 400) return;
  lastAnnounce.text = text;
  lastAnnounce.at = now;
  liveText.value = text;
}
function settledMessage(): string {
  const items = props.segments.flatMap((s) => s.items);
  if (items.some((i) => i.status === "failed")) return "kone stopped";
  if (items.some((i) => i.status === "in-progress")) return "Response interrupted";
  return "kone replied";
}
watch(
  () => props.running,
  (running, was) => {
    if (props.historical) return;
    if (running && props.isTail === true) announce("kone is responding");
    else if (was === true && !running) announce(settledMessage());
  },
  { immediate: true },
);

// The orb is the fixed head; steps live either as horizontal chips beside it or
// as vertical rows beneath it — never both for the same step.
//   Active: the last five steps are rows; everything earlier is a chip.
//   Done & collapsed: no rows — every step is a chip on the orb's line.
//   Done & expanded: no chips — every step drops down into a full row.
const archived = computed(() => {
  if (active.value) return entries.value.slice(0, Math.max(0, total.value - WINDOW));
  return expanded.value ? [] : entries.value;
});

// ── The viewport ───────────────────────────────────────────────────────────────
// Rows are wanted on screen while the batch is working or while you've unfolded a
// finished one. `rowsAlive` lags that by one animation: the rows stay mounted
// through the fold-away so there's something to animate, and unmount when the
// height transition lands on 0.
const wantRows = computed(() => active.value || expanded.value);
const rowsAlive = ref(wantRows.value);

// While rows are folding away the entry list must not change under them, or the
// closing animation would re-measure mid-flight. Freeze what was on screen.
const frozen = ref<ActivityEntry[] | null>(null);

// A long run doesn't need every past row in the DOM — only enough above the
// five-row window to cover the slide-out. Rows dropping off the far top are
// invisible (they're above the clip) and, because the stack is bottom-anchored,
// removing them moves nothing.
const KEEP = WINDOW + 8;
const rowList = computed<ActivityEntry[]>(() => {
  if (!rowsAlive.value) return [];
  if (frozen.value) return frozen.value;
  return active.value ? entries.value.slice(-KEEP) : entries.value;
});

// A live batch past five steps runs as a ticker: the box holds the last five and
// the rest overflow above the clip.
const windowed = computed(() => active.value && rowList.value.length > WINDOW);
// Whether anything is actually cut off — measured, so the top fade is on for the
// ticker *and* for the fold, and off for a short batch that fits.
const masked = ref(false);

const winEl = ref<HTMLElement | null>(null);
const innerEl = ref<HTMLElement | null>(null);
// The chip strip hugs its content and only fades at the right when the run
// actually overflows the row — measured, since chips can outgrow the width at any
// point in a long batch.
const stripEl = ref<HTMLElement | null>(null);
const stripOverflow = ref(false);
function measureStrip(): void {
  const el = stripEl.value;
  stripOverflow.value = !!el && el.scrollWidth > el.clientWidth + 1;
}
// Bleed above the clip so the first row's 22px rail can still reach up into the
// orb; folded flat there's no bleed, so nothing peeks out of a closed batch.
const BLEED = 12;
const GAP = 6;

let prevInnerH = 0;
let lastTarget = -1;
let firstSync = true;
let ro: ResizeObserver | null = null;

function reduced(): boolean {
  return !!import.meta.client && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

// Size the viewport to what should be visible, cancelling the instant jump that
// the inner box's own growth would otherwise cause. See the header comment.
function sync(): void {
  const win = winEl.value;
  const inner = innerEl.value;
  if (!win || !inner) return;

  const innerH = inner.offsetHeight;
  const rows = Array.from(inner.children) as HTMLElement[];
  // Driven by what the batch *wants*, not by what's mounted: rows outlive the
  // close so there's something to watch fold away.
  const target = Math.round(
    !wantRows.value
      ? 0
      : windowed.value && rows.length > WINDOW
        ? Math.max(0, innerH - (rows[rows.length - WINDOW]?.offsetTop ?? 0))
        : innerH,
  );
  // Rows are cut at the *top* both when the ticker scrolls and when the box folds
  // shut (the stack hangs from the bottom edge), so the fade belongs on wherever
  // content exceeds the box — not just on the live window.
  masked.value = rowsAlive.value && innerH > target + 1;

  // Both the ResizeObserver and the watchers can land on the same change. A
  // second pass would see `grew === 0` and snap the transform back to 0 with
  // transitions off — killing the slide mid-flight. So ignore no-op syncs.
  if (!firstSync && innerH === prevInnerH && target === lastTarget) return;

  const grew = innerH - prevInnerH;
  prevInnerH = innerH;
  lastTarget = target;

  // Publish the open height continuously rather than on unmount: Vue mounts the
  // replacement instance *before* tearing this one down, so an unmount hook would
  // hand the height over one beat too late to be picked up.
  if (batchKey.value) {
    if (target > 0) carriedHeights.set(batchKey.value, target);
    else carriedHeights.delete(batchKey.value);
  }

  // No motion on first paint (a restored thread shouldn't unroll) or when the
  // reader has asked for none.
  const instant = firstSync || reduced();
  firstSync = false;

  // Offset the inner box by what it just gained, so the rows already on screen
  // don't lurch. Crucially this ACCUMULATES onto whatever offset is still
  // unwinding from a previous row: a step landing mid-slide would otherwise have
  // its transform yanked from its in-flight value straight to the new one, and
  // that discontinuity is felt as the whole tree shaking. Read the live animated
  // value first — once transitions are off, the computed value collapses to the
  // end state.
  if (instant) {
    inner.style.transition = "none";
    inner.style.transform = "translateY(0px)";
    win.style.transition = "none";
  } else if (grew > 0) {
    const pending = new DOMMatrixReadOnly(getComputedStyle(inner).transform).m42;
    inner.style.transition = "none";
    inner.style.transform = `translateY(${pending + grew}px)`;
  }
  // grew <= 0 deliberately leaves the transform alone: the box only ever loses
  // height off the *top* (rows trimmed above the clip), which moves nothing, and
  // touching it would cut short a slide that's still running.

  win.style.height = `${target}px`;
  win.style.paddingTop = target > 0 ? `${BLEED}px` : "0px";
  win.style.marginTop = target > 0 ? `${GAP - BLEED}px` : "0px";

  void win.offsetHeight; // flush the above as the transition's starting point

  if (instant) {
    inner.style.transition = "";
    win.style.transition = "";
  } else if (grew > 0) {
    // Released together with the height, same duration and curve — that lockstep
    // is what holds the visible rows perfectly still.
    inner.style.transition = "";
    inner.style.transform = "translateY(0px)";
  }
}

function onWinTransitionEnd(e: TransitionEvent): void {
  if (e.propertyName !== "height" || e.target !== winEl.value) return;
  if (!wantRows.value) {
    rowsAlive.value = false;
    frozen.value = null;
    prevInnerH = 0;
    lastTarget = 0;
  }
}

watch(wantRows, (want) => {
  if (want) {
    frozen.value = null;
    rowsAlive.value = true;
  } else if (rowsAlive.value) {
    // Hold the list still for the length of the fold.
    frozen.value = rowList.value;
  }
  void nextTick(sync);
});
watch(rowList, () => void nextTick(sync));

const batchKey = computed(() => entries.value[0]?.key ?? "");

onMounted(async () => {
  // Row content grows too — a thinking row streams its text — so watch the box
  // itself rather than only the entry list.
  if (innerEl.value && "ResizeObserver" in window) {
    ro = new ResizeObserver(() => {
      sync();
      measureStrip();
    });
    ro.observe(innerEl.value);
    if (stripEl.value) ro.observe(stripEl.value);
  }

  // Taking over a batch that was live a moment ago: adopt the height *and* the
  // rows the outgoing instance was showing, so the reader watches the steps fold
  // away rather than an empty box closing. The bottom-anchored viewport does the
  // rest — clipped to the carried height, the visible rows are exactly the ones
  // that were on screen.
  const carried = carriedHeights.get(batchKey.value);
  carriedHeights.delete(batchKey.value);
  if (carried && carried > 0 && !wantRows.value) {
    rowsAlive.value = true;
    frozen.value = entries.value.slice(-KEEP);
    await nextTick();
    const win = winEl.value;
    if (win && innerEl.value) {
      win.style.transition = "none";
      win.style.height = `${carried}px`;
      win.style.paddingTop = `${BLEED}px`;
      win.style.marginTop = `${GAP - BLEED}px`;
      void win.offsetHeight; // resolve styles: this is the transition's start
      win.style.transition = "";
      prevInnerH = innerEl.value.offsetHeight; // rows are unchanged — no offset
      lastTarget = carried;
      firstSync = false;
      requestAnimationFrame(sync); // …and now close it
      return;
    }
  }
  sync();
});
onBeforeUnmount(() => ro?.disconnect());

type Glyph = { icon: HugeIcon; hue: string; label: string };
function glyphOf(e: ActivityEntry): Glyph {
  if (e.type === "thinking") return { icon: AiBrain01Icon, hue: thinkingOrbHue(), label: "Thinking" };
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
  <section class="activity" aria-label="Agent activity">
    <!-- Polite live region for screen readers: turn-start / settled announcements
         only (see the script section), so streaming is never announced per token.
         `sr-only` is the Tailwind utility — visually invisible, no layout. -->
    <span class="sr-only" role="status" aria-live="polite" aria-atomic="true">{{ liveText }}</span>
    <!-- Head line — the orb is the fixed anchor and always comes first. Beside it,
         inline, are the chips for compacted steps: horizontally when collapsed,
         and none at all when expanded (they've dropped into the rows below). So
         the orb is the first thing in both the horizontal and the vertical stack,
         and it never moves as the two swap. Once done, the whole line is a toggle. -->
    <component
      :is="canExpand ? 'button' : 'div'"
      :type="canExpand ? 'button' : undefined"
      v-if="active || total > 0"
      class="head"
      :class="{ 'head--toggle': canExpand }"
      :aria-label="canExpand ? (expanded ? 'Collapse steps' : `Show all ${total} steps`) : undefined"
      :aria-expanded="canExpand ? (expanded ? 'true' : 'false') : undefined"
      @click="toggleExpanded"
    >
      <span class="head__orb">
        <TurnOrb
          state="working"
          :size="16"
          :active="active"
          :aria-label="active ? 'Working' : 'Steps'"
        />
      </span>

      <!-- The chips get their own clipped track. Kept on one line on purpose: a
           strip that wraps changes the head's height, and since the head sits
           *above* the step rows, that shoves the whole batch — and everything
           below it in the thread — down by a line at the exact moment the batch
           is folding up. One row in, one row out, and the tree stays still. -->
      <span ref="stripEl" class="head__strip" :class="{ 'head__strip--fade': stripOverflow }">
        <AnimatePresence :initial="false">
          <motion.span
            v-for="chip in historyChips"
            :key="chip.key"
            class="head__chip"
            :style="{ '--hue': chip.hue }"
            :initial="{ opacity: 0, scale: 0.6, y: -4 }"
            :animate="{ opacity: 1, scale: 1, y: 0 }"
            :exit="{ opacity: 0, scale: 0.6 }"
            :transition="SPRING"
            :title="chip.count > 1 ? `${chip.label} ×${chip.count}` : chip.label"
          >
            <HugeiconsIcon :icon="chip.icon" :size="14" :stroke-width="1.8" />
            <span v-if="chip.count > 1" class="head__count">×{{ chip.count }}</span>
          </motion.span>
        </AnimatePresence>
      </span>

      <HugeiconsIcon
        v-if="canExpand"
        :icon="ArrowRight01Icon"
        :size="13"
        :stroke-width="2"
        class="head__chev"
        :class="{ 'head__chev--open': expanded }"
      />
    </component>

    <!-- Vertical steps — a bottom-anchored viewport, not a list in the flow. Its
         height is the only thing the rest of the thread ever feels, and that
         height always transitions, so folding into the strip glides instead of
         yanking the reply below it upward. Rows stack upward from the fixed
         bottom edge; the top fade dissolves the ones sliding out of the window. -->
    <div
      ref="winEl"
      class="window"
      :class="{ 'window--masked': masked }"
      @transitionend="onWinTransitionEnd"
    >
      <div ref="innerEl" class="window__inner">
        <motion.div
          v-for="e in rowList"
          :key="e.key"
          class="window__row"
          :initial="historical ? false : { opacity: 0 }"
          :animate="{ opacity: 1 }"
          :transition="{ duration: 0.26, ease: 'easeOut' }"
        >
          <ActivityStep :entry="e" rail v-bind="stepProps(e)" />
        </motion.div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.activity {
  display: flex;
  flex-direction: column;
  width: 100%;
}

/* ── Head line ─────────────────────────────────────────────────────────────────
   The orb anchors the top-left corner and always comes first. Compacted steps sit
   inline to its right as chips (the horizontal stack); when expanded there are no
   chips and the steps become the rows below (the vertical stack). Either way the
   orb is the first item and holds its place — it never moves as the two swap.
   The orb shares the left column with every row's icon, and the first row's rail
   rises to meet it, stopping at the orb's lower edge. */
/* Fixed height, in every state. The head is the one thing above the rows, so any
   size change here moves the entire batch and everything under it — and it would
   land at the worst possible moment, since the chips arrive exactly as the rows
   fold away. Padding and metrics are identical for the plain and toggle forms so
   that swapping <div> for <button> is invisible too. */
.head {
  position: relative;
  z-index: 1;
  box-sizing: border-box;
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 8px;
  /* Hug the orb · chips · arrow so the clickable area and hover background stop at
     the arrow instead of running to the far edge; cap at the row so a long run
     still shrinks the strip and lets its fade take over. */
  width: fit-content;
  max-width: 100%;
  min-height: 26px;
  /* Pull the window up so the 22px rail closes the distance to the orb when rows
     follow. No left bleed: the orb must sit at the content edge (x=0) to line up with the
     rows' rail and the reply text, so the hover pill starts there too rather than
     6px further left where the thread's scroll area would clip its rounded corner.
     The orb's own transparent inset gives it breathing room without padding. */
  margin: 0 -6px -2px 0;
  padding: 3px 6px 5px 0;
  border: 0;
  background: transparent;
  border-radius: 8px;
  color: inherit;
  text-align: left;
}
/* A done batch's line is a toggle between the horizontal and vertical stacks. */
.head--toggle {
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.head--toggle:hover {
  background: var(--hover);
}
.head__orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  /* Keep the canvas orb out of any row-enter transforms below. */
  isolation: isolate;
  transform: translateZ(0);
}
/* The clipped one-line track. It shrinks to its chips so the chevron trails
   immediately after the last one, and fades rather than cuts when a very long
   run outgrows the available width — the toggle is there to see the full list. */
.head__strip {
  display: flex;
  flex: 0 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  overflow: hidden;
}
/* Only when the run actually outgrows the row — otherwise the fade would eat the
   last chip of a strip that fits. */
.head__strip--fade {
  -webkit-mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
  mask-image: linear-gradient(to right, #000 calc(100% - 20px), transparent 100%);
}
.head__chip {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 2px;
  color: var(--hue, var(--muted));
  opacity: 0.85;
}
.head__count {
  font-family: var(--font-mono);
  font-size: 10.5px;
  color: var(--muted);
}
.head__chev {
  flex: none;
  opacity: 0.5;
  transition: transform 0.22s ease;
}
.head__chev--open {
  transform: rotate(90deg);
}
@media (prefers-reduced-motion: reduce) {
  .head__chev {
    transition: none;
  }
}

/* ── Vertical steps ────────────────────────────────────────────────────────────
   The viewport. Height (and the bleed padding that lets the top row's rail reach
   the orb) is driven from script and always transitions — that transition IS the
   smoothness the whole thread feels when a batch folds into its strip.
   `content-box` keeps the scripted height meaning *content*, so the bleed doesn't
   have to be arithmetic. */
.window {
  position: relative;
  box-sizing: content-box;
  height: 0;
  overflow: hidden;
  transition:
    height 380ms cubic-bezier(0.22, 0.61, 0.36, 1),
    padding-top 380ms cubic-bezier(0.22, 0.61, 0.36, 1),
    margin-top 380ms cubic-bezier(0.22, 0.61, 0.36, 1);
}
/* Rows hang from the bottom edge and overflow upward, so a new row never pushes
   its neighbours around — the edge simply reveals more of the stack. */
.window__inner {
  position: absolute;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  flex-direction: column;
  transition: transform 380ms cubic-bezier(0.22, 0.61, 0.36, 1);
  will-change: transform;
}
/* Only once the window is a ticker — otherwise this would fade the first row of
   a short batch for no reason. */
.window--masked {
  -webkit-mask-image: linear-gradient(to bottom, transparent 0, #000 26px);
  mask-image: linear-gradient(to bottom, transparent 0, #000 26px);
}
.window__row {
  will-change: opacity;
}
@media (prefers-reduced-motion: reduce) {
  .window,
  .window__inner {
    transition: none;
  }
}
</style>
