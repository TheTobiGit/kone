<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import type { FolderFile } from "~/components/ProjectFolder.vue";
import type { ChangeItem } from "~/components/ChangesPanel.vue";
import type { GitChange, GitFileStatus } from "~/types/desktop";
import type { Project } from "~/composables/useProject";

const props = defineProps<{ project: Project }>();
defineEmits<{ close: [] }>();

// Live git for the rail. `detect` gives the branch + overall line diffstat
// (canned for the mock repos in `nuxt dev`); `status` gives the per-file change
// list that feeds both the ChangesPanel cards and the folder's peeking papers.
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

function langOf(path: string): FolderFile["lang"] {
  if (path.endsWith(".vue")) return "vue";
  if (/\.(js|mjs|cjs|jsx)$/.test(path)) return "js";
  return "ts";
}

function isNew(status: GitFileStatus): boolean {
  return status === "added" || status === "untracked";
}

// The full change list, for the panel's cards.
const changeItems = computed<ChangeItem[]>(() =>
  changes.value.map((c) => ({
    name: c.path.split("/").pop() ?? c.path,
    lang: langOf(c.path),
    added: c.added ?? 0,
    removed: c.removed ?? 0,
    staged: c.staged,
    isNew: isNew(c.status),
    deleted: c.status === "deleted",
  })),
);

// A trimmed cut of the same list, for the folder's peeking papers.
const folderFiles = computed<FolderFile[]>(() =>
  changes.value.slice(0, 3).map((c) => ({
    lang: langOf(c.path),
    change: c.status === "deleted" ? "deleted" : isNew(c.status) ? "new" : "edit",
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

// Files with any change, and how many of them are staged — drives the greeting.
const fileCount = computed(() => changeItems.value.length);
const stagedCount = computed(() => changes.value.filter((c) => c.staged).length);
</script>

<template>
  <main
    class="relative flex h-full min-h-screen items-center justify-center bg-ground px-16 py-16"
  >
    <!-- The greeting + file changes sit in the middle of the page (Project Home
         language); the agent conversation will grow around this next. -->
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
        :branch="branch"
        :added="added"
        :removed="removed"
        :changes="changeItems"
      />
    </div>

    <!-- Folder anchored in the bottom-left corner, ambient. -->
    <div class="absolute bottom-10 left-10">
      <ProjectFolder
        :name="project.name"
        :repo="repo"
        :branch="branch"
        :added="added"
        :removed="removed"
        :files="folderFiles"
        :scale="1.15"
      />
    </div>
  </main>
</template>
