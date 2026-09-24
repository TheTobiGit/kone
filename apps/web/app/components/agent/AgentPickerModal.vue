<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Directions01Icon, FlashIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { DEFAULT_PARTNER_LABEL, type Agent } from "~/utils/agents";
import { JEV_DISCLOSURE, JEV_HOST, JEV_LABEL, JEV_ROUTER_ID, isRouterId } from "~/utils/agentRouting";
import RosterFace from "~/components/agent/RosterFace.vue";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";

const props = withDefaults(
  defineProps<{
    agents: Agent[];
    activeAgentId?: string | null;
    title?: string;
    anchorEl?: HTMLElement | null;
  }>(),
  {
    activeAgentId: null,
    title: "Partner",
    anchorEl: null,
  },
);

const emit = defineEmits<{
  select: [id: string | null];
  cancel: [];
}>();

const { cue } = useSound();

const isDefaultSelected = computed(() => !props.activeAgentId);
/** The router is a third answer beside "this agent" and "nobody" — see
 *  `~/utils/agentRouting`. It travels on the same selection as the rest so the
 *  menu stays one radio group. */
const isRouterSelected = computed(() => isRouterId(props.activeAgentId));

function choose(id: string | null) {
  cue("select");
  close(() => emit("select", id));
}

// ── modal surface & transitions ──────────────────────────────────────────────
const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
const maxCardH = ref<number | null>(null);
const cardPos = ref<{ left?: string; bottom?: string }>({});
const CARD_WIDTH = 320;
const MARGIN = 16;

let ro: ResizeObserver | null = null;
let anchorRO: ResizeObserver | null = null;

function syncPosition() {
  const anchor = props.anchorEl;
  if (!anchor) {
    cardPos.value = {};
    maxCardH.value = null;
    return;
  }
  const anchorRect = anchor.getBoundingClientRect();
  const dockEl = anchor.closest(".dock") ?? anchor;
  const dockRect = dockEl.getBoundingClientRect();

  const vw = "window" in globalThis ? window.innerWidth : 1280;
  const vh = "window" in globalThis ? window.innerHeight : 800;

  // Align with anchor button's left edge
  let left = anchorRect.left;
  if (left + CARD_WIDTH > vw - MARGIN) {
    left = vw - CARD_WIDTH - MARGIN;
  }
  if (left < MARGIN) {
    left = MARGIN;
  }

  // Sit 10px above the composer dock so it hovers right above the card
  const bottom = Math.max(MARGIN, vh - dockRect.top + 10);
  maxCardH.value = Math.max(180, dockRect.top - 24);

  cardPos.value = {
    left: `${Math.round(left)}px`,
    bottom: `${Math.round(bottom)}px`,
  };
}

function syncHeight() {
  const el = contentEl.value;
  if (el) {
    const naturalH = el.offsetHeight;
    cardHeight.value = maxCardH.value !== null ? Math.min(naturalH, maxCardH.value) : naturalH;
  }
}

function onCancel() {
  close(() => emit("cancel"));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    onCancel();
  }
}

function onWindowResize() {
  syncPosition();
  syncHeight();
}

function onWindowScroll(e: Event) {
  const target = e.target;
  // SAFETY: Node type check ensures contains() is valid; contentEl contains means internal scroll.
  if (target instanceof Node && contentEl.value?.contains(target)) return;
  syncPosition();
}

watch(
  () => props.anchorEl,
  (newAnchor, oldAnchor) => {
    if (oldAnchor && anchorRO) anchorRO.unobserve(oldAnchor);
    if (newAnchor) {
      if (!anchorRO) {
        anchorRO = new ResizeObserver(() => {
          syncPosition();
          syncHeight();
        });
      }
      anchorRO.observe(newAnchor);
      const dockEl = newAnchor.closest(".dock");
      if (dockEl && dockEl !== newAnchor) anchorRO.observe(dockEl);
    }
    syncPosition();
    syncHeight();
  },
);

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", onWindowResize);
  window.addEventListener("scroll", onWindowScroll, true);

  syncPosition();
  const anchor = props.anchorEl;
  if (anchor) {
    anchorRO = new ResizeObserver(() => {
      syncPosition();
      syncHeight();
    });
    anchorRO.observe(anchor);
    const dockEl = anchor.closest(".dock");
    if (dockEl && dockEl !== anchor) anchorRO.observe(dockEl);
  }

  await nextTick();
  syncPosition();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", onWindowResize);
  window.removeEventListener("scroll", onWindowScroll, true);
  ro?.disconnect();
  anchorRO?.disconnect();
  opener?.focus();
});

