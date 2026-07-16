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
const repo = ref(true);
const branch = ref<string | null>(null);
const added = ref(0);
const removed = ref(0);
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
});
</script>

<template>
  <main
    class="relative flex h-full min-h-screen items-center justify-center bg-ground px-16 py-16"
  >
    <!-- The file changes sit in the middle of the page (Project Home language);
         the agent conversation will grow around this next. -->
    <ChangesPanel
      class="w-full max-w-4xl"
      :branch="branch"
      :added="added"
      :removed="removed"
      :changes="changeItems"
    />

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
