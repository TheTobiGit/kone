<script setup lang="ts">
// Where a new thread will run.
//
// Everywhere else in the app a new thread inherits its project from where you
// were standing. The inbox is the exception — it deliberately spans every
// project and shows you none — so the one thing a new thread needs here is the
// one thing this surface does not know.
//
// It takes the project the newest thread ran in. Not the most recently *opened*
// project, which pins reorder and which counts a project you glanced at as
// evidence: the question is where the work has been, and a thread is what work
// leaves behind.

import { computed, ref, watch } from "vue";
import type { SessionSummary } from "~/types/session";

const emit = defineEmits<{
  /** The thread the composer just started, on its way to the reading pane. */
  started: [row: SessionSummary, sessionKey: string];
}>();

const { recents } = useRecentProjects();
const { pinned, recent, loading } = useAllRecentSessions();

/** The newest thread of all, across both runs. Pinned rows are sorted among
 *  themselves, so the front of either run can be the true newest — a pin says
 *  where to look first, not when something happened. */
const newest = computed(() => {
  const heads = [pinned.value[0], recent.value[0]].filter((s) => s !== undefined);
  return heads.sort((a, b) => b.updatedAt - a.updatedAt)[0] ?? null;
});

// Latched, so the project stops moving the moment there is one to move away
// from: a background turn landing in another project must not relocate a
// message half written.
const path = ref<string | null>(null);
watch(
  newest,
  (row) => {
    if (path.value || !row?.projectPath) return;
    path.value = row.projectPath;
  },
  { immediate: true },
);

const project = computed(() => {
  const p = path.value;
  if (!p) return null;
  const known = recents.value.find((r) => r.path === p);
  if (known) return { path: known.path, name: known.name };
  // A thread can name a project that has since dropped out of recents. It ran
  // there, so it is still somewhere a thread can run.
  return { path: p, name: p.split("/").filter(Boolean).at(-1) ?? p };
});
</script>

<template>
  <!-- Keyed on the project: the session registry is chosen from the path once,
       at setup, so a different project is a different pane. -->
  <InboxComposeNew
    v-if="project"
    :key="project.path"
    :project-path="project.path"
    :project-name="project.name"
    @pick-project="path = $event.path"
    @started="(row, sessionKey) => emit('started', row, sessionKey)"
  />

  <p v-else class="nt__quiet">
    {{ loading ? "Finding somewhere to start…" : "Open a project first — a thread has to run somewhere." }}
  </p>
</template>

<style scoped>
.nt__quiet {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 24px;
  font-size: 12.5px;
  color: var(--muted);
  text-align: center;
  text-wrap: pretty;
}
</style>
