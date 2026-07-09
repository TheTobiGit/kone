<script setup lang="ts">
import { useNow } from "@vueuse/core";
import { computed, ref, watch } from "vue";

import { useMotionPreference } from "~/composables/useMotionPreference";
import { toolActivityLabel } from "~/lib/tool-labels";
import type { ToolActivity } from "~/types/conversation";

const props = defineProps<{
  activity: ToolActivity;
}>();

const expanded = ref(false);

const isActive = computed(
  () =>
    props.activity.status === "running" ||
    props.activity.status === "awaiting_permission",
);

const label = computed(() => toolActivityLabel(props.activity));

const { isDocumentVisible } = useMotionPreference();
const { now, pause, resume } = useNow({ interval: 1000, controls: true });

// Only tick the live clock while a tool is actually active and the tab is
// visible, so backgrounded/settled rows don't keep an interval running.
watch(
  () => isActive.value && isDocumentVisible.value,
  (shouldTick) => (shouldTick ? resume() : pause()),
  { immediate: true },
);

function formatDuration(ms: number, precise: boolean): string {
  const totalSeconds = Math.max(0, ms) / 1000;
  if (totalSeconds < 60) {
    if (precise && totalSeconds < 10) {
      return `${(Math.round(totalSeconds * 10) / 10).toFixed(1)}s`;
    }
    return `${Math.round(totalSeconds)}s`;
  }
  const totalWhole = Math.round(totalSeconds);
  const minutes = Math.floor(totalWhole / 60);
  const seconds = totalWhole % 60;
  return `${minutes}m ${seconds}s`;
}

const elapsedMs = computed(() => {
  const started = new Date(props.activity.startedAt).getTime();
  if (Number.isNaN(started)) return null;

  if (isActive.value) {
    return now.value.getTime() - started;
  }

  if (props.activity.completedAt) {
    const completed = new Date(props.activity.completedAt).getTime();
    if (Number.isNaN(completed)) return null;
    return completed - started;
  }

  return null;
});

const durationLabel = computed(() => {
  if (elapsedMs.value === null) return null;
  return formatDuration(elapsedMs.value, !isActive.value);
});
const hasDetails = computed(
  () =>
    Boolean(props.activity.command) ||
    Boolean(props.activity.inputSummary) ||
    Boolean(props.activity.outputSummary) ||
    props.activity.paths.length > 0,
);

const iconName = computed(() => {
  if (props.activity.status === "error") return "i-lucide-circle-alert";
  if (props.activity.status === "cancelled") return "i-lucide-circle-slash";
  if (props.activity.status === "completed") return "i-lucide-check";
  if (props.activity.kind === "write") return "i-lucide-pencil";
  if (props.activity.kind === "read") return "i-lucide-file-search";
  if (props.activity.kind === "search") return "i-lucide-search";
  if (props.activity.kind === "network") return "i-lucide-globe";
  if (props.activity.kind === "mcp") return "i-lucide-blocks";
  return "i-lucide-terminal";
});

const statusLabel = computed(() => {
  switch (props.activity.status) {
    case "awaiting_permission":
      return "Waiting for approval";
    case "running":
      return "Running";
    case "completed":
      return "Completed";
    case "error":
      return "Failed";
    case "cancelled":
      return "Cancelled";
    default:
      return "Queued";
  }
});
</script>

<template>
  <div class="group/tool py-1.5">
    <button
      type="button"
      class="flex w-full min-w-0 items-center gap-2 text-left text-xs transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
      :class="hasDetails ? 'cursor-pointer' : 'cursor-default'"
      :aria-expanded="hasDetails ? expanded : undefined"
      :disabled="!hasDetails"
      @click="hasDetails && (expanded = !expanded)"
    >
      <span
        class="flex size-4 shrink-0 items-center justify-center"
        :class="[
          activity.status === 'error'
            ? 'text-accent-error'
            : isActive
              ? 'text-accent-tool'
              : 'text-ink-muted',
          isActive ? 'motion-safe:animate-[kone-breathe_2.4s_ease-in-out_infinite]' : '',
        ]"
      >
        <UIcon :name="iconName" class="size-3.5" aria-hidden="true" />
      </span>
      <span class="min-w-0 flex-1 truncate font-light text-ink-secondary">
        {{ label }}
      </span>
      <span
        class="shrink-0 text-[10px] font-mono uppercase tracking-[0.14em] text-ink-muted"
      >
        <template v-if="durationLabel">{{ durationLabel }} · </template>{{ statusLabel }}
      </span>
      <UIcon
        v-if="hasDetails"
        name="i-lucide-chevron-right"
        class="size-3 shrink-0 text-ink-muted transition-transform duration-200"
        :class="expanded ? 'rotate-90' : ''"
        aria-hidden="true"
      />
    </button>

    <div
      v-if="hasDetails"
      class="grid transition-[grid-template-rows] duration-200 ease-[var(--kone-ease-out)]"
      :style="{ gridTemplateRows: expanded ? '1fr' : '0fr' }"
    >
      <div class="overflow-hidden">
        <div
          class="ml-2 mt-1.5 space-y-2 border-l border-zinc-200/80 py-1 pl-4 text-xs text-ink-muted dark:border-zinc-800"
        >
          <p class="m-0 font-mono text-[10px] uppercase tracking-[0.14em] text-ink-muted">
            {{ activity.name }}
          </p>
          <p v-if="activity.inputSummary" class="m-0 whitespace-pre-wrap">
            {{ activity.inputSummary }}
          </p>
          <pre
            v-if="activity.command"
            class="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-ink-secondary"
          ><code>{{ activity.command }}</code></pre>
          <div v-if="activity.paths.length" class="flex flex-col gap-1 font-mono text-[11px]">
            <span v-for="path in activity.paths" :key="path" class="break-all">{{ path }}</span>
          </div>
          <p v-if="activity.outputSummary" class="m-0 whitespace-pre-wrap">
            {{ activity.outputSummary }}
          </p>
        </div>
      </div>
    </div>
  </div>
</template>
