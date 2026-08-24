<script setup lang="ts">
import { computed, onMounted } from "vue";
import { Icon } from "@iconify/vue";
import { iconForFile } from "~/utils/fileIcon";
import { ensureVscodeIcons } from "~/utils/vscodeIcons";

// The real VS Code file-type logo for a path, resolved from its filename.
const props = withDefaults(
  defineProps<{ path: string; size?: number }>(),
  { size: 18 },
);

const icon = computed(() => iconForFile(props.path));

// The icon set loads lazily to stay off the first paint (see utils/vscodeIcons);
// kick it here so an icon needed this frame still resolves — <Icon> re-renders
// once the collection lands, so an unloaded icon shows nothing until then.
onMounted(() => {
  void ensureVscodeIcons();
});
</script>

<template>
  <Icon :icon="icon" :width="size" :height="size" aria-hidden="true" />
</template>
