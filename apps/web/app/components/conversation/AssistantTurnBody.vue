<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowDown01Icon } from "@hugeicons/core-free-icons";
import type { AssistantBlock } from "~/composables/useAgent";
import MarkdownMessage from "~/components/markdown/MarkdownMessage.vue";
import AgentActivity from "~/components/agent/AgentActivity.vue";
import TurnWorkFold from "~/components/turn/TurnWorkFold.vue";
import TurnStatusLine from "~/components/turn/TurnStatusLine.vue";
import AgentFace from "~/components/agent/AgentFace.vue";
import SphereFace from "~/components/agent/SphereFace.vue";
import SpawnWorkerMark from "~/components/conversation/SpawnWorkerMark.vue";
import TextSwap from "~/components/ui/TextSwap.vue";
import { segText, type RenderGroup } from "~/utils/conversationSegments";
import type { ResponseDisplay } from "~/utils/responseDisplay";
import { planTurn } from "~/utils/turnPlan";

// One assistant turn's body inside ConversationThread's stack: who answered,
// then the turn as its plan lays it out under the reader's choices — what folds
// behind "Worked for…", what stands in the open, the live batch at the tail, or
// a status line in place of the work. The rules live in utils/turnPlan, where
// every combination of choices is tested; this only renders the plan.
//
// One working orb per turn, anchored in AgentActivity from the first moment the
// turn runs. It stays mounted (stable key) while steps stream in — orb → line →
// thinking — instead of a stack-level orb handing off to a second one. So the
// plan lifts the *last* batch out while it's live and hands it back as `live`;
// once text takes over (or the turn ends) it rejoins the rest and folds into its
// horizontal strip.

const props = withDefaults(defineProps<{
  block: AssistantBlock;
  /** How turns read where this one is. */
  display: ResponseDisplay;
  /** The turn's own toggle once pressed — open shows the whole turn, closed
   *  folds it to the reply. Undefined until pressed; the reader's choices set
   *  where the turn starts. */
  manual: boolean | undefined;
  agentName: string;
  agentSeed?: string | null;
  /** kone's own turn: its face instead of the agent's. */
  house?: boolean;
  /** How long the turn took, phrased by how it ended. */
  workLabel: string;
  /** Whether the speaker's face is drawn at all — the conversation style
   *  decides (a style that names its speaker another way draws none). */
  showFace?: boolean;
  /** The speaker's face, in px — the conversation style sizes it. Only read
   *  when `showFace` is true; never gated on a magic size. */
  faceSize?: number;
  /** The time beside the name, for styles that head a message with one. */
  stamp?: string;
  now: number;
  linkHandoffs?: boolean;
}>(), { showFace: true, faceSize: 26, stamp: undefined });

const emit = defineEmits<{
  toggle: [open: boolean];
  "open-thread": [threadId: string];
}>();

// Replanned only when the turn, the read or the toggle changes — the clock
// ticking a running turn's label re-renders this but leaves the plan alone.
// useAgent's reducer reassigns `block.items` (never mutates it in place) for
// every append, replace and subagent update, so a settled turn's plan is built
// once and its groups keep their identity: each AgentActivity sees the same
// `segments` it had rather than re-running its own computeds.
const plan = computed(() => planTurn(props.block, props.display, props.manual));
const toggle = computed(() => plan.value.toggle);

// Everything the turn shows in the open, the live batch included, as one keyed
// list. The live batch used to render on its own after the list, so the moment
// text took over and it rejoined the list it was a different element: torn
// down and mounted again, every row replaying its entrance and the batch
// re-measuring its height under the reply that had just started — the thread
// visibly lurching up and back down. One list with one key per batch keeps it
// the same component from the bare orb through its last step.
//
// The batch that leads the turn takes a fixed key rather than its first
// item's: before any step has arrived it is only an orb, with no item to be
// keyed by, and it must still be the same element once its first step lands.
type Row = { key: string; group: RenderGroup; live: boolean; revealDelay: number };

/** How long a batch takes to fold into its strip once the agent moves on —
 *  the viewport's height transition in AgentActivity. */
const BATCH_FOLD_MS = 320;
const rows = computed<Row[]>(() => {
  const p = plan.value;
  // Text that lands straight under a batch arrives as that batch folds shut,
  // and would otherwise fade in while riding the fold up the column. Only a
  // folding batch ("auto") moves; open or closed ones hold their height.
  const folds = p.activity === "auto" && props.block.state === "running";
  const out: Row[] = p.inline.map((group, i) => ({
    key: group.kind === "text" ? group.seg.key : group.key,
    group,
    live: false,
    revealDelay: folds && group.kind === "text" && p.inline[i - 1]?.kind === "steps" ? BATCH_FOLD_MS : 0,
  }));
  if (p.live) {
    const first = p.live[0]?.key ?? `${props.block.id}:live-activity`;
    out.push({ key: first, group: { kind: "steps", key: first, segments: p.live }, live: true, revealDelay: 0 });
  }
  const lead = out[0];
  if (lead?.group.kind === "steps") lead.key = `${props.block.id}:lead-batch`;
  return out;
});

