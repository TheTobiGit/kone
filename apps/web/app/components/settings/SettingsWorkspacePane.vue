<script setup lang="ts">
import { InboxIcon, SparklesIcon, Task01Icon } from "@hugeicons/core-free-icons";
import SettingsPageShell from "~/components/settings/SettingsPageShell.vue";

// A workspace's settings page before it has any settings: the place is held
// so the list reads as the four workspaces kone has, and the page says so
// plainly rather than inventing a control to fill it.

export type EmptyWorkspace = "inbox" | "bench" | "assistant";

const props = defineProps<{ open: boolean; workspace: EmptyWorkspace }>();
defineEmits<{ back: [] }>();

const META = {
  inbox: { name: "Inbox", icon: InboxIcon },
  bench: { name: "Bench", icon: Task01Icon },
  assistant: { name: "Assistant", icon: SparklesIcon },
} satisfies Record<EmptyWorkspace, { name: string; icon: unknown }>;

const meta = META[props.workspace];
</script>

<template>
  <SettingsPageShell
    :open="open"
    :breadcrumb="`Workspaces / ${meta.name}`"
    :breadcrumb-icon="meta.icon"
    :label="`${meta.name} settings`"
    @back="$emit('back')"
  >
    <p class="ws__empty">Nothing to set for the {{ meta.name.toLowerCase() }} yet.</p>
  </SettingsPageShell>
</template>

<style scoped>
.ws__empty {
  padding-block: 0.5rem;
  font-size: 14px;
  line-height: 1.5;
  color: var(--muted);
}
</style>
