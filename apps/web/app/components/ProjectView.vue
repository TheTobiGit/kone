<script setup lang="ts">
import { computed, onBeforeUnmount, ref, toRef, watch } from "vue";
import { onKeyStroke } from "@vueuse/core";
import { motion } from "motion-v";
import type { FolderFile } from "~/components/ProjectFolder.vue";
import type { ChangeItem } from "~/components/ChangesPanel.vue";
import type { GitFileStatus } from "~/types/desktop";
import type { Project } from "~/composables/useProject";

const props = defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();

// One reactive git model drives the whole page; every surface below reads from
// its derived counts, and the action handlers edit it in place so a change
// shows up everywhere at once.
const g = useProjectGit(toRef(props, "project"));
const { cue } = useSound();
const { warm } = useHighlighter();

// Last path segment, tolerant of a trailing slash (a directory entry) so it
// never yields an empty name.
function basename(path: string): string {
  const segments = path.split("/").filter(Boolean);
  return segments[segments.length - 1] ?? path;
}

function isNew(status: GitFileStatus): boolean {
  return status === "added" || status === "untracked";
}

const changeItems = computed<ChangeItem[]>(() =>
  g.changes.value.map((c) => ({
    path: c.path,
    name: basename(c.path),
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    staged: c.staged,
    isNew: isNew(c.status),
    deleted: c.status === "deleted",
  })),
);

// The file whose detail is open, tracked by path so it survives a staging flip
// (the item is re-derived from live data). It self-closes when the file leaves
// the working tree — discarded, or swept away by a commit.
const activePath = ref<string | null>(null);
// The clicked card's viewport rect — the detail grows out of it.
const originRect = ref<DOMRect | null>(null);
const activeFile = computed(
  () => changeItems.value.find((c) => c.path === activePath.value) ?? null,
);
// Self-close when the file leaves the tree; lock the page while the overlay is
// up so only the file's own body scrolls.
function lockPage(locked: boolean) {
  if (import.meta.client) {
    document.documentElement.style.overflow = locked ? "hidden" : "";
  }
}
watch(activeFile, (f) => {
  if (activePath.value && !f) activePath.value = null;
  lockPage(Boolean(f));
});
onBeforeUnmount(() => lockPage(false));

// Preload the highlighter grammars for the file types in this project's changes
// (plus the engine + themes) the moment they're known — so the first file the
// user opens paints instantly, with no on-demand load.
watch(
  changeItems,
  (items) => {
    if (items.length) void warm(items.map((c) => c.path));
  },
  { immediate: true },
);

const folderFiles = computed<FolderFile[]>(() =>
  g.changes.value.slice(0, 3).map((c) => ({
    change: c.status === "deleted" ? "deleted" : isNew(c.status) ? "new" : "edit",
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    name: c.path,
  })),
);

// ── action handlers — mutate the model, then sound the gesture ────────────────
function onStageAll() {
  cue("toggle");
  g.stageAll();
}
function onUnstageAll() {
  cue("toggle");
  g.unstageAll();
}
// Discard is hold-to-confirm (HoldToConfirm) in the Changed lane — by the time
// this fires the user has held through the confirm, so no modal interrupts.
// (ChangesPanel already sounds the gesture.)
function onDiscardPaths(paths: string[]) {
  g.discardPaths(paths);
}
function onCommit() {
  cue("success");
  g.commit();
}

// ── file detail ───────────────────────────────────────────────────────────────
function onOpenFile(item: ChangeItem, rect: DOMRect) {
  cue("press");
  originRect.value = rect;
  activePath.value = item.path;
}
function onCloseFile() {
  activePath.value = null;
}
// Esc backs out of the detail view (only while one is open).
onKeyStroke("Escape", () => {
  if (activePath.value) onCloseFile();
});
function onStageFile(path: string) {
  cue("toggle");
  g.stagePaths([path]);
}
function onUnstageFile(path: string) {
  cue("toggle");
  g.unstagePaths([path]);
}
// Discarding from the detail closes it — the file's gone; the auto-close watcher
// also covers it, but clearing here avoids a frame of stale content.
function onDiscardFile(path: string) {
  cue("press");
  g.discardPaths([path]);
  activePath.value = null;
}
</script>

<template>
  <main
    class="relative flex min-h-screen items-start justify-center bg-ground px-16 pt-24 pb-56"
  >

    <!-- While the detail overlay is open the page behind is inert — no tab
         stops, no screen-reader reach; the overlay owns focus. -->
    <div class="flex w-full max-w-4xl flex-col gap-11" :inert="Boolean(activeFile)">
      <HomeGreeting
        :project-name="project.name"
        :loading="!g.loaded.value"
        :repo="g.repo.value"
        :has-commits="g.hasCommits.value"
        :branch="g.branch.value"
        :clean="g.clean.value"
        :added="g.added.value"
        :removed="g.removed.value"
        :file-count="g.fileCount.value"
        :staged="g.stagedCount.value"
        :ahead="g.ahead.value"
        :behind="g.behind.value"
      />
      <ChangesPanel
        :loading="!g.loaded.value"
        :branch="g.branch.value"
        :added="g.added.value"
        :removed="g.removed.value"
        :changes="changeItems"
        @stage-all="onStageAll"
        @unstage-all="onUnstageAll"
        @commit="onCommit"
        @discard-paths="onDiscardPaths"
        @open="onOpenFile"
      />
    </div>

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting + changes land. -->
    <motion.div
      class="absolute bottom-10 left-10"
      :inert="Boolean(activeFile)"
      :initial="{ opacity: 0, y: 44, scale: 0.94 }"
      :animate="{ opacity: 1, y: 0, scale: 1 }"
      :transition="{ type: 'spring', stiffness: 210, damping: 22, mass: 0.9, delay: 0.55 }"
    >
      <ProjectFolder
        :name="project.name"
        :repo="g.repo.value"
        :branch="g.branch.value"
        :added="g.added.value"
        :removed="g.removed.value"
        :files="folderFiles"
        :scale="1.15"
      />
    </motion.div>

    <!-- A file's detail: it grows out of the clicked card (origin --ox/--oy) to
         fill the screen over everything else, then shrinks back on close. -->
    <Transition name="pop">
      <FileDetail
        v-if="activeFile"
        :file="activeFile"
        :repo-path="project.path"
        :origin="originRect"
        @close="onCloseFile"
        @stage="onStageFile"
        @unstage="onUnstageFile"
        @discard="onDiscardFile"
      />
    </Transition>
  </main>
</template>

<style scoped>
/* The detail grows out of the clicked card and settles — a small overshoot reads
   as a "pop". Origin comes from --ox/--oy (the card's centre), set inline on the
   overlay root. On close it runs in reverse, shrinking back into the card. */
@keyframes pop-grow {
  from { opacity: 0.35; transform: scale(0.16); }
  60% { opacity: 1; }
  to { opacity: 1; transform: scale(1); }
}
.pop-enter-active {
  animation: pop-grow 0.46s cubic-bezier(0.34, 1.3, 0.64, 1);
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
.pop-leave-active {
  animation: pop-grow 0.26s cubic-bezier(0.4, 0, 0.9, 1) reverse;
  transform-origin: var(--ox, 50%) var(--oy, 50%);
}
@media (prefers-reduced-motion: reduce) {
  .pop-enter-active,
  .pop-leave-active {
    animation-duration: 0.01s;
  }
}
</style>
