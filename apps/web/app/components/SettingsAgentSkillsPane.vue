<script setup lang="ts">
import { onMounted } from "vue";
import { PuzzleIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import AgentSpaceSkills from "~/components/AgentSpaceSkills.vue";
import { useAgentSpace } from "~/composables/useAgentSpace";

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();

const space = useAgentSpace(() => null);

onMounted(() => {
  void space.load();
});
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Agents / Skills"
    :breadcrumb-icon="PuzzleIcon"
    label="Agent skills settings"
    @back="$emit('back')"
  >
    <AgentSpaceSkills :space="space" />

    <template #foot>
      Every skill found on this machine across Claude, Codex, OpenCode, Cursor, Factory, and Agents.
    </template>
  </SettingsPageShell>
</template>

