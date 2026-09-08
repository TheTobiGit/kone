<script setup lang="ts">
import { computed } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Folder01Icon } from "@hugeicons/core-free-icons";
import FileIcon from "~/components/file/FileIcon.vue";
import type { MentionKind } from "~/utils/composerMentions";

// A completed @mention as an atomic inline chip: a file renders its real VS
// Code type logo + bare filename, while a project renders a folder mark + the
// project name so the two never read as the same thing. Either way the full
// path lives in the serialized value the composer sends (and in `title`), not
// on screen. One component backs both the live contenteditable field and the
// hidden width-measuring mirror, so the two can never drift apart.
// `contenteditable="false"` + `data-mention-path` let the field treat it as a
// single deletable unit and reconstruct the @path on send.
const props = withDefaults(defineProps<{ path: string; kind?: MentionKind }>(), {
  kind: "file",
});

const isProject = computed(() => props.kind === "project");

const name = computed(() => {
  const clean = props.path.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash === -1 ? clean : clean.slice(slash + 1);
});
</script>

<template>
  <span
    class="mchip"
    :class="{ 'mchip--project': isProject }"
    :data-mention-path="path"
    :data-mention-kind="kind"
    :title="path"
    contenteditable="false"
  >
    <HugeiconsIcon
      v-if="isProject"
      class="mchip__folder"
      :icon="Folder01Icon"
      :size="14"
      :stroke-width="1.8"
    />
    <FileIcon v-else class="mchip__icon" :path="path" :size="14" />
    <span class="mchip__name">{{ name }}</span>
  </span>
</template>

<style scoped>
/* Inline pill that flows in the text line. It reads as a soft accent token —
   no hard border, no heavy fill — in step with kone's calm surface style. */
.mchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: middle;
  max-width: 100%;
  margin: 0 1px;
  padding: 1px 6px 1px 5px;
  border-radius: 6px;
  background: color-mix(in srgb, var(--accent) 12%, transparent);
  color: color-mix(in srgb, var(--accent) 62%, var(--field-ink, currentColor));
  font-size: 14.5px;
  line-height: 1.15;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
.mchip__icon {
  flex: 0 0 auto;
  transform: translateY(-0.5px);
}
/* A project mention wears a folder mark on a warmer wash than a file chip —
   the same pill, but unmistakably a place rather than a document. */
.mchip--project {
  background: color-mix(in srgb, var(--accent) 16%, transparent);
}
.mchip__folder {
  flex: 0 0 auto;
  transform: translateY(-0.5px);
  color: color-mix(in srgb, var(--accent) 72%, var(--field-ink, currentColor));
}
.mchip__name {
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.005em;
}
</style>
