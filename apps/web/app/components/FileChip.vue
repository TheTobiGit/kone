<script setup lang="ts">
import { computed } from "vue";
import { PhFolder } from "@phosphor-icons/vue";
import FileIcon from "~/components/FileIcon.vue";
import { fileBaseForIcon } from "~/utils/fileIcon";

// When an agent names a file in prose — `src/agent/useAgent.ts`, `package.json`
// — we render it not as flat inline code but as a chip: the real VSCode file-
// type glyph, then the path with its directory dimmed and the filename in ink.
// It turns a wall of monospace paths into something you can scan by icon.

// `path` is what the chip shows (icon + dir/name); `title` overrides the hover
// tooltip when the display path is a shortened basename of a longer one.
const props = defineProps<{ path: string; title?: string; folder?: boolean }>();

const iconPath = computed(() => fileBaseForIcon(props.path));

// Split into a dimmed directory prefix and an emphasised basename.
const parts = computed(() => {
  const clean = props.path.replace(/\/+$/, "");
  const slash = clean.lastIndexOf("/");
  return slash === -1
    ? { dir: "", name: clean }
    : { dir: clean.slice(0, slash + 1), name: clean.slice(slash + 1) };
});
</script>

<template>
  <span class="chip" :title="title ?? path">
    <PhFolder v-if="folder" class="chip__ico chip__ico--folder" :size="13" weight="duotone" aria-hidden="true" />
    <FileIcon v-else class="chip__ico" :path="iconPath || path" :size="13" />
    <span class="chip__path">
      <span v-if="parts.dir" class="chip__dir">{{ parts.dir }}</span
      ><span class="chip__name">{{ parts.name }}</span>
    </span>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 6px 1px 5px;
  border-radius: 6px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
  vertical-align: baseline;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip__ico {
  position: relative;
  top: 2px;
  flex: none;
}
.chip__ico--folder {
  color: #c4a44a;
}
.chip__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip__dir { color: var(--muted); }
.chip__name { color: var(--ink); }
</style>
