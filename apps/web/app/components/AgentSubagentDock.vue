<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, ArrowUpRight01Icon, AiBrain01Icon, StopIcon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { SESSION_BRAND } from "~/types/session";
import type { BrandKey } from "~/utils/modelCatalog";
import {
  brainStack,
  subagentEffort,
  subagentModel,
  type DelegateRow,
} from "~/utils/subagentRuns";
import {
  childApprovalsInbox,
  decideChildApproval,
  type PendingApproval,
} from "~/composables/useAgent";
import type { ApprovalDecision } from "~/types/desktop";

// The corner "Subagents" dock — a sibling of the Changes dock (ChangedFilesList)
// and the Tasks dock (PlanTaskList) in the same folder-picker shell, docked
// bottom-right while a turn hands work off. It lists everything the agent has
// delegated to this thread in one chronological list, of two kinds: provider-
// native nested runs (ephemeral, one turn long — clicking opens that run's
// transcript in the expanded shell, SubagentShell) and spawned kone threads
// (real, persistent conversations that outlive the parent's turn — clicking
// opens their shell too, whose open-thread action takes you to the thread
// itself).
//
// Both kinds wear ONE row: same status vocabulary (working orb → ✓/✕), same
// meta line, same trailing glyph. A delegate is a delegate, and giving the
// newer kind its own chrome would fork this dock into two panels living in one
// shell. What genuinely differs — that a spawned thread can sit parked waiting
// on a human, or report how long it took — is carried in the row's hint line,
// in words, where it costs the layout nothing. The row model
// (deriveDelegates) still tracks those states honestly, so a later pass can
// give them their own treatment here without touching anything upstream.
//
// One addition on top of the sibling's row model: a spawned child parked on an
// APPROVAL gets an inline decision right in its row. The ask is not answerable
// from the parent's session (the child has none in the renderer registry), so
// the row reads the registry-level inbox (childApprovalsInbox — keyed by the
// child's thread id) and decides through the existing agent:respond IPC via
// decideChildApproval. A user-input gate has no decide action — its answer
// lives in the child's own thread — so it stays a plain parked hint.
//
// Purely presentational apart from that one answer action — it renders the
// rows deriveDelegates already built and reports which one the user wants to
// open.

const props = defineProps<{
  rows: DelegateRow[];
  /** A delegate is still in flight — keeps the dock open. */
  streaming?: boolean;
}>();

const emit = defineEmits<{
  /** Open one delegate — a run's transcript or a spawned thread's conversation.
   *  One event; the parent decides what opening means for each kind. */
  open: [row: DelegateRow];
  /** Stop a live provider-native nested run, leaving the parent turn running.
   *  Only fired for run-kind rows while they're live. The parent hands it to
   *  the session's stopSubagent (keyed by the run's toolUseId). */
  "stop-subagent": [toolUseId: string];
}>();

const { cue } = useSound();

/** A parked child's answerable approval, looked up by the child's thread id —
 *  present exactly when the row is a spawned thread parked on an approval. */
function rowApproval(row: DelegateRow): PendingApproval | null {
  if (row.target.kind !== "thread") return null;
  return childApprovalsInbox.value.get(row.target.threadId) ?? null;
}

function decideRowApproval(row: DelegateRow, decision: ApprovalDecision): void {
  const pending = rowApproval(row);
  if (!pending || row.target.kind !== "thread") return;
  cue("press");
  void decideChildApproval(row.target.threadId, pending.requestId, decision);
}

const expanded = ref(true);
const shellEl = ref<HTMLElement | null>(null);
const scrollEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
// Scrolling is only enabled once the list has *settled* and truly overflows —
// otherwise a spawning row's spring overshoot briefly exceeds the container and
// `overflow: auto` flashes a scrollbar for a run that never needed one.
const canScroll = ref(false);
let ro: ResizeObserver | null = null;
let measureTimer: ReturnType<typeof setTimeout> | null = null;

const running = computed(() => props.rows.filter((r) => r.live).length);

