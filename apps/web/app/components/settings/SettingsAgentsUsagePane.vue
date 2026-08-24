<script setup lang="ts">
import { onMounted } from "vue";
import { Analytics01Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import AgentSettingsUsage from "~/components/agent/AgentSettingsUsage.vue";

// Agent usage in settings — the same panel as the agents space, but global by
// default and without a project scope rail. The drawer widens for it (see
// useSettingsSurface) so the chart and breakdowns can breathe. The frame (mast,
// scroll smoke, foot) is the shared SettingsPageShell; this pane is just its body.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const space = useAgentSettings(() => null);

onMounted(() => {
  space.setUsageScope("global");
  void space.load();
});
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Usage"
    :breadcrumb-icon="Analytics01Icon"
    label="Agent usage settings"
    @back="$emit('back')"
  >
    <AgentSettingsUsage :space="space" :show-project-scope="false" :foot="false" />

    <template #foot>
      What your agent CLIs have spent on this machine — read from each CLI's own local logs, and
      Cursor's signed-in dashboard when available. Costs are estimates from published per-model
      rates, not a bill. Nothing leaves your machine.
    </template>
  </SettingsPageShell>
</template>
