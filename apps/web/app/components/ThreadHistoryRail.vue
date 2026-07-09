<script setup lang="ts">
import { ref } from "vue";
import type { StoredThread } from "~/composables/useThreadStore";

defineProps<{
  open: boolean;
  threads: StoredThread[];
  activeThreadId: string | null;
}>();

const editingId = ref<string | null>(null);
const editingTitle = ref("");

function beginRename(thread: StoredThread) {
  editingId.value = thread.id;
  editingTitle.value = thread.title;
}

function finishRename(threadId: string) {
  const title = editingTitle.value.trim();
  if (title) emit("rename", threadId, title);
  editingId.value = null;
}

const emit = defineEmits<{
  toggle: [];
  close: [];
  create: [];
  activate: [threadId: string];
  remove: [threadId: string];
  rename: [threadId: string, title: string];
}>();
</script>

<template>
  <div>
    <button
      type="button"
      class="fixed left-3 top-10 z-20 flex size-8 items-center justify-center rounded-full text-zinc-400 transition-colors hover:bg-black/5 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 dark:hover:bg-white/5 dark:hover:text-zinc-200"
      :aria-expanded="open"
      aria-label="Toggle thread history"
      @click="$emit('toggle')"
    >
      <UIcon :name="open ? 'i-lucide-panel-left-close' : 'i-lucide-history'" class="size-4" />
    </button>

    <Transition name="rail">
      <aside
        v-if="open"
        class="fixed inset-y-0 left-0 z-10 w-[min(18rem,82vw)] border-r border-zinc-200/70 bg-[var(--kone-surface-base)] px-5 pt-24 pb-6 dark:border-zinc-800/70"
        aria-label="Thread history"
      >
        <div class="mb-6 flex items-center justify-between">
          <p class="m-0 text-[10px] font-mono uppercase tracking-[0.2em] text-zinc-400">
            Threads
          </p>
          <button
            type="button"
            class="flex size-7 items-center justify-center text-zinc-400 hover:text-zinc-700 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40 dark:hover:text-zinc-200"
            aria-label="New thread"
            @click="$emit('create')"
          >
            <UIcon name="i-lucide-plus" class="size-4" />
          </button>
        </div>

        <div class="divide-y divide-zinc-200/60 dark:divide-zinc-800/60">
          <div
            v-for="thread in threads"
            :key="thread.id"
            class="group/thread flex min-w-0 items-center py-3"
          >
            <input
              v-if="editingId === thread.id"
              v-model="editingTitle"
              class="min-w-0 flex-1 border-0 border-b border-zinc-300 bg-transparent px-0 py-0.5 text-sm font-light text-zinc-800 outline-none focus:border-sky-500 dark:border-zinc-700 dark:text-zinc-100"
              aria-label="Thread title"
              autofocus
              @keydown.enter.prevent="finishRename(thread.id)"
              @keydown.escape.prevent="editingId = null"
              @blur="finishRename(thread.id)"
            />
            <button
              v-else
              type="button"
              class="min-w-0 flex-1 truncate text-left text-sm font-light transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-sky-500/40"
              :class="
                thread.id === activeThreadId
                  ? 'text-zinc-800 dark:text-zinc-100'
                  : 'text-zinc-500 hover:text-zinc-700 dark:text-zinc-500 dark:hover:text-zinc-300'
              "
              :title="thread.title"
              @click="$emit('activate', thread.id)"
              @dblclick.prevent="beginRename(thread)"
            >
              {{ thread.title }}
            </button>
            <button
              type="button"
              class="ml-2 flex size-6 shrink-0 items-center justify-center text-zinc-400 opacity-0 transition-opacity hover:text-rose-500 group-hover/thread:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-rose-500/40"
              :aria-label="`Delete ${thread.title}`"
              @click="$emit('remove', thread.id)"
            >
              <UIcon name="i-lucide-x" class="size-3" />
            </button>
          </div>
          <p
            v-if="threads.length === 0"
            class="m-0 py-4 text-sm font-light text-zinc-400"
          >
            Your conversations will appear here.
          </p>
        </div>
      </aside>
    </Transition>
  </div>
</template>

<style scoped>
.rail-enter-active,
.rail-leave-active {
  transition:
    transform 280ms var(--kone-ease-out),
    opacity 200ms ease;
}

.rail-enter-from,
.rail-leave-to {
  opacity: 0;
  transform: translateX(-1rem);
}
</style>
