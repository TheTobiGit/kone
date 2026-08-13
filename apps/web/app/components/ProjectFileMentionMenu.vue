<script setup lang="ts">
import type { GitProjectFile } from "~/types/desktop";
import FileIcon from "~/components/FileIcon.vue";

// The @ file picker's popover. It wears kone's house popover chrome (the same
// banded-header + hairline-ring shell as ThreadInsertMenu): a calm surface with
// no hard border and no heavy shadow, a soft band across the top, and rows that
// warm to var(--hover) — the keyboard-active row taking the accent tint the app
// uses for a selected list row.

const props = defineProps<{
  files: GitProjectFile[];
  query: string;
  activeIndex: number;
  pending?: boolean;
  error?: string | null;
}>();

const emit = defineEmits<{
  select: [file: GitProjectFile];
  highlight: [index: number];
}>();
</script>

<template>
  <div class="mention-menu" role="listbox" aria-label="Project files">
    <div class="mention-menu__shell">
      <div class="mention-menu__head">
        <span class="mention-menu__at">@</span>
        <span class="mention-menu__title">Project files</span>
        <span v-if="query" class="mention-menu__query">{{ query }}</span>
      </div>

      <div v-if="files.length" class="mention-menu__list">
        <button
          v-for="(file, index) in files"
          :key="file.path"
          type="button"
          class="mention-menu__row"
          :class="{ 'mention-menu__row--active': index === activeIndex }"
          role="option"
          :aria-selected="index === activeIndex"
          @mousedown.prevent
          @mouseenter="emit('highlight', index)"
          @click="emit('select', file)"
        >
          <FileIcon class="mention-menu__icon" :path="file.path" :size="15" />
          <span class="mention-menu__file">
            <span class="mention-menu__name">{{ file.name }}</span>
            <span v-if="file.parent" class="mention-menu__parent">{{ file.parent }}</span>
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
  width: min(520px, calc(100vw - 32px));
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
