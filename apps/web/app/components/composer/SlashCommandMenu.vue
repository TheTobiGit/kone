<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import ComposerPickerMenu from "~/components/composer/ComposerPickerMenu.vue";
import { slashCommandTitle, type SlashCommandItem } from "~/utils/composerMentions";

// The `/` picker's popover: the shared composer shell with one command row per
// item. The glyph rides on the item now, so the menu never keeps a parallel
// name→icon map beside the command table.

const props = defineProps<{
  items: SlashCommandItem[];
  query: string;
  activeIndex: number;
}>();

const emit = defineEmits<{
  select: [item: SlashCommandItem];
  highlight: [index: number];
}>();

function selectAt(index: number): void {
  const item = props.items[index];
  if (item) emit("select", item);
}
</script>

<template>
  <ComposerPickerMenu
    glyph="/"
    title="Commands"
    :query="props.query"
    list-label="Slash commands"
    :items="props.items"
    :active-index="props.activeIndex"
    :item-key="(item) => item.name"
    @select="selectAt"
    @highlight="emit('highlight', $event)"
  >
    <template #row="{ item }">
      <HugeiconsIcon :icon="item.icon" :size="15" :stroke-width="2" class="slash-row__icon" />
      <span class="slash-row__text">
        <span class="slash-row__name">{{ slashCommandTitle(item.name) }}</span>
        <span class="slash-row__desc">{{ item.description }}</span>
      </span>
    </template>

    <template #empty>
      <p class="slash-menu__empty">No matching command</p>
    </template>
  </ComposerPickerMenu>
</template>

<style scoped>
.slash-row__icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.slash-row__text {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 9px;
}

.slash-row__name {
  overflow: hidden;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-row__desc {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-menu__empty {
  margin: 0;
  padding: 14px;
  color: var(--muted);
  font-size: 12.5px;
}
</style>
