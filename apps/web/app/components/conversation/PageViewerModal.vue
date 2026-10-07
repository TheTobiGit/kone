<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Cancel01Icon } from "@hugeicons/core-free-icons";
import type { PageRef } from "@kone/protocol/page-render";
import ModalShell from "~/components/ui/ModalShell.vue";
import { useModalExit } from "~/composables/useModalExit";
import { usePageFrame } from "~/composables/usePageFrame";

// An agent's page at full size: the same page in a card that fills most of the
// window's width, for a chart too dense or a mockup too wide to read in the
// reply column. A second frame rather than the inline one moved, so closing
// this leaves the reply exactly as it was. The card is as tall as the page
// reports, so a short chart gets a short card; a page taller than the window
// scrolls inside its frame instead.

const props = defineProps<{ page: PageRef }>();
const emit = defineEmits<{ close: [] }>();

const { shown, dismiss } = useModalExit();
const frame = ref<HTMLIFrameElement | null>(null);
// Starts at the height the agent measured, then follows what the page reports
// at this width. Never past the window: the card stops there anyway, and a page
// sized by its own frame would otherwise keep asking for more.
const height = ref(props.page.height);
// Escape closes the viewer from inside the page too, where the key never
// reaches the window.
const { src } = usePageFrame(
  props.page.attachmentId,
  frame,
  (reported) => {
    height.value = Math.min(reported, window.innerHeight);
  },
  () => onClose(),
);

function onClose(): void {
  dismiss(() => emit("close"));
}

// The viewer stands over whatever showed the page — a thread, the assistant,
// the strip — and each of those answers Escape of its own. Taken in the capture
// phase and consumed, one press closes this layer and nothing behind it.
function onKey(event: KeyboardEvent): void {
  if (event.key !== "Escape") return;
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
        class="pagev relative z-20 overflow-hidden"
        role="dialog"
        aria-modal="true"
        :aria-label="page.title"
      >
        <!-- Recessed header band with the shell's arc scoops: what the page is,
             and the way out. -->
        <div class="pagev__band">
          <span class="pagev__title">{{ page.title }}</span>
          <button type="button" class="pagev__close" aria-label="Close" title="Close (Esc)" @click="onClose">
            <HugeiconsIcon :icon="Cancel01Icon" :size="14" :stroke-width="2" />
          </button>
        </div>
        <iframe
          ref="frame"
          class="pagev__frame"
          :style="{ height: `calc(${height}px + 2rem)` }"
          :src="src"
          :title="page.title"
          sandbox="allow-scripts allow-forms"
          referrerpolicy="no-referrer"
        />
      </div>
    </ModalShell>
  </Teleport>
</template>

<style scoped>
/* The shared shell card: panel fill, the large radius and a hairline ring. */
.pagev {
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
.pagev__band {
  position: relative;
  z-index: 1;
  flex: none;
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.5rem 0.75rem 0.5rem 1rem;
  background-color: var(--band-bg);
}
.pagev__band::before,
.pagev__band::after {
  content: "";
  position: absolute;
  top: 100%;
  width: var(--band-arc);
  height: var(--band-arc);
  pointer-events: none;
}
.pagev__band::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.pagev__band::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}
.pagev__title {
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
.pagev__close {
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
.pagev__close:hover {
  background-color: var(--hover);
  color: var(--ink);
}

/* The page sits straight on the panel, inset so its edges clear the scoops. */
/* The frame's height is the page's plus its inset; past the card's cap it
   shrinks and the page scrolls. */
.pagev__frame {
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
  .pagev__frame {
    transition: none;
  }
}
</style>
