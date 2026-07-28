<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/TurnOrb.vue";
import { planTaskCounts, type PlanTask } from "~/utils/planTasks";

const props = defineProps<{
  tasks: PlanTask[];
  streaming?: boolean;
}>();

const { cue } = useSound();

const expanded = ref(true);
const shellEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

const counts = computed(() => planTaskCounts(props.tasks));

function taskLabel(task: PlanTask): string {
  return task.status === "in-progress" && task.activeForm ? task.activeForm : task.content;
}

const meta = computed(() => {
  const { total, completed } = counts.value;
  if (!total) return props.streaming ? "…" : "0";
  return `${completed}/${total}`;
});

const liveTask = computed(() => props.tasks.find((t) => t.status === "in-progress"));

function syncHeight(): void {
  const el = shellEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function toggle(): void {
  expanded.value = !expanded.value;
  cue("toggle");
}

// Drafting opens the body; a settled plan eases shut after a beat so the
// collapse never races the last task tick.
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
      }, 720);
    }
  },
);

watch([expanded, () => props.tasks], () => {
  void nextTick(syncHeight);
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
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
const rowSpring = { type: "spring", stiffness: 460, damping: 24, mass: 0.65 } as const;
const fadeEase = [0.22, 1, 0.36, 1] as const;
const checkFade = { duration: 0.16, ease: fadeEase } as const;
const chevSpring = { type: "spring", stiffness: 520, damping: 30, mass: 0.45 } as const;

function rowDelay(index: number): number {
  return Math.min(index * 0.045, 0.28);
}
</script>

<template>
  <motion.div
    class="plan-dock"
    :style="{ transformOrigin: '100% 100%' }"
    :initial="{ opacity: 0, y: 16, scale: 0.94 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 12, scale: 0.95 }"
    :transition="cardSpring"
    aria-label="Agent task plan"
  >
    <div
      class="plan-card"
      :class="{ 'plan-card--collapsed': !expanded }"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
    >
      <div
        ref="shellEl"
        class="plan-shell"
        :class="{ 'plan-shell--collapsed': !expanded }"
      >
        <button
          type="button"
          class="picker-header plan-header"
          :aria-expanded="expanded"
          @click="toggle"
        >
          <span class="plan-title">Tasks</span>
          <span class="plan-header__trail">
            <AnimatePresence mode="wait">
              <motion.span
                v-if="!expanded && liveTask"
                :key="liveTask.id"
                class="plan-peek"
                :title="taskLabel(liveTask)"
                :initial="{ opacity: 0, x: 8, filter: 'blur(4px)' }"
                :animate="{ opacity: 1, x: 0, filter: 'blur(0px)' }"
                :exit="{ opacity: 0, x: -6, filter: 'blur(3px)' }"
                :transition="{ duration: 0.22, ease: fadeEase }"
              >
                {{ taskLabel(liveTask) }}
              </motion.span>
            </AnimatePresence>
            <span class="plan-meta-wrap">
              <AnimatePresence mode="wait">
                <motion.span
                  :key="meta"
                  class="plan-meta"
                  :class="{ 'plan-meta--live': streaming }"
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
              class="plan-chev"
              :animate="{ rotate: expanded ? 90 : 0 }"
              :transition="chevSpring"
              aria-hidden="true"
            >
              <HugeiconsIcon :icon="ArrowRight01Icon" :size="14" :stroke-width="2" />
            </motion.span>
          </span>
        </button>

        <div class="plan-body" :class="{ 'plan-body--open': expanded }">
          <div class="plan-body-inner">
            <div class="picker-scroll plan-scroll">
              <AnimatePresence mode="wait">
                <motion.p
                  v-if="!props.tasks.length"
                  key="empty"
                  class="plan-empty"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -4 }"
                  :transition="{ duration: 0.2, ease: fadeEase }"
                >
                  {{ streaming ? "Drafting…" : "No tasks" }}
                </motion.p>
              </AnimatePresence>

              <AnimatePresence :initial="false">
                <motion.div
                  v-for="(task, index) in props.tasks"
                  :key="task.id"
                  class="plan-row"
                  :class="{
                    'plan-row--done': task.status === 'completed',
                    'plan-row--live': task.status === 'in-progress',
                  }"
                  layout
                  :initial="{ opacity: 0, y: 8, scale: 0.98 }"
                  :animate="{ opacity: 1, y: 0, scale: 1 }"
                  :exit="{ opacity: 0, y: -6, scale: 0.98 }"
                  :transition="{ ...rowSpring, delay: rowDelay(index) }"
                >
                  <span
                    class="plan-check"
                    :class="{
                      'plan-check--pending': task.status === 'pending',
                      'plan-check--live': task.status === 'in-progress',
                      'plan-check--done': task.status === 'completed',
                    }"
                    aria-hidden="true"
                  >
                    <span class="plan-check-stack">
                      <motion.span
                        class="plan-check-orb"
                        :animate="{
                          opacity: task.status === 'in-progress' ? 1 : 0,
                          scale: task.status === 'in-progress' ? 1 : 0.9,
                        }"
                        :transition="checkFade"
                      >
                        <TurnOrb
                          v-if="task.status !== 'pending'"
                          state="working"
                          :size="12"
                          aria-label="In progress"
                        />
                      </motion.span>
                      <motion.span
                        class="plan-check-mark"
                        :animate="{
                          opacity: task.status === 'completed' ? 1 : 0,
                          scale: task.status === 'completed' ? 1 : 0.88,
                        }"
                        :transition="checkFade"
                      >
                        <span class="plan-check-on">✓</span>
                      </motion.span>
                    </span>
                  </span>
                  <motion.span
                    class="plan-label"
                    :title="taskLabel(task)"
                    layout
                    :transition="{ type: 'spring', stiffness: 380, damping: 32, mass: 0.7 }"
                  >
                    {{ taskLabel(task) }}
                  </motion.span>
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
.plan-dock {
  width: min(17rem, calc(100vw - 2.5rem));
  pointer-events: auto;
  will-change: transform, opacity;
}

