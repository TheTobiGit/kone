<script setup lang="ts">
// The settings drawer's providers page, framed full-window for a mockup: the
// real SettingsPageShell with the pane's breadcrumb, plus the shared primitives.
import { AiChipIcon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";
import "./pp.css";

defineProps<{ scroll?: boolean }>();
</script>

<template>
  <div class="ppm ppm__frame">
    <SettingsPageShell
      open
      breadcrumb="Ecosystem / Providers"
      :breadcrumb-icon="AiChipIcon"
      label="Providers settings"
      :scroll="scroll ?? false"
    >
      <template v-if="$slots.actions" #actions>
        <slot name="actions" />
      </template>
      <slot />
      <template v-if="$slots.foot" #foot>
        <slot name="foot" />
      </template>
    </SettingsPageShell>
  </div>
</template>

<style scoped>
.ppm__frame {
  display: flex;
  flex-direction: column;
  height: 100dvh;
  overflow: hidden;
  background-color: var(--sunken);
  color: var(--ink);
}
.ppm__frame > :deep(section) {
  flex: 1 1 auto;
  min-height: 0;
}
</style>
