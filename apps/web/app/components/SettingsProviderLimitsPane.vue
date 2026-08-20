<script setup lang="ts">
import { onMounted } from "vue";
import { GaugeIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import AgentSettingsLimits from "~/components/AgentSettingsLimits.vue";

// Provider limits in settings — the same panel as the agents space's Limits
// section, global by nature (a quota belongs to the machine, not a project).
// The drawer widens for it (see useSettingsSurface) so the meters can breathe.
// The frame (mast, scroll smoke, foot) is the shared SettingsPageShell; this pane
// is just its body.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const space = useAgentSettings(() => null);

onMounted(() => {
  void space.load();
});
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Ecosystem / Provider limits"
    :breadcrumb-icon="GaugeIcon"
    label="Provider limits settings"
    @back="$emit('back')"
  >
    <AgentSettingsLimits :space="space" :foot="false" />

    <template #foot>
      Every number is read locally — a provider's own usage API, or OpenCode's cost log — never
      stored or sent. A <span class="spl__tilde">~</span> marks spend kone estimated from token
      counts.
    </template>
  </SettingsPageShell>
</template>

<style scoped>
.spl__tilde {
  font-family: var(--font-mono);
  color: var(--ink-soft);
}
</style>
