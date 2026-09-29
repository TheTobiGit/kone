<script setup lang="ts">
import { ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PlusSignIcon } from "@hugeicons/core-free-icons";
import type { InstructionFileInfo } from "~/composables/useSpaceInstructions";
import { useMarkdown } from "~/composables/useMarkdown";

const props = defineProps<{
  info: InstructionFileInfo;
}>();

const emit = defineEmits<{
  create: [];
}>();

const { render: renderMd } = useMarkdown();

const renderedHtml = ref<string | null>(null);

function stripRedundantHeading(text: string, path: string): string {
  const baseName = path.split("/").pop() ?? path;
  const nameWithoutExt = baseName.replace(/\.md$/i, "");
  // Drop a redundant top-level `# AGENTS.md` or `# CLAUDE.md` heading since the section header already displays it
  const pattern = new RegExp(`^#\\s+(?:${baseName}|${nameWithoutExt})\\b[^\\n]*\\n*`, "i");
  return text.replace(pattern, "").trimStart();
}

watch(
  () => props.info.text,
  async (text) => {
    if (text) {
      const stripped = stripRedundantHeading(text, props.info.path);
      renderedHtml.value = await renderMd(stripped);
    } else {
      renderedHtml.value = null;
    }
  },
  { immediate: true },
);
</script>

<template>
  <div class="inst-panel">
    <div v-if="info.detected" class="inst__body-wrap">
      <div
        v-if="renderedHtml"
        class="inst__body md"
        v-html="renderedHtml"
      />
      <pre v-else class="inst__raw">{{ info.text }}</pre>
    </div>

    <div v-else class="inst__empty">
      <p class="inst__empty-text">
        <template v-if="info.kind === 'agents'">
          No <code>AGENTS.md</code> found in this repository.
        </template>
        <template v-else>
          No <code>CLAUDE.md</code> found in this repository.
        </template>
      </p>
      <button
        type="button"
        class="inst__empty-create"
        @click="emit('create')"
      >
        <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" aria-hidden="true" />
        <span>Create {{ info.path }}</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.inst-panel {
  display: flex;
  flex-direction: column;
  gap: 14px;
  min-width: 0;
  flex: 1;
  min-height: 0;
  padding: 18px 20px;
  border-radius: 16px;
  background-color: color-mix(in srgb, var(--ink) 3.5%, transparent);
}

.inst__body-wrap {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  padding-right: 6px;
}
.inst__body {
  font-size: 13px;
  line-height: 1.65;
  color: var(--ink);
}
.inst__raw {
  font-family: var(--font-mono);
  font-size: 12px;
  line-height: 1.55;
  color: var(--ink-soft);
  white-space: pre-wrap;
  word-break: break-word;
}

/* Markdown typography styles: clean, quiet, and readable */
.md :deep(h1) {
  font-size: 14.5px;
  font-weight: 600;
  color: var(--ink);
  margin: 0 0 10px;
}
.md :deep(h2) {
  font-size: 13.5px;
  font-weight: 600;
  color: var(--ink);
  margin: 16px 0 6px;
}
.md :deep(h2:first-child) {
  margin-top: 0;
}
.md :deep(h3) {
  font-size: 12.5px;
  font-weight: 600;
  color: var(--ink);
  margin: 14px 0 4px;
}
.md :deep(p) {
  margin: 0 0 10px;
  color: var(--ink-soft);
}
.md :deep(p:first-child) {
  margin-top: 0;
}
.md :deep(ul),
.md :deep(ol) {
  margin: 0 0 10px;
  padding-left: 18px;
  color: var(--ink-soft);
}
.md :deep(li) {
  margin-bottom: 4px;
}
.md :deep(strong) {
  font-weight: 600;
  color: var(--ink);
}
.md :deep(code) {
  font-family: var(--font-mono);
  font-size: 0.9em;
  padding: 1px 5px;
  border-radius: 4px;
  background-color: var(--hover);
  color: var(--ink);
}
.md :deep(pre) {
  padding: 12px 14px;
  border-radius: 8px;
  background-color: var(--hover);
  overflow-x: auto;
  line-height: 1.5;
  margin: 10px 0;
}
.md :deep(pre code) {
  padding: 0;
  background: none;
  font-size: 12px;
  color: var(--ink);
}
.md :deep(blockquote) {
  margin: 10px 0;
  padding: 6px 14px;
  border-left: 2px solid var(--accent);
  background-color: color-mix(in srgb, var(--accent) 4%, transparent);
  border-radius: 0 6px 6px 0;
  color: var(--ink-soft);
}
.md :deep(hr) {
  margin: 16px 0;
  border: 0;
  border-top: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
}
.md :deep(table) {
  border-collapse: collapse;
  font-size: 12px;
  margin: 10px 0;
  width: 100%;
}
.md :deep(th),
.md :deep(td) {
  padding: 6px 12px 6px 0;
  border-bottom: 1px solid color-mix(in srgb, var(--ink) 6%, transparent);
  text-align: left;
}
.md :deep(th) {
  font-weight: 600;
  color: var(--ink);
}

/* Minimal empty state */
.inst__empty {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  padding: 14px 4px 10px;
  gap: 12px;
}
.inst__empty-text {
  margin: 0;
  font-size: 13px;
  color: var(--muted);
}
.inst__empty-text code {
  font-family: var(--font-mono);
  color: var(--ink);
}
.inst__empty-create {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 12px;
  border-radius: 999px;
  font-size: 12px;
  font-weight: 500;
  color: var(--ground);
  background-color: var(--ink);
  cursor: pointer;
  transition: opacity 0.15s ease;
}
.inst__empty-create:hover {
  opacity: 0.9;
}
</style>
