<script setup lang="ts">
import { computed, ref } from "vue";

import type { ArtifactReference } from "~/types/conversation";

const props = defineProps<{
  artifact: ArtifactReference;
}>();

defineEmits<{
  inspect: [artifact: ArtifactReference];
}>();

const expanded = ref(false);
const isTextual = computed(() =>
  ["text", "code", "markdown", "diff"].includes(props.artifact.kind),
);
const safeExternalUrl = computed(() => {
  if (props.artifact.kind !== "url") return null;
  try {
    const url = new URL(props.artifact.source);
    return ["https:", "http:"].includes(url.protocol) ? url.href : null;
  } catch {
    return null;
  }
});
</script>

<template>
  <div class="border-t border-zinc-200/70 py-2.5 dark:border-zinc-800/70">
    <div class="flex min-w-0 items-center gap-2">
      <UIcon
        :name="artifact.kind === 'image' ? 'i-lucide-image' : 'i-lucide-file-text'"
        class="size-3.5 shrink-0 text-ink-muted"
        aria-hidden="true"
      />
      <button
        v-if="isTextual && artifact.content"
        type="button"
        class="min-w-0 flex-1 truncate text-left text-xs font-light text-ink-secondary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        {{ artifact.title }}
      </button>
      <a
        v-else-if="safeExternalUrl"
        :href="safeExternalUrl"
        target="_blank"
        rel="noopener noreferrer"
        class="min-w-0 flex-1 truncate text-xs font-light text-ink-secondary underline decoration-zinc-300 underline-offset-2 dark:decoration-zinc-700"
      >
        {{ artifact.title }}
      </a>
      <span v-else class="min-w-0 flex-1 truncate text-xs font-light text-ink-secondary">
        {{ artifact.title }}
      </span>
      <span class="shrink-0 font-mono text-[10px] uppercase tracking-[0.12em] text-ink-muted">
        {{ artifact.kind }}
      </span>
      <button
        v-if="artifact.content || artifact.kind === 'image'"
        type="button"
        class="flex size-6 shrink-0 items-center justify-center text-ink-muted hover:text-ink-primary focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-accent-tool/40"
        :aria-label="`Open ${artifact.title} in preview lane`"
        @click="$emit('inspect', artifact)"
      >
        <UIcon name="i-lucide-panel-right-open" class="size-3.5" />
      </button>
    </div>

    <div
      v-if="isTextual && artifact.content"
      class="grid transition-[grid-template-rows] duration-200"
      :style="{ gridTemplateRows: expanded ? '1fr' : '0fr' }"
    >
      <div class="overflow-hidden">
        <pre
          class="mt-2 mb-0 max-h-80 overflow-auto whitespace-pre-wrap break-words border-l border-zinc-200 py-1 pl-4 font-mono text-[11px] leading-relaxed text-ink-secondary dark:border-zinc-800"
        ><code>{{ artifact.content }}</code></pre>
      </div>
    </div>
  </div>
</template>
