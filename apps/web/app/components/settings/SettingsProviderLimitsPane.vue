<script setup lang="ts">
import { onMounted } from "vue";
import { GaugeIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import AgentSettingsLimits from "~/components/agent/AgentSettingsLimits.vue";

// Provider limits in settings — global by nature, since a quota belongs to the
// machine and not to a project. AgentSettingsLimits is the whole panel and this
// pane is only its body plus a frame: the mast, scroll smoke and foot come from
// the shared SettingsPageShell, and the drawer's measure for this pane is set
// in useSettingsSurface (PANE_MEASURE), which is the one place that decides it.

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
