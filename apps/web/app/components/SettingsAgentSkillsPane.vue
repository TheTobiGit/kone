<script setup lang="ts">
import { PuzzleIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/SettingsPageShell.vue";

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="Agents / Skills"
    :breadcrumb-icon="PuzzleIcon"
    label="Agent skills settings"
    @back="$emit('back')"
  />
</template>