const meta = computed(() => {
  const total = props.rows.length;
  if (!total) return props.streaming ? "…" : "0";
  return running.value > 0 ? `${running.value}/${total}` : String(total);
});

const liveRun = computed(() => props.rows.find((r) => r.live));

// One label for both kinds — a nested run's transcript and a spawned thread's
// conversation are both "that delegate's thread" to the person reading it.
function rowLabel(row: DelegateRow): string {
  return `Open ${row.title}'s thread`;
}

function measureScroll(): void {
  const el = scrollEl.value;
  if (el) canScroll.value = el.scrollHeight > el.clientHeight + 1;
}

// Re-check overflow only after the spawn/expand transitions have settled, so
// mid-flight overshoot never flips scrolling on. A fresh change resets the
// timer, keeping the bar hidden while runs are still streaming in.
function scheduleMeasure(): void {
  if (measureTimer) clearTimeout(measureTimer);
  canScroll.value = false;
  measureTimer = setTimeout(() => {
    measureScroll();
    measureTimer = null;
  }, 340);
}

function syncHeight(): void {
  const el = shellEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function toggle(): void {
  expanded.value = !expanded.value;
  cue("toggle");
}

// A fresh spawn opens the body; once every run settles it eases shut after a
// beat so the collapse never races the last status flip. The list of who ran
// outlives the turn, so a manual collapse from there stays collapsed.
let collapseTimer: ReturnType<typeof setTimeout> | null = null;
watch(
  () => props.streaming,
  (live, was) => {
    if (collapseTimer) {
      clearTimeout(collapseTimer);
      collapseTimer = null;
    }
    if (live && !was) expanded.value = true;
    else if (!live && was) {
      collapseTimer = setTimeout(() => {
        if (!props.streaming) expanded.value = false;
        collapseTimer = null;
      }, 900);
    }
  },
);

watch([expanded, () => props.rows], () => {
  void nextTick(syncHeight);
  scheduleMeasure();
});

onMounted(() => {
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (shellEl.value) ro.observe(shellEl.value);
  window.addEventListener("resize", syncHeight);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
  if (collapseTimer) clearTimeout(collapseTimer);
  if (measureTimer) clearTimeout(measureTimer);
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
const rowSpring = { type: "spring", stiffness: 460, damping: 24, mass: 0.65 } as const;
const fadeEase = [0.22, 1, 0.36, 1] as const;
const stateFade = { duration: 0.16, ease: fadeEase } as const;
const chevSpring = { type: "spring", stiffness: 520, damping: 30, mass: 0.45 } as const;

function rowDelay(index: number): number {
  return Math.min(index * 0.045, 0.28);
}

// The engine logomark: the model id's own vendor when the run carried one; a
// spawned thread that crossed the bridge without a model id still names its
// provider, so the row wears that mark instead of the unknown-vendor dot.
function rowBrand(row: DelegateRow): BrandKey {
  const brand = subagentModel(row).brand;
  if (brand !== "generic") return brand;
  return row.provider ? SESSION_BRAND[row.provider] : "generic";
}
</script>

<template>
  <motion.div
    class="sub-dock"
    :style="{ transformOrigin: '0% 100%' }"
    :initial="{ opacity: 0, y: 16, scale: 0.94 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 12, scale: 0.95 }"
    :transition="cardSpring"
    aria-label="Agent subagents"
  >
    <div
      class="sub-card"
      :class="{ 'sub-card--collapsed': !expanded }"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
    >
      <div ref="shellEl" class="sub-shell" :class="{ 'sub-shell--collapsed': !expanded }">
        <button
          type="button"
          class="picker-header sub-header"
          :aria-expanded="expanded"
          @click="toggle"
        >
          <span class="sub-title">Subagents</span>
          <span class="sub-header__trail">
            <AnimatePresence mode="wait">
              <motion.span
                v-if="!expanded && liveRun"
                :key="liveRun.id"
                class="sub-peek"
                :title="liveRun.title"
                :initial="{ opacity: 0, x: 8, filter: 'blur(4px)' }"
                :animate="{ opacity: 1, x: 0, filter: 'blur(0px)' }"
                :exit="{ opacity: 0, x: -6, filter: 'blur(3px)' }"
                :transition="{ duration: 0.22, ease: fadeEase }"
              >
                {{ liveRun.title }}
              </motion.span>
            </AnimatePresence>
            <span class="sub-meta-wrap">
              <AnimatePresence mode="wait">
                <motion.span
                  :key="meta"
                  class="sub-meta"
                  :class="{ 'sub-meta--live': streaming }"
                  :initial="{ opacity: 0, y: 4 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -4 }"
                  :transition="{ duration: 0.18, ease: fadeEase }"
                >
                  {{ meta }}
                </motion.span>
              </AnimatePresence>
            </span>
            <motion.span
              class="sub-chev"
              :animate="{ rotate: expanded ? 90 : 0 }"
              :transition="chevSpring"
              aria-hidden="true"
            >
              <HugeiconsIcon :icon="ArrowRight01Icon" :size="14" :stroke-width="2" />
            </motion.span>
          </span>
        </button>

        <div class="sub-body" :class="{ 'sub-body--open': expanded }">
          <div class="sub-body-inner">
            <div ref="scrollEl" class="picker-scroll sub-scroll" :class="{ 'sub-scroll--scroll': canScroll }">
              <AnimatePresence mode="wait">
                <motion.p
                  v-if="!props.rows.length"
                  key="empty"
                  class="sub-empty"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -4 }"
                  :transition="{ duration: 0.2, ease: fadeEase }"
                >
                  {{ streaming ? "Delegating…" : "No subagents" }}
                </motion.p>
              </AnimatePresence>

              <AnimatePresence :initial="false">
                <motion.button
                  v-for="(row, index) in props.rows"
                  :key="row.id"
                  type="button"
                  class="sub-row"
                  :class="{
                    'sub-row--live': row.live,
                    'sub-row--done': row.state === 'done',
                    'sub-row--failed': row.state === 'failed',
                  }"
                  :aria-label="rowLabel(row)"
                  :title="rowLabel(row)"
                  layout
                  :initial="{ opacity: 0, y: 8, scale: 0.98 }"
                  :animate="{ opacity: 1, y: 0, scale: 1 }"
                  :exit="{ opacity: 0, y: -6, scale: 0.98 }"
                  :transition="{ ...rowSpring, delay: rowDelay(index) }"
                  @click="emit('open', row)"
                >
                  <span class="sub-state" aria-hidden="true">
                    <span class="sub-state-stack">
                      <!-- Every non-terminal state wears the working orb, which
                           is what a native run already does for `starting` as
                           well as `running`. A spawned thread parked on the
                           user, or one that hasn't turned yet, is still a
                           delegate in flight; its hint line says which. -->
                      <motion.span
                        class="sub-state-orb"
                        :animate="{
                          opacity: row.live || row.state === 'idle' ? 1 : 0,
                          scale: row.live || row.state === 'idle' ? 1 : 0.9,
                        }"
                        :transition="stateFade"
                      >
                        <TurnOrb
                          :state="row.thinking ? 'thinking' : 'working'"
                          :size="14"
                          :aria-label="row.thinking ? 'Thinking' : 'Running'"
                        />
                      </motion.span>
                      <motion.span
                        class="sub-state-mark sub-state-mark--done"
                        :animate="{
                          opacity: row.state === 'done' ? 1 : 0,
                          scale: row.state === 'done' ? 1 : 0.88,
                        }"
                        :transition="stateFade"
                      >
                        <span class="sub-state-glyph sub-state-glyph--done">✓</span>
                      </motion.span>
                      <motion.span
                        class="sub-state-mark sub-state-mark--failed"
                        :animate="{
                          opacity: row.state === 'failed' ? 1 : 0,
                          scale: row.state === 'failed' ? 1 : 0.88,
                        }"
                        :transition="stateFade"
                      >
                        <span class="sub-state-glyph sub-state-glyph--failed">×</span>
                      </motion.span>
                    </span>
                  </span>

                  <span class="sub-run">
                    <span class="sub-run-title" :title="row.title">{{ row.title }}</span>

                    <span class="sub-run-meta">
                      <span class="sub-run-model">
                        <ProviderLogo
                          v-if="rowBrand(row) !== 'generic'"
                          :brand="rowBrand(row)"
                          :size="13"
                        />
                        <span class="sub-run-model-name" :title="subagentModel(row).name">
                          {{ subagentModel(row).name }}
                        </span>
                        <span
                          v-if="subagentEffort(row)"
                          class="sub-run-effort"
                          :title="`Reasoning effort: ${subagentEffort(row)!.label}`"
                        >
                          <span class="sub-brains" :class="{ 'sub-brains--glow': subagentEffort(row)!.glow }">
                            <HugeiconsIcon
                              v-for="i in brainStack(subagentEffort(row)!.brains)"
                              :key="i"
                              :icon="AiBrain01Icon"
                              :size="12"
                              :stroke-width="2"
                              :style="{ color: subagentEffort(row)!.hue }"
                            />
                          </span>
                        </span>
                      </span>

                      <AnimatePresence mode="wait">
                        <motion.span
                          v-if="row.hint"
                          :key="row.hint"
                          class="sub-run-hint"
                          :title="row.hintFull ?? row.hint"
                          :initial="{ opacity: 0, y: 3 }"
                          :animate="{ opacity: 1, y: 0 }"
                          :exit="{ opacity: 0, y: -3 }"
                          :transition="{ duration: 0.18, ease: fadeEase }"
                        >
                          <span class="sub-run-hint-dot" aria-hidden="true">·</span>
                          {{ row.hint }}
                        </motion.span>
                      </AnimatePresence>
                    </span>

                    <!-- A spawned child parked on an approval can be answered
                         right here — the ask is not reachable through the parent
                         session, so this reads the registry-level inbox and
                         decides via agent:respond. Stops propagation so the row
                         doesn't also open. -->
                    <AnimatePresence mode="wait">
                      <motion.span
                        v-if="rowApproval(row)"
                        :key="rowApproval(row)!.requestId"
                        class="sub-approve"
                        :initial="{ opacity: 0, y: 3 }"
                        :animate="{ opacity: 1, y: 0 }"
                        :exit="{ opacity: 0, y: -3 }"
                        :transition="{ duration: 0.18, ease: fadeEase }"
                        @click.stop
                      >
                        <span class="sub-approve-ask" :title="rowApproval(row)!.approval.title">
                          {{ rowApproval(row)!.approval.title }}
                        </span>
                        <span class="sub-approve-actions">
                          <span
                            class="sub-approve-btn"
                            role="button"
                            tabindex="0"
                            @click.stop="decideRowApproval(row, 'reject-once')"
                            @keydown.enter.prevent.stop="decideRowApproval(row, 'reject-once')"
                          >Reject</span>
                          <span
                            class="sub-approve-btn"
                            role="button"
                            tabindex="0"
                            @click.stop="decideRowApproval(row, 'allow-always')"
                            @keydown.enter.prevent.stop="decideRowApproval(row, 'allow-always')"
                          >Always</span>
                          <span
                            class="sub-approve-btn sub-approve-btn--allow"
                            role="button"
                            tabindex="0"
                            @click.stop="decideRowApproval(row, 'allow-once')"
                            @keydown.enter.prevent.stop="decideRowApproval(row, 'allow-once')"
                          >Allow</span>
                        </span>
                      </motion.span>
                    </AnimatePresence>
                  </span>

                  <!-- Stop a live nested run right from the dock — the parent
                       turn keeps running. Spawned threads aren't stop-able
                       here (their session is theirs); only provider-native
                       runs carry the affordance, and only while live. A span
                       (not a button): the row itself is a button. -->
                  <span
                    v-if="row.target.kind === 'run' && row.live"
                    class="sub-stop"
                    role="button"
                    tabindex="0"
                    :aria-label="`Stop ${row.title}`"
                    :title="`Stop ${row.title}`"
                    @click.stop="emit('stop-subagent', row.target.toolUseId)"
                    @keydown.enter.prevent.stop="emit('stop-subagent', row.target.toolUseId)"
                  >
                    <HugeiconsIcon :icon="StopIcon" :size="13" :stroke-width="2" />
                  </span>
                  <span class="sub-open" aria-hidden="true">
                    <HugeiconsIcon :icon="ArrowUpRight01Icon" :size="14" :stroke-width="2" />
                  </span>
                </motion.button>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  </motion.div>
