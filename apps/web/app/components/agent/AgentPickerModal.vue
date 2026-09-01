<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { FlashIcon, Tick02Icon } from "@hugeicons/core-free-icons";
import { botMark } from "~/utils/bot";
import { DEFAULT_PARTNER_LABEL, type Agent } from "~/utils/agents";
import { useModalExit } from "~/composables/useModalExit";
import { useSound } from "~/composables/useSound";

const props = withDefaults(
  defineProps<{
    agents: Agent[];
    activeAgentId?: string | null;
    title?: string;
  }>(),
  {
    activeAgentId: null,
    title: "Partner",
  },
);

const emit = defineEmits<{
  select: [id: string | null];
  cancel: [];
}>();

const { cue } = useSound();

const isDefaultSelected = computed(() => !props.activeAgentId);

function choose(id: string | null) {
  cue("select");
  close(() => emit("select", id));
}

// ── modal surface & transitions ──────────────────────────────────────────────
const { shown, closing, close } = useModalExit();
const contentEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

function syncHeight() {
  const el = contentEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function onCancel() {
  close(() => emit("cancel"));
}

function onKeydown(e: KeyboardEvent) {
  if (e.key === "Escape") {
    e.preventDefault();
    onCancel();
  }
}

let opener: HTMLElement | null = null;

onMounted(async () => {
  // SAFETY: activeElement is the element focused just before open; null is allowed by the type.
  opener = document.activeElement as HTMLElement | null;
  window.addEventListener("keydown", onKeydown);
  window.addEventListener("resize", syncHeight);

  await nextTick();
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (contentEl.value) ro.observe(contentEl.value);
  requestAnimationFrame(() => {
    shown.value = true;
  });
});

onBeforeUnmount(() => {
  window.removeEventListener("keydown", onKeydown);
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
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
  <div class="fixed inset-0 z-50 flex items-end justify-center pb-24 p-4 overflow-hidden">
    <!-- Scrim with plain dimming, no background blur -->
    <motion.div
      class="modal-scrim absolute inset-0"
      :initial="{ opacity: 0 }"
      :animate="{ opacity: shown ? 1 : 0 }"
      :transition="{ duration: 0.2, ease: [0.22, 1, 0.36, 1] }"
      @click="onCancel"
    />

    <motion.div
      class="modal-card relative z-20 w-80 overflow-hidden"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
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
              <span
                class="partner-avatar"
                aria-hidden="true"
                v-html="a.bot ? botMark(a.bot) : a.svg"
              />
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
  border-radius: 6px;
}
.partner-avatar :deep(svg) {
  width: 100%;
  height: 100%;
  overflow: visible;
}
.partner-avatar--flash {
  color: var(--accent);
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