// The speaker's name, split for its arrival. A live turn spells the name in
// letter by letter; a turn read back from history draws it whole, with no
// per-letter spans at all. Either way the name is read aloud as one word.
const nameChars = computed(() => (props.block.historical ? [] : Array.from(props.agentName)));
const metaLabel = computed(() => (props.block.state === "running" ? "working" : props.workLabel));

// The speaker's name is spelled once, in the head below: a live turn spells
// it letter by letter, history draws it whole with no per-letter spans.
function onHeadClick(): void {
  const t = toggle.value;
  if (t) emit("toggle", !t.open);
}
</script>

<template>
  <!-- Who answered. Agent turns only — giving the user's own turns a
       face would make the transcript a group chat instead of a
       document, and the asymmetry is what keeps it one. -->
  <!-- The arrival is tied to the turn running, not just to it being live:
       the name's head swaps between a plain line and the toggle as the plan
       changes, and a head remounted on settle must not spell the name again. -->
  <div class="speaker" :class="{ 'speaker--enter': !block.historical && block.state === 'running' }">
    <template v-if="showFace">
      <SphereFace
        v-if="house"
        class="speaker__sphere"
        :size="faceSize"
        :follow="false"
        :still="block.state !== 'running'"
      />
      <AgentFace v-else :seed="agentSeed" :size="faceSize" class="speaker__face" />
    </template>
    <!-- The turn's own toggle: the whole turn, or just its reply —
         whatever the reader's choices started it as. One head element in
         both cases (a button when the turn toggles, a plain line when it
         doesn't) so the name + stamp below live in exactly one place. -->
    <component
      :is="toggle ? 'button' : 'div'"
      class="speaker__head"
      :class="{ 'speaker__head--toggle': !!toggle }"
      :type="toggle ? 'button' : undefined"
      :aria-expanded="toggle ? toggle.open : undefined"
      :aria-label="toggle ? `${toggle.open ? 'Hide' : 'Show'} agent work (${workLabel})` : undefined"
      @click="onHeadClick"
    >
      <span class="speaker__name">
        <template v-if="nameChars.length">
          <span class="sr-only">{{ agentName }}</span>
          <span
            v-for="(c, i) in nameChars"
            :key="i"
            class="speaker__char"
            :style="`--i: ${i}`"
            aria-hidden="true"
            >{{ c }}</span
          >
        </template>
        <template v-else>{{ agentName }}</template>
      </span>
      <span v-if="stamp" class="speaker__stamp">{{ stamp }}</span>
      <span v-if="toggle" class="speaker__meta">
        <TextSwap class="speaker__label" :swap-key="metaLabel" />
        <HugeiconsIcon
          class="speaker__chev"
          :class="{ 'speaker__chev--open': toggle.open }"
          :icon="ArrowDown01Icon"
          :size="12"
          :stroke-width="2"
        />
      </span>
    </component>
    <span v-if="$slots.actions" class="speaker__acts"><slot name="actions" /></span>
  </div>

  <!-- The turn, as the plan lays it out (utils/turnPlan). Settled and
       folding at the end, the work sits behind the agent-name toggler
       and only the reply (and any spawns it said) stays open; otherwise
       the parts stand inline in arrival order — steps, updates and spawn
       lines, whichever the reader shows — with the live batch's orb, or
       a status line, at the tail while it runs. One branch for every
       state, so a turn settling doesn't remount what's on screen. -->
  <TurnWorkFold
    v-if="plan.fold?.length"
    :groups="plan.fold"
    :open="plan.foldOpen"
    :historical="block.historical"
    :fold="plan.activity"
  />
  <!-- The live batch is the list's last row, so it is the same component
       before and after text takes over: one orb for the whole run, from send
       through every thinking step and tool call. -->
  <template v-for="{ key, group: grp, live, revealDelay } in rows" :key="key">
    <AgentActivity
      v-if="grp.kind === 'steps'"
      :segments="grp.segments"
      :running="live || block.state === 'running'"
      :is-tail="live"
      :historical="block.historical"
      :fold="plan.activity"
    />
    <div
      v-else-if="grp.kind === 'text'"
      class="answer-wrap"
      :data-markdown-source="segText(grp.seg)"
    >
      <MarkdownMessage
        class="answer"
        :source="segText(grp.seg)"
        :historical="block.historical || display.liveText === 'whole'"
        :reveal-delay="revealDelay"
      />
    </div>
    <SpawnWorkerMark
      v-else
      :record="grp.record"
      :linkable="linkHandoffs"
      :animate="!block.historical"
      @open-thread="emit('open-thread', $event)"
    />
  </template>

  <!-- With the work hidden, one sentence about it ("Reading useAgent.ts",
       "Thinking") says the agent is still at it. -->
  <TurnStatusLine
    v-if="plan.status"
    :key="`${block.id}:status`"
    :block="block"
    :now="now"
  />
</template>

<style scoped>
/* Fills the stack rather than shrink-wrapping: as a flex-start item it would
   otherwise size to its longest unbreakable line. One link in the containment
   chain described on `.thread`. */
.answer-wrap {
  width: 100%;
  max-width: 100%;
  min-width: 0;
}
/* A collapsed fold costs no gap: it is still a flex child at zero height, so
   it hands one gap back. The margin moves with the fold's grid track, same
   length and curve — handed back in one step, it was a 15px snap at the start
   of every close. */
.stack > .fold {
  transition: margin-bottom 0.38s cubic-bezier(0.22, 1, 0.36, 1);
}
.stack > .fold:not(.fold--open) {
  margin-bottom: -15px;
}
@media (prefers-reduced-motion: reduce) {
  .stack > .fold {
    transition: none;
  }
}

/* ── Speaker line — who answered ───────────────────────────────────────────── */
.speaker {
  display: flex;
  align-items: center;
  gap: 8px;
  min-height: 26px;
  line-height: 1;
  /* Chrome, not content: the reply body opts into selection via .selectable, but
     the speaker line (name + duration) shouldn't drag-highlight. */
  -webkit-user-select: none;
  user-select: none;
  /* Pulled back in from the stack's 15px: the line belongs to the reply beneath
     it, and at full gap it floats between two turns instead. */
  margin-bottom: -6px;
}
.speaker__face {
  position: relative;
  z-index: 1;
  border-radius: 50%;
  background: var(--ground);
}
/* kone's own mark, in the slot an agent's tile would take. It is a silhouette
   rather than a tile, so it gets the layer and the footprint without the disc
   behind it — a circle under this face would read as a badge it is sitting in. */
.speaker__sphere {
  position: relative;
  z-index: 1;
  flex: none;
}
.speaker__head {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  line-height: 1;
}
.speaker__head--toggle {
  padding: 3px 6px;
  margin-left: -5px;
  border: 0;
  border-radius: 7px;
  background: transparent;
  cursor: pointer;
  line-height: 1;
  transition: background-color 0.15s ease;
}
.speaker__head--toggle:hover {
  background: var(--hover);
}
.speaker__head--toggle:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}
.speaker__name {
  display: inline-flex;
  align-items: center;
  font-size: 13px;
  font-weight: 500;
  line-height: 1;
  color: var(--ink-soft);
  transition: color 0.15s ease;
}
.speaker__head--toggle:hover .speaker__name {
  color: var(--ink);
}
.speaker__stamp {
  font-family: var(--font-mono);
  font-size: 11.5px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
}
.speaker__meta {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  font-family: var(--font-mono);
  font-size: 12px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  color: var(--muted);
  transition: color 0.15s ease, opacity 0.3s ease;
  animation: speaker-meta-in 0.35s cubic-bezier(0.22, 1, 0.36, 1) both;
}
@keyframes speaker-meta-in {
  from {
    opacity: 0;
    transform: translateY(2px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}
.speaker__head--toggle:hover .speaker__meta {
  color: var(--ink-soft);
}
/* No display of its own: the label is a TextSwap, whose grid stacks the old
   and new label in one cell while they cross. */
.speaker__label {
  font-size: 12px;
  line-height: 1;
}
.speaker__chev {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 13px;
  height: 13px;
  opacity: 0.75;
  transition: transform 0.24s ease, opacity 0.15s ease;
}
.speaker__head--toggle:hover .speaker__chev {
  opacity: 1;
}
.speaker__chev--open {
  transform: rotate(180deg);
}
@media (prefers-reduced-motion: reduce) {
  .speaker__chev {
    transition: none;
  }
}

/* ── A live turn's arrival ─────────────────────────────────────────────────────
   The face settles first as a `micro-scale-fade` (600ms, 0.96 → 1), then the
   name spells in as a `per-character-rise` a beat behind it — crisp letters
   sliding up, no blur. Scaled for a 13px name: the 32px rise drops to 7px and
   the stagger to 15ms, since a heading's 24ms over a long name reads as lag
   at this size. */
.speaker--enter .speaker__face,
.speaker--enter .speaker__sphere {
  animation: speaker-face-in 600ms cubic-bezier(0.32, 0.72, 0, 1) backwards;
}
@keyframes speaker-face-in {
  from {
    opacity: 0;
    transform: scale(0.96);
  }
}
.speaker__char {
  display: inline-block;
  white-space: pre;
}
.speaker--enter .speaker__char {
  animation: speaker-char-in 700ms cubic-bezier(0.2, 0.8, 0.2, 1) backwards;
  animation-delay: calc(100ms + var(--i) * 15ms);
}
@keyframes speaker-char-in {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
}

@media (prefers-reduced-motion: reduce) {
  .speaker--enter .speaker__face,
  .speaker--enter .speaker__sphere,
  .speaker--enter .speaker__char {
    animation: none;
  }
}

/* The settled rich answer — it fills the thread column, whose
   var(--thread-measure) cap is the reading measure; its internals live in
   MarkdownMessage. */
.answer {
  width: 100%;
  min-width: 0;
}
</style>
