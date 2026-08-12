<script setup lang="ts">
import SettingsPageShell from "~/components/SettingsPageShell.vue";
import ProfileBody from "~/components/ProfileBody.vue";

// The profile settings page. Lifetime usage and local identity live here rather
// than on a standalone full-screen board — the drawer widens for it (see
// useSettingsSurface) so the heatmap and stat band can breathe. The frame (mast,
// scroll smoke, foot) is the shared SettingsPageShell; this pane is just its body.

defineProps<{ open: boolean }>();
defineEmits<{ back: [] }>();
</script>

<template>
  <SettingsPageShell
    :open="open"
    breadcrumb="General / Profile"
    label="Profile settings"
    @back="$emit('back')"
  >
    <ProfileBody />

    <template #foot>Local identity and lifetime usage — nothing leaves your machine.</template>
  </SettingsPageShell>
</template>
