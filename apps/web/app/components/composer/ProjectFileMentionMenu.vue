<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import ComposerPickerMenu from "~/components/composer/ComposerPickerMenu.vue";
import type { MentionItem } from "~/utils/composerMentions";
import FileIcon from "~/components/file/FileIcon.vue";

// The @ picker's popover: the shared composer shell with one row per mention
// item, projects leading files.
//
// In the global assistant there is no project on disk, so a Projects section
// leads the list: naming one drops its absolute path into the turn, which is
// how the assistant learns which project an instruction is for.

const props = defineProps<{
  items: MentionItem[];
  query: string;
  activeIndex: number;
  pending?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  select: [item: MentionItem];
  highlight: [index: number];
}>();

// The header names only what is actually listed: the assistant's picker is
// projects alone, everywhere else it is files alone, and only a surface
// offering both reads as both.
const title = computed(() => {
  const hasProjects = props.items.some((i) => i.kind === "project");
  const hasFiles = props.items.some((i) => i.kind === "file") || props.pending;
  if (hasProjects && hasFiles) return "Projects & files";
  if (hasProjects) return "Projects";
  return "Project files";
});
// The first file row after the leading projects wears the boundary into this
// project's own files — the same hairline the two-section list drew, located
// by kind rather than by adding a section length to a local index.
const fileBoundaryIndex = computed(() => props.items.findIndex((i) => i.kind === "file"));

function rowClass(item: MentionItem, index: number): string {
  void item;
  return index === fileBoundaryIndex.value && fileBoundaryIndex.value > 0
    ? "composer-picker__row--boundary"
    : "";
}

function selectAt(index: number): void {
  const item = props.items[index];
  if (item) emit("select", item);
}
</script>

<template>
  <ComposerPickerMenu
    glyph="@"
    :title="title"
    :query="props.query"
    list-label="Project files"
    :items="props.items"
    :active-index="props.activeIndex"
    :item-key="(item) => item.kind + ':' + item.path"
    :row-class="rowClass"
    @select="selectAt"
    @highlight="emit('highlight', $event)"
  >
    <template #row="{ item }">
      <HugeiconsIcon
        v-if="item.kind === 'project'"
        class="mention-row__icon mention-row__folder"
        :icon="Folder01Icon"
        :size="15"
        :stroke-width="1.8"
      />
      <FileIcon v-else class="mention-row__icon" :path="item.path" :size="15" />
      <span class="mention-row__file">
        <span class="mention-row__name">{{ item.name }}</span>
        <span v-if="item.detail" class="mention-row__parent">{{ item.detail }}</span>
      </span>
    </template>

    <template #empty>
      <p v-if="props.pending" class="mention-menu__empty">Searching project files…</p>
      <p v-else-if="props.error" class="mention-menu__empty">{{ props.error }}</p>
      <p v-else class="mention-menu__empty">
        {{ props.query ? "No matching project files." : "No project files found." }}
      </p>
    </template>
  </ComposerPickerMenu>
</template>

<style scoped>
.mention-row__folder {
  flex: 0 0 auto;
  color: var(--muted);
}

.mention-row__icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.mention-row__file {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 9px;
}

.mention-row__name {
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-row__parent {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-menu__empty {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  font-size: 12.5px;
}
</style>
