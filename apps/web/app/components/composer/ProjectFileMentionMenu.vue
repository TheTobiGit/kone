<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import type { MentionItem } from "~/utils/composerMentions";
import FileIcon from "~/components/file/FileIcon.vue";

// The @ file picker's popover. It wears kone's house popover chrome (the same
// banded-header + hairline-ring shell as ThreadInsertMenu): a calm surface with
// no hard border and no heavy shadow, a soft band across the top, and rows that
// warm to var(--hover) — the keyboard-active row taking the accent tint the app
// uses for a selected list row.
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
</script>

<template>
  <div class="mention-menu" role="listbox" aria-label="Project files">
    <div class="mention-menu__shell">
      <div class="mention-menu__head">
        <span class="mention-menu__at">@</span>
        <span class="mention-menu__title">{{ title }}</span>
        <span v-if="query" class="mention-menu__query">{{ query }}</span>
      </div>

      <div v-if="items.length" class="mention-menu__list">
        <button
          v-for="(item, index) in items"
          :key="item.kind + ':' + item.path"
          type="button"
          class="mention-menu__row"
          :class="{
            'mention-menu__row--active': index === activeIndex,
            'mention-menu__row--boundary': index === fileBoundaryIndex && fileBoundaryIndex > 0,
          }"
          role="option"
          :aria-selected="index === activeIndex"
          @mousedown.prevent
          @mouseenter="emit('highlight', index)"
          @click="emit('select', item)"
        >
          <HugeiconsIcon
            v-if="item.kind === 'project'"
            class="mention-menu__icon mention-menu__folder"
            :icon="Folder01Icon"
            :size="15"
            :stroke-width="1.8"
          />
          <FileIcon v-else class="mention-menu__icon" :path="item.path" :size="15" />
          <span class="mention-menu__file">
            <span class="mention-menu__name">{{ item.name }}</span>
            <span v-if="item.detail" class="mention-menu__parent">{{ item.detail }}</span>
          </span>
        </button>
      </div>

      <p v-else-if="pending" class="mention-menu__empty">Searching project files…</p>
      <p v-else-if="error" class="mention-menu__empty">{{ error }}</p>
      <p v-else class="mention-menu__empty">
        {{ query ? "No matching project files." : "No project files found." }}
      </p>
    </div>
  </div>
</template>

<style scoped>
/* Container — the app's shared modal treatment (BranchPicker / UserInput /
   ThreadInsertMenu): a plain --surface panel lifted by a single hairline ring,
   no drop shadow. It rises a few px on open, anchored to its bottom-left corner
   since it floats above the field. */
.mention-menu {
  width: 100%;
  overflow: hidden;
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transform-origin: bottom left;
  animation: mention-in 160ms cubic-bezier(0.22, 1, 0.36, 1);
}
@keyframes mention-in {
  from {
    opacity: 0;
    transform: translateY(5px) scale(0.985);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.mention-menu__shell {
  --band-bg: var(--band);
  --band-arc: 14px;
  padding: 0 0 5px;
}

/* Header band — a soft strip with arced bottom corners, like the insert menu. */
.mention-menu__head {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  padding: 9px 14px;
  background-color: var(--band-bg);
  color: var(--muted);
  font-size: 11.5px;
}
.mention-menu__head::before,
.mention-menu__head::after {
  content: "";
  position: absolute;
  top: 100%;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.mention-menu__head::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.mention-menu__head::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.mention-menu__at {
  color: var(--accent);
  font-family: var(--font-mono);
  font-size: 13px;
  font-weight: 600;
}

.mention-menu__title {
  color: var(--ink-soft);
  font-weight: 600;
  letter-spacing: -0.01em;
}

.mention-menu__query {
  min-width: 0;
  overflow: hidden;
  color: var(--muted);
  font-family: var(--font-mono);
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-menu__list {
  max-height: 288px;
  padding: 6px;
  overflow-y: auto;
}

/* Projects lead the picker with the same row treatment; the hairline below
   them reads as the boundary into this project's own files. */
.mention-menu__section {
  padding: 6px 6px 2px;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
}
.mention-menu__section--lone {
  padding-bottom: 6px;
  border-bottom: 0;
}

.mention-menu__folder {
  flex: 0 0 auto;
  color: var(--muted);
}

.mention-menu__row {
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
.mention-menu__row:hover {
  background: var(--hover);
  color: var(--ink);
}
/* Keyboard-active row takes the accent tint the app uses for a selected list
   row — distinct from a plain hover so arrow-key navigation stays legible. */
.mention-menu__row--active,
.mention-menu__row--active:hover {
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: var(--ink);
}
/* The first file row after the leading projects keeps the hairline boundary
   the two-section list drew — located by kind, not by section lengths. */
.mention-menu__row--boundary {
  border-top: 1px solid color-mix(in srgb, var(--ink) 7%, transparent);
  border-top-left-radius: 0;
  border-top-right-radius: 0;
  margin-top: 2px;
  padding-top: 7px;
}

.mention-menu__icon {
  flex: 0 0 auto;
  opacity: 0.9;
}

.mention-menu__file {
  display: flex;
  align-items: baseline;
  min-width: 0;
  gap: 9px;
}

.mention-menu__name {
  overflow: hidden;
  color: var(--ink);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.mention-menu__parent {
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

@media (prefers-reduced-motion: reduce) {
  .mention-menu {
    animation: none;
  }
}
</style>