const cardSpring = {
  type: "spring",
  stiffness: 300,
  damping: 22,
  mass: 0.9,
} as const;
</script>

<template>
  <Teleport to="body">
    <div
      class="pointer-events-none fixed inset-0 z-50 overflow-hidden"
      :class="[!cardPos.left ? 'flex items-end justify-center pb-24 p-4' : '']"
    >
      <!-- Scrim with plain dimming, no background blur -->
      <UiModalScrim :shown="shown" class="modal-scrim pointer-events-auto absolute inset-0" @click="onCancel" />

      <motion.div
        class="modal-card pointer-events-auto relative z-20 w-80 overflow-hidden"
        :style="{
          height: cardHeight === null ? 'auto' : `${cardHeight}px`,
          maxHeight: maxCardH === null ? undefined : `${maxCardH}px`,
          ...(cardPos.left ? { position: 'absolute', left: cardPos.left, bottom: cardPos.bottom } : {}),
        }"
        :initial="{ opacity: 0, y: 12, scale: 0.96 }"
        :animate="{
          opacity: shown ? 1 : 0,
          y: shown ? 0 : 12,
          scale: shown ? 1 : 0.96,
        }"
        :transition="cardSpring"
        role="dialog"
        aria-modal="true"
        :aria-label="title"
      >
        <div ref="contentEl" class="agent-browser flex shrink-0 flex-col px-3 pb-3">
          <!-- Minimal header band -->
          <div class="picker-header -mx-3 mb-2 flex items-center justify-between gap-4">
            <span class="picker-title">{{ title }}</span>
            <button
              type="button"
              class="picker-action shrink-0 text-muted"
              @click="onCancel"
            >
              Cancel
            </button>
          </div>

          <div class="picker-scroll relative flex max-h-[50vh] w-full flex-col gap-1 overflow-y-auto overflow-x-hidden py-0.5">
            <!-- Solo Mode: Default -->
            <button
              type="button"
              role="menuitemradio"
              :aria-checked="isDefaultSelected"
              class="picker-row"
              :class="{ 'is-current': isDefaultSelected }"
              @click="choose(null)"
            >
            <span class="partner-avatar partner-avatar--flash">
              <HugeiconsIcon :icon="FlashIcon" :size="15" :stroke-width="1.8" />
            </span>
            <span class="picker-label">{{ DEFAULT_PARTNER_LABEL }}</span>
            <span class="partner-role">Solo</span>
            <span v-if="isDefaultSelected" class="partner-check">
              <HugeiconsIcon :icon="Tick02Icon" :size="14" :stroke-width="2.2" />
            </span>
          </button>

          <!-- Jev: not a teammate, and above them rather than among them. It
               answers a different question — who should take this — and it is
               offered in every project, so the team list below it is the set it
               chooses from rather than a list it belongs to. -->
          <button
            type="button"
            role="menuitemradio"
            :aria-checked="isRouterSelected"
            class="picker-row"
            :class="{ 'is-current': isRouterSelected }"
            :title="JEV_DISCLOSURE"
            :aria-label="`${JEV_LABEL}. ${JEV_DISCLOSURE}`"
            @click="choose(JEV_ROUTER_ID)"
          >
            <span class="partner-avatar partner-avatar--router">
              <HugeiconsIcon :icon="Directions01Icon" :size="15" :stroke-width="1.8" />
            </span>
            <span class="picker-label">{{ JEV_LABEL }}</span>
            <!-- The host, not "Routes": this is the one row in the list that
                 sends anything to a service the user has not signed in to, and
                 naming it is the difference between a choice and a surprise. -->
            <span class="partner-role">via {{ JEV_HOST }}</span>
            <span v-if="isRouterSelected" class="partner-check">
              <HugeiconsIcon :icon="Tick02Icon" :size="14" :stroke-width="2.2" />
            </span>
          </button>

          <!-- Teammates -->
          <template v-if="agents.length > 0">
            <button
              v-for="a in agents"
              :key="a.id"
              type="button"
              role="menuitemradio"
              :aria-checked="a.id === activeAgentId"
              class="picker-row"
              :class="{ 'is-current': a.id === activeAgentId }"
              @click="choose(a.id)"
            >
              <RosterFace :agent="a" :size="20" class="partner-face" />
              <span class="picker-label" :title="a.name">{{ a.name }}</span>
              <span v-if="a.role" class="partner-role" :title="a.role">{{ a.role }}</span>
              <span v-if="a.id === activeAgentId" class="partner-check">
                <HugeiconsIcon :icon="Tick02Icon" :size="14" :stroke-width="2.2" />
              </span>
            </button>
          </template>
        </div>
      </div>
    </motion.div>
  </div>
  </Teleport>
