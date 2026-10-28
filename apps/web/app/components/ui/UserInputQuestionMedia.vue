<script setup lang="ts">
import { ref } from "vue";
import type { ChatAttachment, QuestionVisual } from "~/types/desktop";
import VisualFrame from "~/components/conversation/VisualFrame.vue";
import VisualImageViewer from "~/components/conversation/VisualImageViewer.vue";

// What the agent attached to its question: images from its own attachment
// store, opened large in the shared viewer, and a live visual drawn by the same
// frame a reply uses (theme, height reports, expand).

const props = defineProps<{
  images?: ChatAttachment[];
  visual?: QuestionVisual;
}>();

const viewedImage = ref<{ src: string; alt: string } | null>(null);

function openImage(image: ChatAttachment): void {
  viewedImage.value = { src: `attachment://${image.id}`, alt: image.name };
}
</script>

<template>
  <div v-if="props.images?.length" class="ask-agent-images">
    <button
      v-for="img in props.images"
      :key="img.id"
      type="button"
      class="ask-agent-thumb"
      :title="`Preview ${img.name}`"
      :aria-label="`Preview ${img.name}`"
      @click="openImage(img)"
    >
      <img :src="`attachment://${img.id}`" :alt="img.name" loading="lazy" />
    </button>
  </div>
  <VisualFrame v-if="props.visual" :visual="props.visual" />
  <VisualImageViewer
    v-if="viewedImage"
    :src="viewedImage.src"
    :alt="viewedImage.alt"
    @close="viewedImage = null"
  />
</template>

<style scoped>
.ask-agent-images {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.ask-agent-thumb {
  width: 72px;
  height: 72px;
  flex: none;
  padding: 0;
  overflow: hidden;
  border: 1px solid var(--btn-border);
  border-radius: 9px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  cursor: zoom-in;
  transition: border-color 0.18s ease;
}
.ask-agent-thumb:hover,
.ask-agent-thumb:focus-visible {
  border-color: color-mix(in srgb, var(--ink) 26%, transparent);
}
.ask-agent-thumb img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
}
</style>
