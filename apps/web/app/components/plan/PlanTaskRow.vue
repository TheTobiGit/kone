<script setup lang="ts">
import { motion } from "motion-v";
import TurnOrb from "~/components/turn/TurnOrb.vue";
import { labelForTask, type PlanTask } from "~/utils/planTasks";

// One checklist row: the check (a box, the working orb, a tick) and the label.
// A subtask draws the same row a step in and a size down, so it reads as part
// of the task above it rather than as a task of its own.

const props = defineProps<{
  task: PlanTask;
  nested?: boolean;
}>();

const fadeEase = [0.22, 1, 0.36, 1] as const;
const checkFade = { duration: 0.16, ease: fadeEase } as const;
</script>

<template>
  <div
    class="plan-row"
    :class="{
      'plan-row--done': props.task.status === 'completed',
      'plan-row--live': props.task.status === 'in-progress',
      'plan-row--nested': props.nested,
    }"
  >
    <span
      class="plan-check"
      :class="{
        'plan-check--pending': props.task.status === 'pending',
        'plan-check--live': props.task.status === 'in-progress',
        'plan-check--done': props.task.status === 'completed',
      }"
      aria-hidden="true"
    >
      <span class="plan-check-stack">
        <motion.span
          class="plan-check-orb"
          :animate="{
            opacity: props.task.status === 'in-progress' ? 1 : 0,
            scale: props.task.status === 'in-progress' ? 1 : 0.9,
          }"
          :transition="checkFade"
        >
          <TurnOrb
            v-if="props.task.status !== 'pending'"
            state="working"
            :size="props.nested ? 12 : 14"
            aria-label="In progress"
          />
        </motion.span>
        <motion.span
          class="plan-check-mark"
          :animate="{
            opacity: props.task.status === 'completed' ? 1 : 0,
            scale: props.task.status === 'completed' ? 1 : 0.88,
          }"
          :transition="checkFade"
        >
          <span class="plan-check-on">✓</span>
        </motion.span>
      </span>
    </span>
    <motion.span
      class="plan-label"
      :title="labelForTask(props.task)"
      layout
      :transition="{ type: 'spring', stiffness: 380, damping: 32, mass: 0.7 }"
    >
      {{ labelForTask(props.task) }}
    </motion.span>
    <slot name="trail" />
  </div>
</template>

<style scoped>
.plan-row {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  padding: 0.35rem 0.55rem;
  border-radius: 10px;
}

/* A step in, under the task's label rather than its box, and a touch smaller:
   the subtask belongs to the row above it. */
.plan-row--nested {
  padding: 0.2rem 0.55rem 0.2rem 1.9rem;
  gap: 0.5rem;
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

.plan-row--nested .plan-check {
  width: 13px;
  height: 13px;
  margin-top: 2px;
  border-radius: 3.5px;
}

.plan-check--live,
.plan-check--done {
  background: transparent;
}

.plan-check-stack {
  position: relative;
  width: 100%;
  height: 100%;
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

.plan-row--nested .plan-check-on {
  font-size: 9px;
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

.plan-row--nested .plan-label {
  font-size: 12px;
  font-weight: 450;
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
