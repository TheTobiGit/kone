<script setup lang="ts">
import { computed, reactive } from "vue";

import type { ToolActivity } from "~/types/conversation";

const props = defineProps<{
  tools: ToolActivity[];
}>();

const GROUP_THRESHOLD = 4;

type GroupKind = "read" | "search";

type TimelineSegment =
  | { type: "single"; activity: ToolActivity }
  | { type: "group"; key: string; kind: GroupKind; activities: ToolActivity[] };

function groupableKind(activity: ToolActivity): GroupKind | null {
  if (activity.status !== "completed" || activity.isError) return null;
  return activity.kind === "read" || activity.kind === "search"
    ? activity.kind
    : null;
}

// Collapses long consecutive runs of completed, non-error read/search tools
// into a single quiet summary row. Running, awaiting-permission, error, and
// cancelled activities are always left visible and ungrouped, and order is
// preserved throughout.
const segments = computed<TimelineSegment[]>(() => {
  const result: TimelineSegment[] = [];
  let buffer: ToolActivity[] = [];
  let bufferKind: GroupKind | null = null;

  const flush = () => {
    if (buffer.length === 0) return;
    if (bufferKind && buffer.length >= GROUP_THRESHOLD) {
      result.push({
        type: "group",
        key: buffer[0]!.id,
        kind: bufferKind,
        activities: buffer,
      });
    } else {
      for (const activity of buffer) result.push({ type: "single", activity });
    }
    buffer = [];
    bufferKind = null;
  };

  for (const activity of props.tools) {
    const kind = groupableKind(activity);
    if (kind) {
      if (bufferKind !== null && bufferKind !== kind) flush();
      bufferKind = kind;
      buffer.push(activity);
      continue;
    }
    flush();
    result.push({ type: "single", activity });
  }
  flush();

  return result;
});

const expandedGroups = reactive(new Set<string>());

function toggleGroup(key: string) {
  if (expandedGroups.has(key)) expandedGroups.delete(key);
  else expandedGroups.add(key);
}

function groupLabel(kind: GroupKind, count: number) {
  return kind === "read" ? `Read ${count} files` : `Searched ${count} times`;
}
</script>

<template>
  <div
    v-if="tools.length"
    class="mt-3 w-full divide-y divide-zinc-200/60 border-y border-zinc-200/60 py-0.5 dark:divide-zinc-800/70 dark:border-zinc-800/70"
    aria-label="Agent activity"
  >
    <template
      v-for="segment in segments"
      :key="segment.type === 'group' ? segment.key : segment.activity.id"
    >
      <ToolActivityRow
        v-if="segment.type === 'single'"
        :activity="segment.activity"
      />

      <div v-else class="py-1.5">
        <button
          type="button"
          class="flex w-full min-w-0 items-center gap-2 text-left text-xs transition-colors duration-200 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
          :aria-expanded="expandedGroups.has(segment.key)"
          @click="toggleGroup(segment.key)"
        >
          <span class="flex size-4 shrink-0 items-center justify-center text-ink-muted">
            <UIcon
              :name="segment.kind === 'read' ? 'i-lucide-file-search' : 'i-lucide-search'"
              class="size-3.5"
              aria-hidden="true"
            />
          </span>
          <span class="min-w-0 flex-1 truncate font-light text-ink-muted">
            {{ groupLabel(segment.kind, segment.activities.length) }}
          </span>
          <UIcon
            name="i-lucide-chevron-right"
            class="size-3 shrink-0 text-ink-muted transition-transform duration-200"
            :class="expandedGroups.has(segment.key) ? 'rotate-90' : ''"
            aria-hidden="true"
          />
        </button>

        <div
          class="grid transition-[grid-template-rows] duration-200 ease-[var(--kone-ease-out)]"
          :style="{ gridTemplateRows: expandedGroups.has(segment.key) ? '1fr' : '0fr' }"
        >
          <div class="overflow-hidden">
            <div
              class="ml-2 mt-1 divide-y divide-zinc-200/50 border-l border-zinc-200/80 pl-4 dark:divide-zinc-800/60 dark:border-zinc-800"
            >
              <ToolActivityRow
                v-for="activity in segment.activities"
                :key="activity.id"
                :activity="activity"
              />
            </div>
          </div>
        </div>
      </div>
    </template>
  </div>
</template>
