<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";

// An image the reader clicked inside an agent's visual, over everything, the
// way an image they attached opens: dimmed and blurred behind, the image as
// large as the window allows. A visual's local images arrive inlined as data:
// URIs and its remote ones as https URLs, so either is drawn straight from its
// source.

const props = defineProps<{ src: string; alt: string }>();
const emit = defineEmits<{ close: [] }>();

const { cue } = useSound();
const shown = ref(false);

function close(): void {
  shown.value = false;
}

// Over a visual that may itself be in the full-size viewer: taken in the
// capture phase and consumed, so one press closes this and nothing behind it.
function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
  event.preventDefault();
  event.stopImmediatePropagation();
  close();
}

onMounted(() => {
  cue("show");
  window.addEventListener("keydown", onKey, { capture: true });
  requestAnimationFrame(() => (shown.value = true));
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, { capture: true }));
</script>

<template>
  <Teleport to="body">
    <Transition name="visimg" appear @after-leave="emit('close')">
      <div v-if="shown" class="visimg" role="dialog" aria-modal="true" :aria-label="props.alt || 'Image'" @click.self="close">
        <div class="visimg__bar">
          <span class="visimg__title">{{ props.alt || "Image" }}</span>
          <button type="button" class="visimg__close" aria-label="Close" title="Close (Esc)" @click="close">
            <HugeiconsIcon :icon="Cancel01Icon" :size="16" :stroke-width="2" />
          </button>
        </div>
        <div class="visimg__stage" @click.self="close">
          <img class="visimg__image" :src="props.src" :alt="props.alt" />
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.visimg {
  position: fixed;
  inset: 0;
  z-index: 10000;
  display: flex;
  flex-direction: column;
  background: rgba(0, 0, 0, 0.82);
  backdrop-filter: blur(14px);
}
.visimg__bar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 18px;
  color: #fff;
}
.visimg__title {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
}
.visimg__close {
  display: inline-flex;
  flex: none;
  padding: 5px 7px;
  border: 0;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.1);
  color: #fff;
  cursor: pointer;
  transition: background-color 0.15s ease;
}
.visimg__close:hover {
  background: rgba(255, 255, 255, 0.2);
}
.visimg__stage {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 16px 24px 32px;
}
.visimg__image {
  max-width: 90vw;
  max-height: 84vh;
  object-fit: contain;
  border-radius: 8px;
  box-shadow:
    0 0 0 1px rgba(255, 255, 255, 0.08),
    0 16px 40px -12px rgba(0, 0, 0, 0.35);
  user-select: none;
}
.visimg-enter-active,
.visimg-leave-active {
  transition: opacity 0.2s ease;
}
.visimg-enter-from,
.visimg-leave-to {
  opacity: 0;
}
@media (prefers-reduced-motion: reduce) {
  .visimg-enter-active,
  .visimg-leave-active {
    transition: none;
  }
}
</style>
