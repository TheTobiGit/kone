<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon, MinusSignIcon, PlusSignIcon } from "@hugeicons/core-free-icons";
import type { VisualRef } from "@kone/protocol/visual-render";
import ModalShell from "~/components/ui/ModalShell.vue";
import VisualImageViewer from "~/components/conversation/VisualImageViewer.vue";
import { useModalExit } from "~/composables/useModalExit";
import { useVisualFrame } from "~/composables/useVisualFrame";

// An agent's visual at full size: the same visual in a card that fills most of the
// window's width, for a chart too dense or a mockup too wide to read in the
// reply column. A second frame rather than the inline one moved, so closing
// this leaves the reply exactly as it was. The card is as tall as the visual
// reports, so a short chart gets a short card; a visual taller than the window
// scrolls inside its frame instead. Zoom scales the visual's own pixels, so a
// dense chart can be read closer and a wide mockup seen whole; the visual lays
// out again at the width that leaves it.

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2;
const ZOOM_STEP = 0.25;

const props = defineProps<{ visual: VisualRef }>();
const emit = defineEmits<{ close: [] }>();

const { shown, dismiss } = useModalExit();
const frame = ref<HTMLIFrameElement | null>(null);
// Starts at the height the agent measured, then follows what the visual reports
// at this width. Never past the window: the card stops there anyway, and a visual
// sized by its own frame would otherwise keep asking for more.
const height = ref(props.visual.height);
const zoom = ref(1);
const zoomLabel = computed(() => `${Math.round(zoom.value * 100)}%`);
const image = ref<{ src: string; alt: string } | null>(null);
// Escape closes the viewer from inside the visual too, where the key never
// reaches the window.
const { src } = useVisualFrame(props.visual.attachmentId, frame, {
  onHeight: (reported) => {
    height.value = Math.min(reported, window.innerHeight / zoom.value);
  },
  onEscape: () => onClose(),
  onImage: (source, alt) => (image.value = { src: source, alt }),
});

function zoomBy(step: number): void {
  zoom.value = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom.value + step));
}

function onClose(): void {
  dismiss(() => emit("close"));
}

// The viewer stands over whatever showed the visual — a thread, the assistant,
// the strip — and each of those answers Escape of its own. Taken in the capture
// phase and consumed, one press closes this layer and nothing behind it.
function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape" || image.value) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  onClose();
}

onMounted(() => {
  window.addEventListener("keydown", onKey, { capture: true });
  requestAnimationFrame(() => (shown.value = true));
});
onBeforeUnmount(() => window.removeEventListener("keydown", onKey, { capture: true }));
</script>

<template>
  <Teleport to="body">
    <ModalShell v-slot="{ card }" :shown="shown" class="z-50 items-center justify-center p-6" @dismiss="onClose">
      <div
        v-bind="card"
        class="visv relative z-20 overflow-hidden"
        role="dialog"
        aria-modal="true"
        :aria-label="visual.title"
      >
        <!-- Recessed header band with the shell's arc scoops: what the visual is,
             and the way out. -->
        <div class="visv__band">
          <span class="visv__title">{{ visual.title }}</span>
          <div class="visv__zoom" role="group" aria-label="Zoom">
            <button type="button" class="visv__close" aria-label="Zoom out" title="Zoom out" :disabled="zoom <= ZOOM_MIN" @click="zoomBy(-ZOOM_STEP)">
              <HugeiconsIcon :icon="MinusSignIcon" :size="13" :stroke-width="2" />
            </button>
            <button type="button" class="visv__zoom-level" title="Actual size" @click="zoom = 1">{{ zoomLabel }}</button>
            <button type="button" class="visv__close" aria-label="Zoom in" title="Zoom in" :disabled="zoom >= ZOOM_MAX" @click="zoomBy(ZOOM_STEP)">
              <HugeiconsIcon :icon="PlusSignIcon" :size="13" :stroke-width="2" />
            </button>
          </div>
          <button type="button" class="visv__close" aria-label="Close" title="Close (Esc)" @click="onClose">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>
        <iframe
          ref="frame"
          class="visv__frame"
          :style="{ height: `calc(${height}px + 2rem)`, zoom }"
          :src="src"
          :title="visual.title"
          sandbox="allow-scripts allow-forms"
          referrerpolicy="no-referrer"
        />
      </div>
    </ModalShell>
  </Teleport>
  <VisualImageViewer v-if="image" :src="image.src" :alt="image.alt" @close="image = null" />
</template>

<style scoped>
/* The shared shell card: panel fill, the large radius and a hairline ring. */
.visv {
  --band-bg: var(--band);
  --band-arc: 14px;
  display: flex;
  flex-direction: column;
  width: min(1180px, 100%);
  max-height: 100%;
  border-radius: 18px;
  background: var(--panel);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
}

/* ── header band ── */
.visv__band {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem 0.75rem 0.5rem 1rem;
  background-color: var(--band-bg);
}
.visv__band::before,
.visv__band::after {
  content: "";
  position: absolute;
  top: 100%;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.visv__band::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.visv__band::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.visv__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  text-transform: uppercase;
  color: var(--muted);
}
.visv__close {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 28px;
  height: 28px;
  border: 0;
  border-radius: 9px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}
.visv__close:hover:not(:disabled) {
  background-color: var(--hover);
  color: var(--ink);
}
.visv__close:disabled {
  opacity: 0.4;
  cursor: default;
}
.visv__zoom {
  display: flex;
  align-items: center;
  flex: none;
}
.visv__zoom-level {
  min-width: 3.2em;
  padding: 0 2px;
  border: 0;
  background: transparent;
  font-family: var(--font-mono);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
  cursor: pointer;
}
.visv__zoom-level:hover {
  color: var(--ink);
}

/* The visual sits straight on the panel, inset so its edges clear the scoops. */
/* The frame's height is the visual's plus its inset; past the card's cap it
   shrinks and the visual scrolls. */
.visv__frame {
  display: block;
  flex: 0 1 auto;
  box-sizing: border-box;
  width: 100%;
  min-height: 0;
  padding: 0.75rem 1.25rem 1.25rem;
  border: 0;
  background: transparent;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
@media (prefers-reduced-motion: reduce) {
  .visv__frame {
    transition: none;
  }
}
</style>
