<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon, AiBrain01Icon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import ProviderLogo from "~/components/ProviderLogo.vue";
import { describeModelId, EFFORT_META } from "~/utils/modelCatalog";
import type { EffortTier } from "~/utils/modelCatalog";
import type { SubagentRunView } from "~/utils/subagentRuns";

// The corner "Subagents" dock — a sibling of the Changes dock (ChangedFilesList)
// and the Tasks dock (PlanTaskList) in the same folder-picker shell, docked
// bottom-right while a turn spawns nested agents. It lists every subagent the
// main agent has delegated to this thread: its role, the one-line brief, its
// model, and a live status (working orb → ✓/✕ when it settles) with the tool it
// last ran as a progress hint. Purely presentational — it renders the runs the
// reducer already nested onto their spawning tool calls (deriveActiveSubagents).

const props = defineProps<{
  runs: SubagentRunView[];
  /** A subagent is still running — keeps the dock open. */
  streaming?: boolean;
}>();

const { cue } = useSound();

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

// worker-<tier> agents exist only to carry reasoning effort, so their role isn't
// a meaningful label — fall back to the description instead.
const WORKER_TIER = /^worker-(?:low|medium|high|xhigh)$/i;

function isWorkerTier(role: string | undefined): boolean {
  return typeof role === "string" && WORKER_TIER.test(role.trim());
}

function runTitle(run: SubagentRunView): string {
  if (run.description) return run.description;
  if (run.agentType && !isWorkerTier(run.agentType)) return run.agentType;
  return "Subagent";
}

/** The engine's logomark + human model name (never the raw id). */
function runModel(run: SubagentRunView): { brand: ReturnType<typeof describeModelId>["brand"]; name: string } {
  return describeModelId(run.model);
}

/** Our effort indicator — the same brain-cluster + hue the composer uses. */
function runEffort(run: SubagentRunView): (typeof EFFORT_META)[EffortTier] | null {
  const tier = run.effort as EffortTier | undefined;
  if (!tier) return null;
  const meta = EFFORT_META[tier];
  if (!meta || tier === "base" || tier === "none") return null;
  return meta;
}

function brainStack(n: number): number[] {
  return Array.from({ length: Math.max(1, n) }, (_, i) => i);
}

/** The live tool hint while the child works — a bare progress line. */
function runHint(run: SubagentRunView): string {
  return run.live && run.lastToolName ? `Running ${run.lastToolName}…` : "";
}

const running = computed(() => props.runs.filter((r) => r.live).length);

const meta = computed(() => {
  const total = props.runs.length;
  if (!total) return props.streaming ? "…" : "0";
  return running.value > 0 ? `${running.value}/${total}` : String(total);
});

const liveRun = computed(() => props.runs.find((r) => r.live));

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

watch([expanded, () => props.runs], () => {
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
                :key="liveRun.toolUseId"
                class="sub-peek"
                :title="runTitle(liveRun)"
                :initial="{ opacity: 0, x: 8, filter: 'blur(4px)' }"
                :animate="{ opacity: 1, x: 0, filter: 'blur(0px)' }"
                :exit="{ opacity: 0, x: -6, filter: 'blur(3px)' }"
                :transition="{ duration: 0.22, ease: fadeEase }"
              >
                {{ runTitle(liveRun) }}
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
                  v-if="!props.runs.length"
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
                <motion.div
                  v-for="(run, index) in props.runs"
                  :key="run.toolUseId"
                  class="sub-row"
                  :class="{
                    'sub-row--live': run.live,
                    'sub-row--done': run.status === 'completed',
                    'sub-row--failed': run.status === 'failed' || run.status === 'stopped',
                  }"
                  layout
                  :initial="{ opacity: 0, y: 8, scale: 0.98 }"
                  :animate="{ opacity: 1, y: 0, scale: 1 }"
                  :exit="{ opacity: 0, y: -6, scale: 0.98 }"
                  :transition="{ ...rowSpring, delay: rowDelay(index) }"
                >
                  <span class="sub-state" aria-hidden="true">
                    <span class="sub-state-stack">
                      <motion.span
                        class="sub-state-orb"
                        :animate="{ opacity: run.live ? 1 : 0, scale: run.live ? 1 : 0.9 }"
                        :transition="stateFade"
                      >
                        <TurnOrb state="working" :size="14" aria-label="Running" />
                      </motion.span>
                      <motion.span
                        class="sub-state-mark sub-state-mark--done"
                        :animate="{
                          opacity: run.status === 'completed' ? 1 : 0,
                          scale: run.status === 'completed' ? 1 : 0.88,
                        }"
                        :transition="stateFade"
                      >
                        <span class="sub-state-glyph sub-state-glyph--done">✓</span>
                      </motion.span>
                      <motion.span
                        class="sub-state-mark sub-state-mark--failed"
                        :animate="{
                          opacity: run.status === 'failed' || run.status === 'stopped' ? 1 : 0,
                          scale: run.status === 'failed' || run.status === 'stopped' ? 1 : 0.88,
                        }"
                        :transition="stateFade"
                      >
                        <span class="sub-state-glyph sub-state-glyph--failed">×</span>
                      </motion.span>
                    </span>
                  </span>

                  <span class="sub-run">
                    <span class="sub-run-title" :title="runTitle(run)">{{ runTitle(run) }}</span>

                    <span class="sub-run-meta">
                      <span class="sub-run-model">
                        <ProviderLogo
                          v-if="runModel(run).brand !== 'generic'"
                          :brand="runModel(run).brand"
                          :size="13"
                        />
                        <span class="sub-run-model-name" :title="runModel(run).name">
                          {{ runModel(run).name }}
                        </span>
                        <span
                          v-if="runEffort(run)"
                          class="sub-run-effort"
                          :title="`Reasoning effort: ${runEffort(run)!.label}`"
                        >
                          <span class="sub-brains" :class="{ 'sub-brains--glow': runEffort(run)!.glow }">
                            <HugeiconsIcon
                              v-for="i in brainStack(runEffort(run)!.brains)"
                              :key="i"
                              :icon="AiBrain01Icon"
                              :size="12"
                              :stroke-width="2"
                              :style="{ color: runEffort(run)!.hue }"
                            />
                          </span>
                        </span>
                      </span>

                      <AnimatePresence mode="wait">
                        <motion.span
                          v-if="runHint(run)"
                          :key="runHint(run)"
                          class="sub-run-hint"
                          :title="runHint(run)"
                          :initial="{ opacity: 0, y: 3 }"
                          :animate="{ opacity: 1, y: 0 }"
                          :exit="{ opacity: 0, y: -3 }"
                          :transition="{ duration: 0.18, ease: fadeEase }"
                        >
                          <span class="sub-run-hint-dot" aria-hidden="true">·</span>
                          {{ runHint(run) }}
                        </motion.span>
                      </AnimatePresence>
                    </span>
                  </span>
                </motion.div>
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
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.sub-shell {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
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
  padding: 0.5rem 0.5rem;
  border-radius: 12px;
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
  color: #fff;
  border-radius: 5px;
}
.sub-state-glyph--done {
  background: color-mix(in oklab, var(--accent) 88%, transparent);
}
.sub-state-glyph--failed {
  background: color-mix(in oklab, var(--danger, #e5484d) 82%, transparent);
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
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
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
