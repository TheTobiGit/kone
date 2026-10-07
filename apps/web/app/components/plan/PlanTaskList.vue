<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckmarkCircle01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import DockSection from "~/components/thread/DockSection.vue";
import { useDockSection } from "~/composables/useDockSections";
import { formatPlanTasks, planTaskCounts, type PlanTask } from "~/utils/planTasks";

// The Tasks section of the thread dock — the agent's plan, ticking itself off.

const props = defineProps<{
  tasks: PlanTask[];
  streaming?: boolean;
}>();

const { cue } = useSound();

// Open only when the section mounts into a live turn — the user is here
// watching work happen. Reopening a settled thread mounts collapsed: they came
// back to read the response, not to re-scan the checklist. The streaming watch
// below still opens it when a turn starts mid-thread.
const expanded = ref(props.streaming ?? false);
useDockSection("tasks", expanded);

const counts = computed(() => planTaskCounts(props.tasks));

function taskLabel(task: PlanTask): string {
  return task.status === "in-progress" && task.activeForm ? task.activeForm : task.content;
}

const meta = computed(() => {
  const { total, completed } = counts.value;
  if (!total) return props.streaming ? "…" : "0";
  return `${completed}/${total}`;
});

// Copy the plan out as markdown checkboxes — the same serialization
// formatPlanTasks uses to rebuild a plan, so pasting it into a thread (or an
// issue) round-trips. A brief ✓ swap on the button confirms the copy.
const copied = ref(false);
let copyTimer: ReturnType<typeof setTimeout> | null = null;
async function copyPlan() {
  if (!props.tasks.length) return;
  const md = formatPlanTasks(props.tasks);
  try {
    await navigator.clipboard.writeText(md);
    copied.value = true;
    cue("copy");
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => (copied.value = false), 1400);
  } catch {
    // Clipboard blocked — the plan is still on screen; stay quiet.
  }
}

const liveTask = computed(() => props.tasks.find((t) => t.status === "in-progress"));

function toggle(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
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

onBeforeUnmount(() => {
  if (collapseTimer) clearTimeout(collapseTimer);
  if (copyTimer) clearTimeout(copyTimer);
});

const rowSpring = { type: "spring", stiffness: 460, damping: 24, mass: 0.65 } as const;
const fadeEase = [0.22, 1, 0.36, 1] as const;
const checkFade = { duration: 0.16, ease: fadeEase } as const;

function rowDelay(index: number): number {
  return Math.min(index * 0.045, 0.28);
}
</script>

<template>
  <DockSection label="Tasks" :expanded="expanded" @toggle="toggle">
    <template #trail>
      <AnimatePresence mode="wait">
        <motion.span
          v-if="!expanded && liveTask"
          :key="liveTask.id"
          class="dock-peek"
          :title="taskLabel(liveTask)"
          :initial="{ opacity: 0, x: 8 }"
          :animate="{ opacity: 1, x: 0 }"
          :exit="{ opacity: 0, x: -6 }"
          :transition="{ duration: 0.22, ease: fadeEase }"
        >
          {{ taskLabel(liveTask) }}
        </motion.span>
      </AnimatePresence>
      <!-- Copy the plan as markdown checkboxes. A span (not a button): the head
           itself is a button, and nesting interactive elements inside one is
           invalid HTML. -->
      <span
        v-if="props.tasks.length"
        class="plan-copy"
        :class="{ 'plan-copy--copied': copied }"
        role="button"
        tabindex="0"
        :aria-label="copied ? 'Plan copied' : 'Copy plan as markdown'"
        :title="copied ? 'Copied' : 'Copy plan as markdown'"
        @click.stop="copyPlan"
        @keydown.enter.prevent.stop="copyPlan"
      >
        <HugeiconsIcon
          :icon="copied ? CheckmarkCircle01Icon : Copy01Icon"
          :size="13"
          :stroke-width="2"
        />
      </span>
      <span class="plan-meta-wrap">
        <AnimatePresence mode="wait">
          <motion.span
            :key="meta"
            class="dock-count"
            :class="{ 'dock-count--live': streaming }"
            :initial="{ opacity: 0, y: 4 }"
            :animate="{ opacity: 1, y: 0 }"
            :exit="{ opacity: 0, y: -4 }"
            :transition="{ duration: 0.18, ease: fadeEase }"
          >
            {{ meta }}
          </motion.span>
        </AnimatePresence>
      </span>
    </template>

    <div class="dock-scroll">
      <AnimatePresence mode="wait">
        <motion.p
          v-if="!props.tasks.length"
          key="empty"
          class="dock-empty"
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
                  :size="14"
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
  </DockSection>
</template>

<style scoped>
.plan-meta-wrap {
  display: inline-flex;
  align-items: center;
  min-width: 1.75rem;
  height: 20px;
  justify-content: flex-end;
}

/* Copy-as-markdown — a quiet icon in the head's trail that lifts on hover;
   flips to a checkmark after a copy. */
.plan-copy {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 20px;
  height: 20px;
  border-radius: 6px;
  color: var(--muted);
  opacity: 0.55;
  cursor: pointer;
  transition:
    opacity 0.15s ease,
    background-color 0.15s ease,
    color 0.15s ease;
}
.plan-copy:hover,
.plan-copy:focus-visible {
  opacity: 1;
  background: var(--hover);
  color: var(--ink);
}
.plan-copy--copied {
  opacity: 1;
  color: var(--accent);
}

.plan-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.35rem 0.55rem;
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
  font-size: 12.5px;
  font-weight: 500;
  letter-spacing: -0.01em;
  line-height: 1.4;
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

@media (prefers-reduced-motion: reduce) {
  .plan-label {
    transition: none;
  }
}
</style>
