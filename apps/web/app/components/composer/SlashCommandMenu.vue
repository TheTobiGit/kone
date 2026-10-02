<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import ComposerPickerMenu from "~/components/composer/ComposerPickerMenu.vue";
import { slashCommandTitle, type SlashCommandItem } from "~/utils/composerMentions";

// The `/` picker's popover: the shared composer shell with one command row per
// item. The glyph rides on the item now, so the menu never keeps a parallel
// name→icon map beside the command table. Skill rows follow the commands in
// the same list, so one keyboard walk covers both.

const props = defineProps<{
  items: SlashCommandItem[];
  query: string;
  activeIndex: number;
}>();

const emit = defineEmits<{
  select: [item: SlashCommandItem];
  highlight: [index: number];
}>();

const hasSkills = computed(() => props.items.some((item) => item.skill));
const hasCommands = computed(() => props.items.some((item) => !item.skill));
const title = computed(() => {
  if (hasSkills.value && hasCommands.value) return "Commands & skills";
  return hasSkills.value ? "Skills" : "Commands";
});

// The first skill after the commands wears the hairline the mention list
// draws between its sections, so the two kinds never read as one run.
function rowClass(item: SlashCommandItem, index: number): string {
  const prev = props.items[index - 1];
  return item.skill && prev && !prev.skill ? "composer-picker__row--boundary" : "";
}

function selectAt(index: number): void {
  const item = props.items[index];
  if (item) emit("select", item);
}
</script>

<template>
  <ComposerPickerMenu
    glyph="/"
    :title="title"
    :query="props.query"
    :list-label="title"
    :items="props.items"
    :active-index="props.activeIndex"
    :item-key="(item) => item.name"
    :row-class="rowClass"
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
      <p class="slash-menu__empty">No matching command or skill</p>
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
