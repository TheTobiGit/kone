<script setup lang="ts">
import { computed } from "vue";
import { Icon } from "@iconify/vue";
import { iconForFile } from "~/utils/fileLang";

// The real VS Code file-type logo for a path, resolved from its filename.
const props = withDefaults(
  defineProps<{ path: string; size?: number }>(),
  { size: 18 },
);

const icon = computed(() => iconForFile(props.path));
</script>

<template>
  <Icon :icon="icon" :width="size" :height="size" aria-hidden="true" />
</template>
