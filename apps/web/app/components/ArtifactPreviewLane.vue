<script setup lang="ts">
import { computed } from "vue";

import type { ArtifactReference } from "~/types/conversation";

const props = defineProps<{
  artifact: ArtifactReference | null;
}>();

defineEmits<{
  close: [];
}>();

const safeImageSource = computed(() => {
  if (props.artifact?.kind !== "image") return null;
  return /^(?:data:image\/(?:png|jpeg|gif|webp);|blob:)/i.test(
    props.artifact.source,
  )
    ? props.artifact.source
    : null;
});

type DiffLine = { text: string; isAdded: boolean; isRemoved: boolean };

const diffLines = computed<DiffLine[]>(() => {
  if (props.artifact?.kind !== "diff" || !props.artifact.content) return [];
  return props.artifact.content.split("\n").map((text) => ({
    text,
    isAdded: text.startsWith("+") && !text.startsWith("+++"),
    isRemoved: text.startsWith("-") && !text.startsWith("---"),
  }));
});

function diffLineClass(line: DiffLine) {
  if (line.isAdded) return "text-emerald-700 dark:text-emerald-300";
  if (line.isRemoved) return "text-rose-700 dark:text-rose-300";
  return "text-zinc-700 dark:text-zinc-300";
}
</script>

<template>
  <Transition name="preview-lane">
    <aside
      v-if="artifact"
      class="fixed inset-y-0 right-0 z-30 flex w-[min(42rem,88vw)] flex-col border-l border-zinc-200/70 bg-[var(--kone-surface-base)] dark:border-zinc-800/70"
      aria-label="Artifact preview"
    >
      <header class="flex min-h-14 items-center gap-3 border-b border-zinc-200/70 px-5 dark:border-zinc-800/70">
        <div class="min-w-0 flex-1">
          <p class="m-0 truncate text-sm font-medium text-zinc-700 dark:text-zinc-300">
            {{ artifact.title }}
          </p>
          <p class="m-0 mt-0.5 truncate font-mono text-[10px] text-zinc-400">
            {{ artifact.source }}
          </p>
        </div>
        <button
          type="button"
          class="flex size-8 items-center justify-center text-zinc-400 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 dark:hover:text-zinc-200"
          aria-label="Close artifact preview"
          @click="$emit('close')"
        >
          <UIcon name="i-lucide-x" class="size-4" />
        </button>
      </header>

      <div class="min-h-0 flex-1 overflow-auto p-5">
        <img
          v-if="safeImageSource"
          :src="safeImageSource"
          :alt="artifact.title"
          class="mx-auto max-h-full max-w-full object-contain"
        />
        <div
          v-else-if="artifact.kind === 'diff' && artifact.content"
          class="font-mono text-xs leading-relaxed"
        >
          <div
            v-for="(line, index) in diffLines"
            :key="index"
            class="whitespace-pre-wrap break-words"
            :class="diffLineClass(line)"
          >{{ line.text || " " }}</div>
        </div>
        <pre
          v-else-if="artifact.content"
          class="m-0 whitespace-pre-wrap break-words font-mono text-xs leading-relaxed text-zinc-700 dark:text-zinc-300"
        ><code>{{ artifact.content }}</code></pre>
        <p v-else class="m-0 text-sm font-light text-zinc-500">
          This artifact cannot be previewed safely in the app.
        </p>
      </div>
    </aside>
  </Transition>
</template>

<style scoped>
.preview-lane-enter-active,
.preview-lane-leave-active {
  transition:
    transform 300ms var(--kone-ease-out),
    opacity 200ms ease;
}

.preview-lane-enter-from,
.preview-lane-leave-to {
  opacity: 0;
  transform: translateX(1rem);
}
</style>
