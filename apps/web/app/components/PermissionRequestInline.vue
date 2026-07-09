<script setup lang="ts">
import { useNow } from "@vueuse/core";
import { computed } from "vue";

import type { PermissionRequest } from "~/types/conversation";

const props = defineProps<{
  request: PermissionRequest;
  position?: number;
  total?: number;
}>();

defineEmits<{
  allow: [];
  deny: [];
}>();

const now = useNow({ interval: 1000 });

const kindLabel = computed(() => {
  switch (props.request.requestKind) {
    case "command":
      return "Command approval";
    case "file-read":
      return "File access";
    case "file-change":
      return "File change";
    case "network":
      return "Network access";
    default:
      return "Approval required";
  }
});

const remainingLabel = computed(() => {
  if (!props.request.expiresAt) return null;
  const remaining = new Date(props.request.expiresAt).getTime() - now.value.getTime();
  if (remaining <= 0) return "Expired";
  const seconds = Math.ceil(remaining / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
});
</script>

<template>
  <section
    class="permission-surface w-full border-y border-amber-500/20 py-4"
    aria-live="polite"
    aria-label="Permission request"
  >
    <div class="flex items-start gap-3">
      <UIcon
        name="i-lucide-shield-question"
        class="mt-0.5 size-4 shrink-0 text-amber-600 dark:text-amber-400"
        aria-hidden="true"
      />
      <div class="min-w-0 flex-1">
        <div class="flex items-center justify-between gap-3">
          <p class="m-0 text-xs font-medium tracking-tight text-zinc-700 dark:text-zinc-300">
            {{ kindLabel }}
          </p>
          <span
            v-if="(total ?? 1) > 1 || remainingLabel"
            class="text-[10px] font-mono uppercase tracking-[0.12em] text-zinc-400 dark:text-zinc-600"
          >
            <template v-if="(total ?? 1) > 1">{{ position ?? 1 }} of {{ total }}</template>
            <template v-if="(total ?? 1) > 1 && remainingLabel"> · </template>
            {{ remainingLabel }}
          </span>
        </div>
        <p
          v-if="request.target"
          class="mt-1 mb-0 truncate font-mono text-[11px] text-zinc-500"
          :title="request.target"
        >
          {{ request.target }}
        </p>
        <p class="mt-1.5 mb-0 whitespace-pre-wrap text-sm font-light leading-relaxed text-zinc-600 dark:text-zinc-400">
          {{ request.detail }}
        </p>
        <div class="mt-3 flex items-center gap-4">
          <button
            type="button"
            class="text-xs font-medium text-zinc-800 transition-colors hover:text-sky-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 dark:text-zinc-200 dark:hover:text-sky-300"
            :disabled="remainingLabel === 'Expired'"
            @click="$emit('allow')"
          >
            Allow once
          </button>
          <button
            type="button"
            class="text-xs font-light text-zinc-500 transition-colors hover:text-rose-600 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500/40 dark:hover:text-rose-400"
            @click="$emit('deny')"
          >
            Deny
          </button>
        </div>
      </div>
    </div>
  </section>
</template>