</template>

<style scoped>
.sub-dock {
  width: min(18rem, calc(100vw - 2.5rem));
  pointer-events: auto;
  will-change: transform, opacity;
}

.sub-card {
  background: var(--ground);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.sub-shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  padding: 0 0 0.75rem 0.75rem;
  transition: padding-bottom 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.sub-shell--collapsed {
  padding-bottom: 0;
}

.sub-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: calc(100% + 0.75rem);
  margin: 0 0 0 -0.75rem;
  border: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  transition: opacity 0.18s ease;
}
.sub-header:hover {
  opacity: 0.88;
}

.sub-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.sub-header__trail {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding-right: 0.75rem;
}

.sub-peek {
  display: block;
  min-width: 0;
  max-width: 7rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.sub-meta-wrap {
  display: inline-flex;
  min-width: 1.75rem;
  justify-content: flex-end;
}

.sub-meta {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.sub-meta--live {
  color: var(--ink-soft);
}

.sub-chev {
  display: inline-flex;
  flex: none;
  opacity: 0.45;
}

.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.sub-card--collapsed .picker-header::before,
.sub-card--collapsed .picker-header::after {
  opacity: 0;
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
  transition: opacity 0.14s ease;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.sub-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.sub-body--open {
  grid-template-rows: 1fr;
}
.sub-body-inner {
  overflow: hidden;
  min-height: 0;
}

.sub-scroll {
  max-height: min(28rem, calc(100vh - 8rem));
  /* Hidden by default; only the settled-overflow check flips it to auto. */
  overflow-y: hidden;
}
.sub-scroll--scroll {
  overflow-y: auto;
}

.picker-scroll {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  overflow-x: hidden;
  padding: 0.125rem 0.75rem 0.125rem 0;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted) 40%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 6px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 35%, transparent);
}

.sub-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  width: 100%;
  padding: 0.5rem 0.5rem;
  border: 0;
  border-radius: 12px;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color 0.14s ease;
}
.sub-row:hover,
.sub-row:focus-visible {
  background: var(--hover);
  outline: none;
}
.sub-row:focus-visible {
  box-shadow: inset 0 0 0 1.5px color-mix(in srgb, var(--ink) 26%, transparent);
}

