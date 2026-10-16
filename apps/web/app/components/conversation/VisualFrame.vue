<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowExpand01Icon, Copy01Icon, RefreshIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { VISUAL_COLUMN_WIDTH, visualFrameHeight, type VisualRef } from "@kone/protocol/visual-render";
import VisualViewerModal from "~/components/conversation/VisualViewerModal.vue";
import VisualImageViewer from "~/components/conversation/VisualImageViewer.vue";
import { useVisualFrame } from "~/composables/useVisualFrame";

// A dynamic visual the agent showed, standing in its reply where it was placed:
// the agent's own HTML on the thread's own ground, borderless, so it reads as
// part of what the agent said rather than as an embed.
//
// The box is reserved before the visual loads, at the height it measured near
// this width when it was shown, so the thread doesn't jump when it arrives;
// the frame then follows the height the visual reports, so one that wraps
// taller here never ends up scrolling inside the thread and taking the
// reader's scroll. Past the cap the visual scrolls inside the frame instead.
// Until the visual has something to show, a quiet placeholder holds the box.

const props = defineProps<{
  visual: VisualRef;
  /** Play the arrival. Off for a transcript loaded from history. */
  animate?: boolean;
}>();

const { cue } = useSound();

const box = ref<HTMLDivElement | null>(null);
const frame = ref<HTMLIFrameElement | null>(null);
const width = ref(VISUAL_COLUMN_WIDTH);
const reported = ref<number | undefined>(undefined);
const height = computed(() => visualFrameHeight(props.visual, width.value, reported.value));
const ready = ref(false);
const unavailable = ref(false);
const image = ref<{ src: string; alt: string } | null>(null);

const { src, reload } = useVisualFrame(props.visual.attachmentId, frame, {
  onHeight: (next) => (reported.value = next),
  onReady: () => (ready.value = true),
  onImage: (source, alt) => (image.value = { src: source, alt }),
  onUnavailable: () => (unavailable.value = true),
});

let resizing: ResizeObserver | null = null;
onMounted(() => {
  if (!box.value) return;
  width.value = box.value.clientWidth || VISUAL_COLUMN_WIDTH;
  resizing = new ResizeObserver(([entry]) => {
    if (entry && entry.contentRect.width > 0) width.value = entry.contentRect.width;
  });
  resizing.observe(box.value);
});
onBeforeUnmount(() => resizing?.disconnect());

const viewing = ref(false);
function expand(): void {
  cue("expand");
  viewing.value = true;
}

function refresh(): void {
  ready.value = false;
  reported.value = undefined;
  reload();
}

const copied = ref(false);
let copiedTimer: ReturnType<typeof setTimeout> | undefined;
async function copySource(): Promise<void> {
  const source = await window.koneDesktop?.agent?.readVisualSource(props.visual.attachmentId).catch(() => null);
  if (!source) return;
  await navigator.clipboard.writeText(source);
  copied.value = true;
  clearTimeout(copiedTimer);
  copiedTimer = setTimeout(() => (copied.value = false), 1400);
}
onBeforeUnmount(() => clearTimeout(copiedTimer));
</script>

<template>
  <p v-if="unavailable" class="vis-gone" role="status">
    <span class="vis-gone__title">{{ visual.title }}</span>
    <span>This visual is no longer stored.</span>
  </p>
  <div
    v-else
    ref="box"
    class="vis"
    :class="{ 'vis--enter': animate, 'vis--ready': ready }"
    :style="{ height: `${height}px` }"
  >
    <div v-if="!ready" class="vis__placeholder" role="status" :aria-label="`Loading ${visual.title}`" />
    <!-- Scripts run, in an origin of their own; nothing else is granted. -->
    <iframe
      ref="frame"
      class="vis__frame"
      :src="src"
      :title="visual.title"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    />
    <div class="vis__tools">
      <button type="button" class="vis__tool" :aria-label="copied ? 'Copied' : 'Copy source'" :title="copied ? 'Copied' : 'Copy source'" @click="copySource">
        <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="13" :stroke-width="2" />
      </button>
      <button type="button" class="vis__tool" aria-label="Reload" title="Reload" @click="refresh">
        <HugeiconsIcon :icon="RefreshIcon" :size="13" :stroke-width="2" />
      </button>
      <button type="button" class="vis__tool" :aria-label="`Open ${visual.title} full size`" title="Full size" @click="expand">
        <HugeiconsIcon :icon="ArrowExpand01Icon" :size="13" :stroke-width="2" />
      </button>
    </div>
  </div>
  <VisualViewerModal v-if="viewing" :visual="visual" @close="viewing = false" />
  <VisualImageViewer v-if="image" :src="image.src" :alt="image.alt" @close="image = null" />
</template>

<style scoped>
.vis {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.vis__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color-scheme: normal;
  opacity: 0;
  transition: opacity 0.2s ease;
}
.vis--ready .vis__frame {
  opacity: 1;
}
/* The box the visual will fill, breathing softly until it does: the same
   rounded wash a loading image sits on, so a reply's pending parts read as
   one family. */
.vis__placeholder {
  position: absolute;
  inset: 0;
  border-radius: 12px;
  background: color-mix(in srgb, var(--ink) 4%, transparent);
  animation: vis-breathe 1.6s ease-in-out infinite;
  pointer-events: none;
}
@keyframes vis-breathe {
  50% {
    background: color-mix(in srgb, var(--ink) 7%, transparent);
  }
}
/* Out of the way until the reader is on the visual: it is the one piece of
   chrome on something that is otherwise all the agent's. */
.vis__tools {
  position: absolute;
  top: 6px;
  right: 6px;
  display: flex;
  gap: 2px;
  padding: 2px;
  border-radius: 9px;
  background: color-mix(in oklab, var(--raised) 82%, transparent);
  box-shadow: 0 0 0 1px var(--line-soft);
  backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.vis:hover .vis__tools,
.vis__tools:focus-within {
  opacity: 1;
}
.vis__tool {
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--ink-soft);
}
.vis__tool:hover {
  color: var(--ink);
  background: var(--hover);
}
.vis--enter {
  animation: vis-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@keyframes vis-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
.vis-gone {
  display: flex;
  align-items: baseline;
  gap: 8px;
  margin: 0;
  padding: 8px 12px;
  border-radius: 10px;
  box-shadow: inset 0 0 0 1px var(--line-soft);
  font-size: 13px;
  color: var(--muted);
}
.vis-gone__title {
  max-width: 40%;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--ink-soft);
}
@media (prefers-reduced-motion: reduce) {
  .vis,
  .vis__frame {
    transition: none;
  }
  .vis--enter,
  .vis__placeholder {
    animation: none;
  }
}
</style>
