<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { motion } from "motion-v";
import type { FolderFile } from "~/components/ProjectFolder.vue";
import type { ChangeItem } from "~/components/ChangesPanel.vue";
import type { GitChange, GitFileStatus } from "~/types/desktop";
import type { Project } from "~/composables/useProject";

const props = defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();

const git = useGit();
const loaded = ref(false);
const repo = ref(true);
const hasCommits = ref(true);
const branch = ref<string | null>(null);
const clean = ref(false);
const added = ref(0);
const removed = ref(0);
const ahead = ref(0);
const behind = ref(0);
const changes = ref<GitChange[]>([]);

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
  changes.value.map((c) => ({
    name: basename(c.path),
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    staged: c.staged,
    isNew: isNew(c.status),
    deleted: c.status === "deleted",
  })),
);

const folderFiles = computed<FolderFile[]>(() =>
  changes.value.slice(0, 3).map((c) => ({
    change: c.status === "deleted" ? "deleted" : isNew(c.status) ? "new" : "edit",
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    name: c.path,
  })),
);

onMounted(async () => {
  const [detected, status] = await Promise.all([
    git.detect(props.project.path),
    git.status(props.project.path),
  ]);

  repo.value = detected !== null;
  branch.value = detected?.branch ?? null;
  added.value = detected?.added ?? 0;
  removed.value = detected?.removed ?? 0;
  changes.value = status?.changes ?? [];

  // A null HEAD is an unborn branch — a repo with no commits yet.
  hasCommits.value = status ? status.head !== null : true;
  clean.value = status?.clean ?? detected?.clean ?? true;
  ahead.value = status?.ahead ?? detected?.ahead ?? 0;
  behind.value = status?.behind ?? detected?.behind ?? 0;
  loaded.value = true;
});

const fileCount = computed(() => changeItems.value.length);
const stagedCount = computed(() => changes.value.filter((c) => c.staged).length);
</script>

<template>
  <main
    class="relative flex h-full min-h-screen items-start justify-center bg-ground px-16 py-24"
  >
    
    <div class="flex w-full max-w-4xl flex-col gap-11">
      <HomeGreeting
        :project-name="project.name"
        :loading="!loaded"
        :repo="repo"
        :has-commits="hasCommits"
        :branch="branch"
        :clean="clean"
        :added="added"
        :removed="removed"
        :file-count="fileCount"
        :staged="stagedCount"
        :ahead="ahead"
        :behind="behind"
      />
      <ChangesPanel
        :loading="!loaded"
        :branch="branch"
        :added="added"
        :removed="removed"
        :changes="changeItems"
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
        :repo="repo"
        :branch="branch"
        :added="added"
        :removed="removed"
        :files="folderFiles"
        :scale="1.15"
      />
    </motion.div>
  </main>
</template>
