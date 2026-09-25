<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { PauseIcon, PlayIcon, ReplayIcon } from "@hugeicons/core-free-icons";
import ConversationThread from "~/components/conversation/ConversationThread.vue";
import type { ThreadBlock } from "~/composables/useAgent";
import { useEdgeFade } from "~/composables/useEdgeFade";
import { PREVIEW_HOLD_MS } from "~/composables/useConversationPreview";
import type { ResponseDisplay } from "~/utils/responseDisplay";
import type { ConversationStyle } from "~/utils/conversationStyle";

// The Conversation page's stage: a turn playing on the actual thread renderer,
// under exactly the choices being staged. A thin line under it tracks the take
// through its two halves — working, then done.

const props = defineProps<{
  open: boolean;
  /** The choices the take plays under. */
  display: ResponseDisplay;
  /** The style the take is drawn in. */
  conversationStyle: ConversationStyle;
  /** A tile is being tried on, so the stage isn't showing what's set. */
  probing: boolean;
  blocks: ThreadBlock[];
  now: number;
  playing: boolean;
  /** The take has reached its done half. */
  done: boolean;
  /** How far through its working half the take is, 0–1. */
  progress: number;
  /** Changes with every take, restarting the done half's fill. */
  takeId: number;
}>();

const emit = defineEmits<{ replay: []; toggle: [] }>();

// The stage follows the turn down as it grows, the way a live thread does.
const scroller = ref<HTMLElement>();
const { measure, maskStyle } = useEdgeFade(scroller);
watch(
  () => props.blocks,
  () =>
    void nextTick(() => {
      const el = scroller.value;
      if (!el) return;
      el.scrollTop = el.scrollHeight;
      measure();
    }),
);
</script>

<template>
  <aside class="cv__stage" aria-label="Preview">
    <div class="cv__frame" :class="{ 'cv__frame--probe': probing }">
      <!-- A picture of a thread, not a thread: inert, so nothing in it
           takes focus or a click, and the take plays on undisturbed. -->
      <div ref="scroller" class="cv__screen" :style="maskStyle" inert @scroll.passive="measure">
        <ConversationThread
          :blocks="blocks"
          :now="now"
          :display="display"
          :conversation-style="conversationStyle"
          agent-seed="conversation-preview"
          :scratchpad="false"
          hide-empty-art
        />
      </div>

      <!-- The transport rides the frame's corner, out of the thread's way. -->
      <div class="cv__transport">
        <button
          type="button"
          class="cv__btn"
          :tabindex="open ? 0 : -1"
          aria-label="Replay the preview"
          @click="emit('replay')"
        >
          <HugeiconsIcon :icon="ReplayIcon" :size="14" :stroke-width="1.8" />
        </button>
        <button
          type="button"
          class="cv__btn"
          :tabindex="open ? 0 : -1"
          :aria-pressed="playing"
          :aria-label="playing ? 'Pause the preview' : 'Play the preview'"
          @click="emit('toggle')"
        >
          <HugeiconsIcon :icon="playing ? PauseIcon : PlayIcon" :size="14" :stroke-width="1.8" />
        </button>
      </div>
    </div>

    <!-- The take's two halves: working, then done. The half that's
         playing fills; the matching half of the page lights with it. -->
    <div class="cv__phaseline" aria-hidden="true">
      <span class="cv__seg cv__seg--live">
        <i class="cv__fill" :style="{ transform: `scaleX(${done ? 1 : progress})` }" />
      </span>
      <span class="cv__seg cv__seg--done">
        <i
          :key="takeId"
          class="cv__fill cv__fill--hold"
          :class="{ 'cv__fill--run': done && playing }"
          :style="{ '--hold': `${PREVIEW_HOLD_MS}ms` }"
        />
      </span>
    </div>
  </aside>
</template>

<style scoped>
@keyframes cv-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}

/* ── the stage ────────────────────────────────────────────────────────────── */
.cv__stage {
  display: flex;
  flex-direction: column;
  gap: 12px;
  min-height: 0;
  padding-bottom: 0.5rem;
  animation: cv-in var(--cv-t-enter) var(--cv-ease) backwards;
  animation-delay: 120ms;
}
/* A window onto a thread: the thread's own ground, a hairline, and enough
   height that a whole turn has room to happen in it. */
.cv__frame {
  position: relative;
  flex: 1;
  min-height: 320px;
  border-radius: 18px;
  background-color: var(--ground);
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 4%, transparent),
    0 12px 32px -18px color-mix(in srgb, var(--ink) 22%, transparent);
  overflow: hidden;
  transition: box-shadow var(--cv-t-small) ease;
}
/* Trying a tile on is the one moment the stage isn't showing what's set, so
   the frame says so in the accent — no caption needed. */
.cv__frame--probe {
  box-shadow:
    inset 0 0 0 1.5px color-mix(in srgb, var(--accent) 45%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 4%, transparent),
    0 12px 32px -18px color-mix(in srgb, var(--accent) 30%, transparent);
}
.cv__screen {
  position: absolute;
  inset: 0;
  padding: 22px 22px 48px;
  overflow-y: auto;
  scrollbar-width: none;
  scroll-behavior: smooth;
}
.cv__screen::-webkit-scrollbar {
  width: 0;
  height: 0;
}
.cv__transport {
  position: absolute;
  right: 10px;
  bottom: 10px;
  display: flex;
  gap: 2px;
  padding: 3px;
  border-radius: 11px;
  background-color: color-mix(in srgb, var(--ground) 82%, transparent);
  backdrop-filter: blur(8px);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  opacity: 0.55;
  transition: opacity var(--cv-t-small) ease;
}
.cv__frame:hover .cv__transport,
.cv__transport:focus-within {
  opacity: 1;
}
/* The app's one button recipe: bare until hovered, then a soft pill. */
.cv__btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 8px;
  color: var(--ink-soft);
  cursor: pointer;
  transition: background-color var(--cv-t-micro) ease;
}
.cv__btn:hover {
  background-color: var(--hover);
}
.cv__btn:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* The take's timeline: the working half long, the done half short, as a turn
   is. Hairline-thin, so it reads as a progress mark, not a control. */
.cv__phaseline {
  display: flex;
  gap: 4px;
  padding-inline: 6px;
}
.cv__seg {
  position: relative;
  height: 3px;
  border-radius: 2px;
  background-color: color-mix(in srgb, var(--ink) 9%, transparent);
  overflow: hidden;
}
.cv__seg--live {
  flex: 3;
}
.cv__seg--done {
  flex: 1;
}
.cv__fill {
  position: absolute;
  inset: 0;
  border-radius: inherit;
  background-color: var(--accent);
  opacity: 0.7;
  transform-origin: left;
  transform: scaleX(0);
  transition: transform 420ms var(--cv-ease);
}
/* The done half fills over the hold, so it empties into the next take. */
.cv__fill--hold {
  transition: none;
}
.cv__fill--run {
  animation: cv-hold var(--hold) linear forwards;
}
@keyframes cv-hold {
  to {
    transform: scaleX(1);
  }
}

/* A page too narrow for two columns stacks the stage over the choices, at a
   height that still fits a turn. */
@media (max-width: 1180px) {
  .cv__stage {
    order: -1;
  }
  .cv__frame {
    flex: none;
    height: clamp(240px, 36vh, 360px);
    min-height: 0;
  }
}

@media (prefers-reduced-motion: reduce) {
  .cv__stage {
    animation: none;
  }
  .cv__fill {
    transition: none;
  }
  .cv__fill--run {
    animation: none;
    transform: scaleX(1);
  }
  .cv__screen {
    scroll-behavior: auto;
  }
}
</style>
