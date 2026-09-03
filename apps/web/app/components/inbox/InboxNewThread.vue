<script setup lang="ts">
// Where a new thread will run.
//
// Everywhere else in the app a new thread inherits its project from where you
// were standing. The inbox is the exception — it deliberately spans every
// project and shows you none — so the one thing a new thread needs here is the
// one thing this surface does not know.
//
// It takes the project the newest thread ran in. When no thread has run anywhere
// yet, it falls back to the current/only project or the most recent one. When no
// projects exist at all, it shows the three start actions from the project list.

import { computed, ref, watch } from "vue";
import { motion } from "motion-v";
import type { SessionSummary } from "~/types/session";
import type { ActionKey } from "~/components/start/StartActions.vue";
import InboxComposeNew from "~/components/inbox/InboxComposeNew.vue";
import StartActions from "~/components/start/StartActions.vue";
import { resolveInboxDefaultProject } from "~/utils/inboxDefaultProject";

const emit = defineEmits<{
  /** The thread the composer just started, on its way to the reading pane. */
  started: [row: SessionSummary, sessionKey: string];
}>();

const { recents, byRecency } = useRecentProjects();
const activeProject = useProject();
const openProject = useOpenProject();
const { pinned, recent, loading } = useAllRecentSessions();
const { cue } = useSound();
const { reset: resetClone } = useGitClone();
const { reset: resetCreate } = useCreateProject();

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
  [newest, activeProject, byRecency, recents, loading],
  () => {
    if (
      path.value &&
      !recents.value.some((r) => r.path === path.value) &&
      activeProject.value?.path !== path.value &&
      newest.value?.projectPath !== path.value
    ) {
      path.value = null;
    }

    if (path.value) return;

    const resolved = resolveInboxDefaultProject({
      newestProjectPath: newest.value?.projectPath ?? null,
      activeProjectPath: activeProject.value?.path ?? null,
      recents: byRecency.value.length > 0 ? byRecency.value : recents.value,
      loading: loading.value,
    });
    if (resolved) {
      path.value = resolved;
    }
  },
  { immediate: true },
);

const project = computed(() => {
  const p = path.value;
  if (!p) return null;
  const known = recents.value.find((r) => r.path === p);
  if (known) return { path: known.path, name: known.name };
  if (activeProject.value && activeProject.value.path === p) {
    return { path: activeProject.value.path, name: activeProject.value.name };
  }
  // A thread can name a project that has since dropped out of recents. It ran
  // there, so it is still somewhere a thread can run.
  return { path: p, name: p.split("/").filter(Boolean).at(-1) ?? p };
});

const composeRef = ref<InstanceType<typeof InboxComposeNew> | null>(null);

function focus(): void {
  composeRef.value?.focus();
}

defineExpose({ focus });

// ── project creation / addition actions ──────────────────────────────────────
const pending = ref<ActionKey | null>(null);

function onStart(key: ActionKey): void {
  if (pending.value) return;
  cue("press");
  if (key === "clone") resetClone();
  if (key === "create") resetCreate();
  pending.value = key;
}

function onPicked(folder: { path: string; name: string }): void {
  pending.value = null;
  path.value = folder.path;
  openProject(folder);
}

function onCloned(folder: { path: string; name: string }): void {
  cue("success");
  pending.value = null;
  resetClone();
  path.value = folder.path;
  openProject(folder);
}

function onCreated(folder: { path: string; name: string }): void {
  cue("success");
  pending.value = null;
  resetCreate();
  path.value = folder.path;
  openProject(folder);
}

function onCancel(): void {
  pending.value = null;
  resetClone();
  resetCreate();
}
</script>

<template>
  <!-- Keyed on the project: the session registry is chosen from the path once,
       at setup, so a different project is a different pane. -->
  <InboxComposeNew
    v-if="project"
    ref="composeRef"
    :key="project.path"
    :project-path="project.path"
    :project-name="project.name"
    @pick-project="path = $event.path"
    @started="(row, sessionKey) => emit('started', row, sessionKey)"
  />

  <p v-else-if="loading" class="nt__quiet">
    Finding somewhere to start…
  </p>

  <div v-else class="nt__empty">
    <motion.div
      :initial="{ opacity: 0, y: 8 }"
      :animate="{ opacity: 1, y: 0 }"
      :transition="{ duration: 0.4, ease: [0.22, 1, 0.36, 1] }"
    >
      <StartActions :pending="pending" @start="onStart" />
    </motion.div>
  </div>

  <Teleport to="body">
    <UiFolderPickerModal
      v-if="pending === 'open'"
      @select="onPicked"
      @cancel="onCancel"
    />

    <UiGitHubCloneModal
      v-if="pending === 'clone'"
      @clone="onCloned"
      @cancel="onCancel"
    />

    <ProjectCreateProjectModal
      v-if="pending === 'create'"
      @create="onCreated"
      @cancel="onCancel"
    />
  </Teleport>
</template>

<style scoped>
.nt__quiet,
.nt__empty {
  display: grid;
  place-items: center;
  height: 100%;
  padding: 24px;
}

.nt__quiet {
  font-size: 12.5px;
  color: var(--muted);
  text-align: center;
  text-wrap: pretty;
}
</style>