.plan-card {
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.plan-shell {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
  padding: 0 0 0.75rem 0.75rem;
  transition: padding-bottom 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.plan-shell--collapsed {
  padding-bottom: 0;
}

.plan-header {
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
.plan-header:hover {
  opacity: 0.88;
}

.plan-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.plan-header__trail {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding-right: 0.75rem;
}

.plan-peek {
  display: block;
  min-width: 0;
  max-width: 6.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.plan-meta-wrap {
  display: inline-flex;
  min-width: 1.75rem;
  justify-content: flex-end;
}

.plan-meta {
  display: block;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
  color: var(--muted);
}
.plan-meta--live {
  color: var(--ink-soft);
}

.plan-chev {
  display: inline-flex;
  flex: none;
  opacity: 0.45;
}

.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.plan-card--collapsed .picker-header::before,
.plan-card--collapsed .picker-header::after {
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
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.plan-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.plan-body--open {
  grid-template-rows: 1fr;
}
.plan-body-inner {
  overflow: hidden;
  min-height: 0;
}

.plan-scroll {
  /* Grow to fit the task list; only scroll once it would run off-screen. */
  max-height: min(28rem, calc(100vh - 8rem));
}

.picker-scroll {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  overflow-y: auto;
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

.plan-row {
  display: flex;
  align-items: flex-start;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: 10px;
}

.plan-check {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 15px;
  height: 15px;
  margin-top: 1px;
  border-radius: 4px;
  background: var(--hover);
  overflow: hidden;
  transition: background-color 0.16s cubic-bezier(0.22, 1, 0.36, 1);
}

.plan-check--live,
.plan-check--done {
  background: transparent;
}

.plan-check-stack {
  position: relative;
  width: 15px;
  height: 15px;
}

.plan-check-orb,
.plan-check-mark {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  pointer-events: none;
}

.plan-check-on {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  font-size: 10px;
  line-height: 1;
  color: #fff;
  background: color-mix(in oklab, var(--accent) 88%, transparent);
  border-radius: inherit;
}

.plan-label {
  min-width: 0;
  flex: 1;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.35;
  color: var(--ink-soft);
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
  transition:
    color 0.28s cubic-bezier(0.22, 1, 0.36, 1),
    text-decoration-color 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}

.plan-row--live .plan-label {
  color: var(--ink);
}

.plan-row--done .plan-label {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.plan-empty {
  margin: 0;
  padding: 0.35rem 0.5rem;
  font-size: 13px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .plan-card,
  .plan-shell,
  .plan-body,
  .picker-header::before,
  .picker-header::after,
  .plan-label {
    transition: none;
  }
  .plan-dock {
    will-change: auto;
  }
}
</style>
