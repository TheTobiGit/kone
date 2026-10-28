<script setup lang="ts">
import { ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Attachment01Icon, Cancel01Icon } from "@hugeicons/core-free-icons";
import type { ChatAttachment } from "~/types/desktop";
import type { UploadingAnswerFile } from "~/composables/useUserInputAttachments";
import { formatFileSize } from "~/utils/formatFile";

// The files riding one answer: a quiet paperclip button, its hidden picker, and
// a wrap of chips — image thumbnails or a file-type badge, the name, and a
// remove ✕. Stored files and in-flight rows share the row so the user sees the
// whole answer at a glance.

const props = defineProps<{
  attachments: ChatAttachment[];
  uploading: UploadingAnswerFile[];
  error?: string;
  total: number;
  limit: number;
}>();

const emit = defineEmits<{
  files: [files: File[]];
  remove: [id: string];
}>();

const fileInput = ref<HTMLInputElement | null>(null);

function pickFiles(): void {
  fileInput.value?.click();
}

function onFilesPicked(event: Event): void {
  // SAFETY: bound via @change on this component's hidden file <input>, so the
  // target is that input.
  const input = event.target as HTMLInputElement;
  const files = Array.from(input.files ?? []);
  // Clear first so re-picking the same file still fires a change.
  input.value = "";
  if (files.length > 0) emit("files", files);
}

function fileExtension(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 && dot < name.length - 1
    ? name.slice(dot + 1, dot + 5).toUpperCase()
    : "FILE";
}

function isImage(att: ChatAttachment): boolean {
  return att.type === "image" || att.mimeType.toLowerCase().startsWith("image/");
}
</script>

<template>
  <div class="ask-attach">
    <input
      ref="fileInput"
      type="file"
      multiple
      class="ask-file-input"
      tabindex="-1"
      aria-hidden="true"
      @change="onFilesPicked"
    />
    <button
      type="button"
      class="ask-attach-btn"
      aria-label="Attach images or files"
      title="Attach images or files"
      @click="pickFiles"
    >
      <HugeiconsIcon :icon="Attachment01Icon" :size="15" :stroke-width="1.8" />
    </button>

    <div v-if="props.attachments.length || props.uploading.length" class="ask-chips">
      <span
        v-for="att in props.attachments"
        :key="att.id"
        class="ask-chip"
        :title="`${att.name} (${formatFileSize(att.sizeBytes)})`"
      >
        <img
          v-if="isImage(att)"
          class="ask-chip__thumb"
          :src="`attachment://${att.id}`"
          :alt="att.name"
        />
        <span v-else class="ask-chip__ext">{{ fileExtension(att.name) }}</span>
        <span class="ask-chip__name">{{ att.name }}</span>
        <button
          type="button"
          class="ask-chip__remove"
          :aria-label="`Remove ${att.name}`"
          :title="`Remove ${att.name}`"
          @click="emit('remove', att.id)"
        >
          <HugeiconsIcon :icon="Cancel01Icon" :size="11" :stroke-width="2.2" />
        </button>
      </span>

      <span
        v-for="file in props.uploading"
        :key="file.key"
        class="ask-chip ask-chip--uploading"
      >
        <span class="ask-chip__name">{{ file.name }}</span>
        <span class="ask-chip__state">Uploading…</span>
      </span>
    </div>

    <span v-if="props.total >= props.limit" class="ask-attach-hint">
      {{ props.limit }} files max
    </span>
  </div>
  <p v-if="props.error" class="ask-attach-error" role="alert">
    {{ props.error }}
  </p>
</template>

<style scoped>
.ask-attach {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
}
.ask-file-input {
  display: none;
}
.ask-attach-btn {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  border-radius: 8px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ask-attach-btn:hover,
.ask-attach-btn:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.ask-chips {
  display: flex;
  min-width: 0;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-chip {
  display: inline-flex;
  max-width: 100%;
  align-items: center;
  gap: 6px;
  padding: 3px 4px 3px 3px;
  border: 1px solid var(--btn-border);
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  font-size: 12px;
  line-height: 1.2;
}
.ask-chip__thumb {
  width: 22px;
  height: 22px;
  flex: none;
  border-radius: 5px;
  object-fit: cover;
}
.ask-chip__ext {
  display: inline-flex;
  min-width: 22px;
  height: 22px;
  align-items: center;
  justify-content: center;
  padding: 0 3px;
  border-radius: 5px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  color: var(--muted);
  font-family: var(--font-mono);
  font-size: 9px;
  font-weight: 600;
}
.ask-chip__name {
  min-width: 0;
  max-width: 14rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
.ask-chip__state {
  flex: none;
  color: var(--muted);
  font-size: 11px;
}
.ask-chip--uploading {
  opacity: 0.75;
}
.ask-chip__remove {
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  border-radius: 5px;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.18s ease,
    color 0.18s ease;
}
.ask-chip__remove:hover,
.ask-chip__remove:focus-visible {
  background: var(--hover);
  color: var(--ink);
}
.ask-attach-hint {
  color: var(--muted);
  font-size: 11px;
}
.ask-attach-error {
  font-size: 12px;
  line-height: 1.35;
  color: var(--danger, #d9544f);
}
</style>
