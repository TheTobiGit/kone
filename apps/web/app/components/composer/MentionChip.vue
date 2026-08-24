<script setup lang="ts">
import { computed } from "vue";
import FileIcon from "~/components/file/FileIcon.vue";

// A completed @file mention as an atomic inline chip: the file's real VS Code
// type logo + its bare filename (never the full path — that lives in the
// serialized value the composer sends). One component backs both the live
// contenteditable field and the hidden width-measuring mirror, so the two can
// never drift apart. `contenteditable="false"` + `data-mention-path` let the
// field treat it as a single deletable unit and reconstruct the @path on send.
const props = defineProps<{ path: string }>();

const name = computed(() => {
  const clean = props.path.replace(/[\\/]+$/, "");
  const slash = Math.max(clean.lastIndexOf("/"), clean.lastIndexOf("\\"));
  return slash === -1 ? clean : clean.slice(slash + 1);
});
</script>

<template>
  <span
    class="mchip"
    :data-mention-path="path"
    :title="path"
    contenteditable="false"
  >
    <FileIcon class="mchip__icon" :path="path" :size="14" />
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
.mchip__name {
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.005em;
}
</style>
