<script setup lang="ts">
import { onMounted, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PuzzleIcon, RefreshIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import AgentSettingsSkills from "~/components/agent/AgentSettingsSkills.vue";
import { useAgentSettings } from "~/composables/useAgentSettings";
import { useRecentProjects } from "~/composables/useRecentProjects";
import { useSkills } from "~/composables/useSkills";

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

// v1 — list skills from every provider (claude/codex/cursor/opencode/agents/factory)
// across global roots + every project added in the app (recent projects).

const { recents } = useRecentProjects();
const projectPaths = () => {
  const paths = recents.value.map((p) => p.path);
  return paths.length ? paths : null;
};
const space = useAgentSettings(projectPaths);
const skills = useSkills(projectPaths);

const rescanning = ref(false);

onMounted(() => {
  void space.load();
});

// When the recent-projects list hydrates (localStorage → recents), re-scan so
// project-scoped skills for every added project appear without a manual refresh.
watch(
  () => recents.value.map((p) => p.path).join("|"),
  () => void space.refreshInventory(),
);

async function rescan() {
  rescanning.value = true;
  await space.refreshInventory();
  rescanning.value = false;
}
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Skills"
    :breadcrumb-icon="PuzzleIcon"
    label="Agent skills settings"
    @back="$emit('back')"
  >
    <template #actions>
      <button
        type="button"
        class="sp__btn"
        :disabled="rescanning"
        :tabindex="open ? 0 : -1"
        @click="rescan"
      >
        <HugeiconsIcon
          :icon="RefreshIcon"
          :size="13"
          :stroke-width="1.8"
          :class="{ 'sp__spin': rescanning }"
          aria-hidden="true"
        />
        {{ rescanning ? "Scanning…" : "Scan again" }}
      </button>
    </template>

    <AgentSettingsSkills :space="space" :skills="skills" />

    <template #foot>
      Every skill found across global roots (<code>~/.claude</code> · <code>~/.codex</code> ·
      <code>~/.cursor</code> · <code>~/.config/opencode</code> · <code>~/.agents</code> ·
      <code>~/.factory</code>) and each project you’ve added (<code>.claude</code> ·
      <code>.codex</code> · <code>.cursor</code> · <code>.opencode</code> · <code>.agents</code> ·
      <code>.factory</code>).
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.sp__btn {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 10px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--ink-soft);
  cursor: pointer;
  transition:
    background-color 140ms ease,
    color 140ms ease;
}
.sp__btn:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.sp__btn:disabled {
  color: var(--muted);
  cursor: default;
}
.sp__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

.sp__spin {
  animation: sp-spin 900ms linear infinite;
}
@keyframes sp-spin {
  to {
    transform: rotate(360deg);
  }
}
@media (prefers-reduced-motion: reduce) {
  .sp__spin {
    animation: none;
  }
}
</style>
