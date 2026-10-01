<script setup lang="ts">
import { Route01Icon, RoboticIcon, UserMultiple02Icon } from "@hugeicons/core-free-icons";
import { HugeiconsIcon } from "@hugeicons/vue";

// The three things the Teams page holds, each said once in plain words: who
// takes a thread, who an agent hands a piece of it to, and what model the work
// runs on. Each column is also the way into its tab, and the open tab's column
// is lit, so the words sit beside the list they describe.

type Tab = "agents" | "subagents" | "routing";

defineProps<{ tab: Tab; open: boolean }>();
defineEmits<{ pick: [tab: Tab] }>();

const PARTS = [
  {
    tab: "agents",
    icon: UserMultiple02Icon,
    title: "Agents",
    body:
      "Who you hand a thread to. Each keeps its name, face and instructions across every conversation. A project's team is the agents that can work in it, and teammates delegate to each other.",
  },
  {
    tab: "subagents",
    icon: RoboticIcon,
    title: "Workers",
    body:
      "Who an agent hands one short job to: find something, run something, make one edit. Built-ins are tested patterns; your own carry the instructions you write.",
  },
  {
    tab: "routing",
    icon: Route01Icon,
    title: "Rules",
    body:
      "What model each kind of work runs on. When an agent hands off a quick fix or a review, the rule for it picks the model, unless the hand-off, worker or teammate already names one.",
  },
] as const;
</script>

<template>
  <div class="tx" role="group" aria-label="How a team works">
    <button
      v-for="p in PARTS"
      :key="p.tab"
      type="button"
      class="tx__part"
      :class="{ 'is-on': tab === p.tab }"
      :aria-pressed="tab === p.tab"
      :tabindex="open ? 0 : -1"
      @click="$emit('pick', p.tab)"
    >
      <span class="tx__head">
        <HugeiconsIcon :icon="p.icon" :size="14" :stroke-width="1.8" aria-hidden="true" />
        <span class="tx__title">{{ p.title }}</span>
      </span>
      <span class="tx__body">{{ p.body }}</span>
    </button>
  </div>
</template>

<style scoped>
/* Three columns once each can hold its sentences at a readable measure;
   stacked below that. */
.tx {
  display: grid;
  grid-template-columns: 1fr;
  gap: 8px;
}
@container (min-width: 620px) {
  .tx {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
}

.tx__part {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px 13px;
  border-radius: 14px;
  text-align: start;
  color: var(--ink-soft);
  cursor: pointer;
  outline: none;
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition:
    background-color 180ms ease,
    box-shadow 180ms ease,
    color 180ms ease;
}
.tx__part:hover {
  background-color: color-mix(in srgb, var(--ink) 2.5%, transparent);
}
.tx__part:focus-visible {
  box-shadow: inset 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}
/* The open tab's column takes a ground and drops its outline, so it reads as
   the one being described rather than one more box. */
.tx__part.is-on {
  background-color: color-mix(in srgb, var(--ink) 4%, transparent);
  box-shadow: none;
  color: var(--ink);
}

.tx__head {
  display: flex;
  align-items: center;
  gap: 7px;
  color: var(--muted);
  transition: color 180ms ease;
}
.tx__part.is-on .tx__head {
  color: var(--accent);
}
.tx__title {
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink);
}
.tx__body {
  font-size: 12.5px;
  line-height: 1.5;
  text-wrap: pretty;
}

@media (prefers-reduced-motion: reduce) {
  .tx__part,
  .tx__head {
    transition: none;
  }
}
</style>