</template>

<style scoped>
.modal-scrim {
  background: color-mix(in srgb, var(--ground) 50%, transparent);
}
.modal-card {
  background: var(--panel);
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
  display: flex;
  flex-direction: column;
  justify-content: flex-end;
}

.agent-browser {
  --band-bg: var(--band);
  --band-arc: 14px;
}

/* Recessed header band with arc scoops */
.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(
    circle at bottom right,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}
.picker-header::after {
  right: 0;
  background: radial-gradient(
    circle at bottom left,
    transparent var(--band-arc),
    var(--band-bg) 0
  );
}

.picker-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.picker-action {
  display: inline-flex;
  align-items: center;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  cursor: pointer;
  transition: opacity 0.18s ease;
}
.picker-action:hover {
  opacity: 0.7;
}

/* Clean row without magnets */
.picker-row {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  cursor: pointer;
  border-radius: 10px;
  padding: 0.5rem 0.65rem;
  text-align: left;
  color: var(--ink);
  background: transparent;
  border: 0;
  transition:
    background-color 0.14s ease,
    color 0.14s ease;
}
.picker-row:hover {
  background-color: var(--hover);
}
.picker-row.is-current {
  background-color: var(--hover);
}

.partner-avatar {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex-shrink: 0;
  border-radius: 50%;
  overflow: hidden;
}
/* Clipped to the disc, since the row it sits in is 20px of a list and a face
   that painted a pixel outside it would show as a nick in the column. */
.partner-face {
  overflow: hidden;
}
.partner-avatar--flash {
  color: var(--accent);
}

/* The second accent, not the first: the router sits directly under the default
   row, and two rows wearing the same hue would read as one group of two rather
   than as two different kinds of answer. */
.partner-avatar--router {
  color: var(--accent-2);
}

/* Prioritize name over role for truncation */
.picker-label {
  min-width: 0;
  flex-shrink: 0;
  max-width: 170px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  line-height: 1.2;
}

.partner-role {
  min-width: 0;
  flex-shrink: 1;
  flex-grow: 1;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 11px;
  letter-spacing: 0.01em;
  color: var(--muted);
  opacity: 0.75;
}

.partner-check {
  display: flex;
  align-items: center;
  justify-content: center;
  flex-shrink: 0;
  margin-left: auto;
  color: var(--accent);
}

/* List scrollbar */
.picker-scroll {
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--ink) 16%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 6px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 16%, transparent);
  border-radius: 999px;
  border: 1px solid transparent;
  background-clip: content-box;
}
.picker-scroll:hover::-webkit-scrollbar-thumb {
  background-color: color-mix(in srgb, var(--ink) 30%, transparent);
}
</style>
