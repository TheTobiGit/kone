<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { CheckmarkCircle01Icon, Copy01Icon } from "@hugeicons/core-free-icons";
import DockSection from "~/components/thread/DockSection.vue";
import PlanTaskRow from "~/components/plan/PlanTaskRow.vue";
import { useDockSection } from "~/composables/useDockSections";
import { formatPlanTasks, labelForTask, planTaskCounts, type PlanTask } from "~/utils/planTasks";

// The Tasks section of the thread dock — the agent's plan, ticking itself off.
// A task that splits shows its subtasks under it until it is done; a checklist
// the provider kept beside kone's own folds into one quiet line at the foot.

const props = defineProps<{
  tasks: PlanTask[];
  streaming?: boolean;
  /** The provider's own checklist, when kone's list leads. */
  providerTasks?: PlanTask[];
}>();

const { cue } = useSound();

// Open only when the section mounts into a live turn — the user is here
// watching work happen. Reopening a settled thread mounts collapsed: they came
// back to read the response, not to re-scan the checklist. The streaming watch
// below still opens it when a turn starts mid-thread.
const expanded = ref(props.streaming ?? false);
useDockSection("tasks", expanded);

const counts = computed(() => planTaskCounts(props.tasks));

const meta = computed(() => {
  const { total, completed } = counts.value;
  if (!total) return props.streaming ? "…" : "0";
  return `${completed}/${total}`;
});

// Copy the plan out as markdown checkboxes — the serialization formatPlanTasks
// writes plan bodies in, with subtasks nested under their task — so it pastes
// into a thread or an issue as a checklist. A brief ✓ swap on the button
// confirms the copy.
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

/** The row the agent is on, for the folded head: inside a task that splits,
 *  the subtask under way. */
const liveTask = computed(() => {
  const task = props.tasks.find((t) => t.status === "in-progress");
  return task?.subtasks?.find((s) => s.status === "in-progress") ?? task;
});

function subtaskCount(task: PlanTask): string {
  const subs = task.subtasks ?? [];
  return `${subs.filter((s) => s.status === "completed").length}/${subs.length}`;
}

/** A finished task folds its subtasks away; the tick on the task says it. */
function openSubtasks(task: PlanTask): PlanTask[] {
  return task.status === "completed" ? [] : (task.subtasks ?? []);
}

const providerOpen = ref(false);
const providerCount = computed(() => {
  const { total, completed } = planTaskCounts(props.providerTasks ?? []);
  return `${completed}/${total}`;
});
function toggleProvider(): void {
  providerOpen.value = !providerOpen.value;
  cue(providerOpen.value ? "expand" : "collapse");
}

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
          :title="labelForTask(liveTask)"
          :initial="{ opacity: 0, x: 8 }"
          :animate="{ opacity: 1, x: 0 }"
          :exit="{ opacity: 0, x: -6 }"
          :transition="{ duration: 0.22, ease: fadeEase }"
        >
          {{ labelForTask(liveTask) }}
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
          class="plan-item"
          layout
          :initial="{ opacity: 0, y: 8, scale: 0.98 }"
          :animate="{ opacity: 1, y: 0, scale: 1 }"
          :exit="{ opacity: 0, y: -6, scale: 0.98 }"
          :transition="{ ...rowSpring, delay: rowDelay(index) }"
        >
          <PlanTaskRow :task="task">
            <template v-if="task.subtasks?.length" #trail>
              <span class="plan-sub-count">{{ subtaskCount(task) }}</span>
            </template>
          </PlanTaskRow>
          <AnimatePresence :initial="false">
            <motion.div
              v-for="sub in openSubtasks(task)"
              :key="sub.id"
              layout
              :initial="{ opacity: 0, y: 4 }"
              :animate="{ opacity: 1, y: 0 }"
              :exit="{ opacity: 0, y: -3 }"
              :transition="{ duration: 0.18, ease: fadeEase }"
            >
              <PlanTaskRow :task="sub" nested />
            </motion.div>
          </AnimatePresence>
        </motion.div>
      </AnimatePresence>

      <!-- The provider's own checklist, kept beside kone's: folded to one line,
           open on a click. -->
      <div v-if="props.providerTasks?.length" class="plan-provider">
        <button
          type="button"
          class="plan-provider__head"
          :aria-expanded="providerOpen"
          @click="toggleProvider"
        >
          <span>Also on the provider's own checklist</span>
          <span class="plan-sub-count">{{ providerCount }}</span>
        </button>
        <div v-if="providerOpen" class="plan-provider__rows">
          <PlanTaskRow v-for="task in props.providerTasks" :key="task.id" :task="task" nested />
        </div>
      </div>
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

/* The done count on a task that splits, and on the provider's line. */
.plan-sub-count {
  flex: none;
  margin-top: 2px;
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}

.plan-provider {
  margin-top: 0.3rem;
  padding-top: 0.3rem;
  border-top: 1px solid color-mix(in srgb, var(--muted) 18%, transparent);
}

.plan-provider__head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  width: 100%;
  padding: 0.3rem 0.55rem;
  border-radius: 8px;
  font-size: 11.5px;
  color: var(--muted);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.plan-provider__head:hover,
.plan-provider__head:focus-visible {
  background: var(--hover);
  color: var(--ink-soft);
}

.plan-provider__rows {
  opacity: 0.8;
}
</style>