/* The open affordance — a quiet up-right arrow that slides in on hover/focus,
   so a row reads as a doorway into the run's transcript rather than a label. */
.sub-open {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  align-self: center;
  width: 16px;
  height: 16px;
  margin-left: auto;
  opacity: 0;
  transform: translate(-2px, 2px);
  color: var(--muted);
  transition: opacity 0.14s ease, transform 0.18s ease;
}
.sub-row:hover .sub-open,
.sub-row:focus-visible .sub-open {
  opacity: 0.85;
  transform: none;
}
.sub-row--live .sub-open {
  opacity: 0.6;
  transform: none;
}

/* Stop affordance for a live nested run — quiet square that lifts on hover
   like the open arrow, but shown while the run is live so stopping is
   discoverable without hovering. */
.sub-stop {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  align-self: center;
  width: 18px;
  height: 18px;
  margin-left: auto;
  border-radius: 6px;
  color: var(--muted);
  opacity: 0.55;
  transition:
    opacity 0.14s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}
.sub-stop:hover,
.sub-stop:focus-visible {
  opacity: 1;
  background: var(--hover);
  color: var(--ink);
}

.sub-state {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
  margin-top: 1px;
}

.sub-state-stack {
  position: relative;
  width: 16px;
  height: 16px;
}

.sub-state-orb,
.sub-state-mark {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.sub-state-glyph {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  font-size: 10px;
  line-height: 1;
  /* Check and cross both sit on a filled state chip — accent-ink is the theme's
     ink for text on a coloured fill, where white only works in some themes. */
  color: var(--accent-ink);
  border-radius: 5px;
}
.sub-state-glyph--done {
  background: color-mix(in oklab, var(--ok) 88%, transparent);
}
.sub-state-glyph--failed {
  background: color-mix(in oklab, var(--danger) 82%, transparent);
}

.sub-run {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  min-width: 0;
  flex: 1;
}

.sub-run-title {
  min-width: 0;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.3;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-row--live .sub-run-title {
  color: var(--ink);
}
.sub-row--done .sub-run-title {
  color: var(--muted);
}

/* Model group + live tool hint share one row. */
.sub-run-meta {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
}

/* Engine identity — logomark · human model name · effort brains. */
.sub-run-model {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  flex: none;
  min-width: 0;
}
.sub-run-model :deep(.plogo) {
  flex: none;
  opacity: 0.9;
}
.sub-run-model-name {
  min-width: 0;
  font-size: 11.5px;
  font-weight: 500;
  letter-spacing: -0.005em;
  color: var(--muted);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.sub-run-effort {
  display: inline-flex;
  align-items: center;
  flex: none;
  margin-left: 0.05rem;
}
.sub-brains {
  display: inline-flex;
  align-items: center;
}
.sub-brains > :deep(svg) {
  margin-left: -5px;
}
.sub-brains > :deep(svg:first-child) {
  margin-left: 0;
}
.sub-brains--glow > :deep(svg) {
  filter: drop-shadow(0 0 3px currentColor);
}

.sub-run-hint {
  display: flex;
  align-items: center;
  gap: 0.3rem;
  min-width: 0;
  flex: 1;
  font-size: 11px;
  font-weight: 450;
  letter-spacing: -0.005em;
  line-height: 1.3;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-run-hint-dot {
  color: var(--muted);
  opacity: 0.6;
}

/* The inline approval — a parked child's ask answered in the row: the command
   line or path, then the three decisions, in the row's own compact voice. */
.sub-approve {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  margin-top: 0.2rem;
  padding: 0.3rem 0.4rem;
  border-radius: 9px;
  background: color-mix(in oklab, var(--accent) 8%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in oklab, var(--accent) 20%, transparent);
}
.sub-approve-ask {
  min-width: 0;
  flex: 1;
  font-size: 11px;
  font-family: var(--font-mono, ui-monospace, "SF Mono", Menlo, monospace);
  line-height: 1.3;
  color: var(--ink-soft);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sub-approve-actions {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  flex: none;
}
.sub-approve-btn {
  padding: 0.15rem 0.5rem;
  border-radius: 999px;
  font-size: 10.5px;
  font-weight: 600;
  letter-spacing: 0.01em;
  color: var(--muted);
  cursor: pointer;
  user-select: none;
  transition: color 0.14s ease, background-color 0.14s ease;
}
.sub-approve-btn:hover,
.sub-approve-btn:focus-visible {
  color: var(--ink);
  background: var(--hover);
  outline: none;
}
.sub-approve-btn--reject:hover,
.sub-approve-btn--reject:focus-visible {
  color: var(--danger);
}
.sub-approve-btn--allow {
  color: var(--ground);
  background: var(--ink);
}
.sub-approve-btn--allow:hover,
.sub-approve-btn--allow:focus-visible {
  color: var(--ground);
  background: var(--ink);
  opacity: 0.85;
}

.sub-empty {
  margin: 0;
  padding: 0.4rem 0.5rem;
  font-size: 13px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .sub-card,
  .sub-shell,
  .sub-body,
  .picker-header::before,
  .picker-header::after {
    transition: none;
  }
  .sub-dock {
    will-change: auto;
  }
}
</style>
