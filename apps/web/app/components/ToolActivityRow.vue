<script setup lang="ts">
import { computed, ref } from "vue";

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
      class="flex w-full min-w-0 items-center gap-2 text-left text-xs transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40"
      :class="hasDetails ? 'cursor-pointer' : 'cursor-default'"
      :aria-expanded="hasDetails ? expanded : undefined"
      :disabled="!hasDetails"
      @click="hasDetails && (expanded = !expanded)"
    >
      <span
        class="flex size-4 shrink-0 items-center justify-center"
        :class="[
          activity.status === 'error'
            ? 'text-rose-500'
            : isActive
              ? 'text-sky-500'
              : 'text-zinc-400 dark:text-zinc-600',
          isActive ? 'motion-safe:animate-[kone-breathe_2.4s_ease-in-out_infinite]' : '',
        ]"
      >
        <UIcon :name="iconName" class="size-3.5" aria-hidden="true" />
      </span>
      <span class="min-w-0 flex-1 truncate font-light text-zinc-600 dark:text-zinc-400">
        {{ activity.name }}
      </span>
      <span
        class="shrink-0 text-[10px] font-mono uppercase tracking-[0.14em] text-zinc-400 dark:text-zinc-600"
      >
        {{ statusLabel }}
      </span>
      <UIcon
        v-if="hasDetails"
        name="i-lucide-chevron-right"
        class="size-3 shrink-0 text-zinc-400 transition-transform duration-200 dark:text-zinc-600"
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
          class="ml-2 mt-1.5 space-y-2 border-l border-zinc-200/80 py-1 pl-4 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-500"
        >
          <p v-if="activity.inputSummary" class="m-0 whitespace-pre-wrap">
            {{ activity.inputSummary }}
          </p>
          <pre
            v-if="activity.command"
            class="m-0 max-h-56 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] leading-relaxed text-zinc-700 dark:text-zinc-300"
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
