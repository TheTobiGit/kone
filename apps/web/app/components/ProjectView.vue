<script setup lang="ts">
import { computed, toRef } from "vue";
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
</script>

<template>
  <main
    class="relative flex min-h-screen items-start justify-center bg-ground px-16 pt-24 pb-56"
  >

    <div class="flex w-full max-w-4xl flex-col gap-11">
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
      />
    </div>

    <!-- The folder settles into the corner last — rising into place with a soft
         spring, the physical grace note after the greeting + changes land. -->
    <motion.div
      class="absolute bottom-10 left-10"
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
  </main>
</template>
