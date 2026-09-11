<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { AiChipIcon, BotIcon, FoldVerticalIcon, GitBranchIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { SlashCommandItem } from "~/utils/composerMentions";

// The `/` picker's popover. It wears kone's house popover chrome (the same
// banded-header + hairline-ring shell as the @ file picker): a calm surface
// with no hard border, rows that warm to var(--hover), and the keyboard-active
// row taking the accent tint the app uses for a selected list row.

// one glyph per row, looked up by command name so the list stays scannable.
const slashIcons: Record<string, typeof AiChipIcon> = {
  agent: BotIcon,
  branch: GitBranchIcon,
  compact: FoldVerticalIcon,
  model: AiChipIcon,
  new: PlusSignIcon,
};

// The `/` picker's popover. It wears kone's house popover chrome (the same
// banded-header + hairline-ring shell as the @ file picker): a calm surface
// with no hard border, rows that warm to var(--hover), and the keyboard-active
// row taking the accent tint the app uses for a selected list row.

const props = defineProps<{
  items: SlashCommandItem[];
  query: string;
  activeIndex: number;
}>();

const emit = defineEmits<{
  select: [item: SlashCommandItem];
  highlight: [index: number];
}>();
</script>

<template>
  <div class="slash-menu" role="listbox" aria-label="Slash commands">
    <div class="slash-menu__shell">
      <div class="slash-menu__head">
        <span class="slash-menu__glyph">/</span>
        <span class="slash-menu__title">Commands</span>
        <span v-if="query" class="slash-menu__query">{{ query }}</span>
      </div>

      <div v-if="items.length" class="slash-menu__list">
        <button
          v-for="(item, index) in items"
          :key="item.name"
          type="button"
          role="option"
          :aria-selected="index === activeIndex"
          class="slash-menu__row"
          :class="{ 'slash-menu__row--active': index === activeIndex }"
          @mousedown.prevent
          @mouseenter="emit('highlight', index)"
          @click="emit('select', item)"
        >
          <HugeiconsIcon :icon="slashIcons[item.name] ?? AiChipIcon" :size="15" :stroke-width="2" class="slash-menu__icon" />
          <span class="slash-menu__text">
            <span class="slash-menu__name">{{ item.title }}</span>
            <span class="slash-menu__desc">{{ item.description }}</span>
          </span>
        </button>
      </div>

      <p v-else class="slash-menu__empty">No matching command</p>
    </div>
  </div>
</template>

<style scoped>
/* Container — the app's shared modal treatment (BranchPicker / UserInput /
   ThreadInsertMenu): a plain --surface panel lifted by a single hairline ring,
   no drop shadow. It rises a few px on open, anchored to its bottom-left corner
   since it floats above the field. */
.slash-menu {
  width: 100%;
  overflow: hidden;
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transform-origin: bottom left;
  animation: slash-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes slash-in {
  from {
    opacity: 0;
    transform: translateY(5px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.slash-menu__shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  padding: 0 0 5px;
}

/* Header band — a soft strip with arced bottom corners, like the insert menu. */
.slash-menu__head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  background-color: var(--band-bg);
  color: var(--muted);
  font-size: 11.5px;
}
.slash-menu__head::before,
.slash-menu__head::after {
  content: "";
  position: absolute;
  top: 100%;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.slash-menu__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.slash-menu__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.slash-menu__glyph {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}

.slash-menu__title {
  color: var(--ink-soft);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.slash-menu__query {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-menu__list {
  max-height: 288px;
  padding: 6px;
  overflow-y: auto;
}

.slash-menu__row {
  display: flex;
  align-items: center;
  width: 100%;
  gap: 9px;
  min-height: 34px;
  padding: 5px 9px;
  border: 0;
  border-radius: 10px;
  background: transparent;
  color: var(--ink-soft);
  text-align: left;
  cursor: pointer;
  transition: background-color 0.16s ease, color 0.16s ease;
}
.slash-menu__row:hover {
  background: var(--hover);
  color: var(--ink);
}
/* Keyboard-active row takes the accent tint the app uses for a selected list
   row — distinct from a plain hover so arrow-key navigation stays legible. */
.slash-menu__row--active,
.slash-menu__row--active:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--ink);
}

.slash-menu__icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.slash-menu__text {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 9px;
}

.slash-menu__name {
  overflow: hidden;
  color: var(--ink);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-menu__desc {
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

@media (prefers-reduced-motion: reduce) {
  .slash-menu {
    animation: none;
  }
}
</style>
