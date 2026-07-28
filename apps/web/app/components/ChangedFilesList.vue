<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import { motion, AnimatePresence } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import FileIcon from "~/components/FileIcon.vue";
import type { ChangedFile } from "~/utils/changedFiles";

// The corner "Changes" dock — a sibling of the Tasks dock (PlanTaskList) in the
// same folder-picker shell, docked bottom-right while a turn works the tree. It
// lists every file the agent has created, edited, or removed this thread: the
// real file-type logo, the filename, and its +added / −removed diffstat, with
// the aggregate +/− in the header — the same diff vocabulary the change cards
// use. Purely presentational: it renders the reduced list from deriveChangedFiles.

const props = defineProps<{
  files: ChangedFile[];
  /** Aggregate +/− across all files — shown in the header. */
  totalAdded?: number;
  totalRemoved?: number;
  /** A file write is still in flight — keeps the dock open. */
  streaming?: boolean;
}>();

const { cue } = useSound();

const expanded = ref(true);
const shellEl = ref<HTMLElement | null>(null);
const cardHeight = ref<number | null>(null);
let ro: ResizeObserver | null = null;

const totalAdded = computed(() => props.totalAdded ?? 0);
const totalRemoved = computed(() => props.totalRemoved ?? 0);
const hasTotals = computed(() => totalAdded.value > 0 || totalRemoved.value > 0);

const liveFile = computed(() => props.files.find((f) => f.streaming));

function syncHeight(): void {
  const el = shellEl.value;
  if (el) cardHeight.value = el.offsetHeight;
}

function toggle(): void {
  expanded.value = !expanded.value;
  cue("toggle");
}

// A live write opens the body; from there it stays open until the user collapses
// it — the list of what changed outlives the turn, so we never auto-close it.
watch(
  () => props.streaming,
  (live, was) => {
    if (live && !was) expanded.value = true;
  },
);

watch([expanded, () => props.files], () => {
  void nextTick(syncHeight);
});

onMounted(() => {
  syncHeight();
  ro = new ResizeObserver(syncHeight);
  if (shellEl.value) ro.observe(shellEl.value);
  window.addEventListener("resize", syncHeight);
});

onBeforeUnmount(() => {
  window.removeEventListener("resize", syncHeight);
  ro?.disconnect();
});

const cardSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;
const rowSpring = { type: "spring", stiffness: 460, damping: 24, mass: 0.65 } as const;
const fadeEase = [0.22, 1, 0.36, 1] as const;
const chevSpring = { type: "spring", stiffness: 520, damping: 30, mass: 0.45 } as const;

function rowDelay(index: number): number {
  return Math.min(index * 0.045, 0.28);
}

// A created file with no counted lines yet reads as "new" rather than an empty
// diffstat — mirrors the change card's quiet marker.
function isEmptyNew(file: ChangedFile): boolean {
  return file.kind === "created" && file.added === 0 && file.removed === 0;
}
</script>

<template>
  <motion.div
    class="chg-dock"
    :style="{ transformOrigin: '100% 100%' }"
    :initial="{ opacity: 0, y: 16, scale: 0.94 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 12, scale: 0.95 }"
    :transition="cardSpring"
    aria-label="Changed files"
  >
    <div
      class="plan-card"
      :class="{ 'plan-card--collapsed': !expanded }"
      :style="{ height: cardHeight === null ? 'auto' : `${cardHeight}px` }"
    >
      <div ref="shellEl" class="plan-shell" :class="{ 'plan-shell--collapsed': !expanded }">
        <button
          type="button"
          class="picker-header plan-header"
          :aria-expanded="expanded"
          @click="toggle"
        >
          <span class="plan-title">Changes</span>
          <span class="plan-header__trail">
            <AnimatePresence mode="wait">
              <motion.span
                v-if="!expanded && liveFile"
                :key="liveFile.id"
                class="plan-peek"
                :title="liveFile.path"
                :initial="{ opacity: 0, x: 8, filter: 'blur(4px)' }"
                :animate="{ opacity: 1, x: 0, filter: 'blur(0px)' }"
                :exit="{ opacity: 0, x: -6, filter: 'blur(3px)' }"
                :transition="{ duration: 0.22, ease: fadeEase }"
              >
                {{ liveFile.name }}
              </motion.span>
            </AnimatePresence>
            <span class="chg-total" :class="{ 'chg-total--muted': !hasTotals }">
              <template v-if="hasTotals">
                <span v-if="totalAdded > 0" class="chg-add">+{{ totalAdded }}</span>
                <span v-if="totalRemoved > 0" class="chg-del">−{{ totalRemoved }}</span>
              </template>
              <span v-else>{{ streaming ? "…" : files.length }}</span>
            </span>
            <motion.span
              class="plan-chev"
              :animate="{ rotate: expanded ? 90 : 0 }"
              :transition="chevSpring"
              aria-hidden="true"
            >
              <HugeiconsIcon :icon="ArrowRight01Icon" :size="14" :stroke-width="2" />
            </motion.span>
          </span>
        </button>

        <div class="plan-body" :class="{ 'plan-body--open': expanded }">
          <div class="plan-body-inner">
            <div class="picker-scroll plan-scroll">
              <AnimatePresence mode="wait">
                <motion.p
                  v-if="!props.files.length"
                  key="empty"
                  class="plan-empty"
                  :initial="{ opacity: 0, y: 6 }"
                  :animate="{ opacity: 1, y: 0 }"
                  :exit="{ opacity: 0, y: -4 }"
                  :transition="{ duration: 0.2, ease: fadeEase }"
                >
                  {{ streaming ? "Working…" : "No changes" }}
                </motion.p>
              </AnimatePresence>

              <AnimatePresence :initial="false">
                <motion.div
                  v-for="(file, index) in props.files"
                  :key="file.id"
                  class="chg-row"
                  :class="{ 'chg-row--removed': file.kind === 'removed' }"
                  layout
                  :initial="{ opacity: 0, y: 8, scale: 0.98 }"
                  :animate="{ opacity: 1, y: 0, scale: 1 }"
                  :exit="{ opacity: 0, y: -6, scale: 0.98 }"
                  :transition="{ ...rowSpring, delay: rowDelay(index) }"
                >
                  <span class="chg-icon" aria-hidden="true">
                    <FileIcon :path="file.name" :size="16" />
                  </span>
                  <span class="chg-name" :title="file.path">{{ file.name }}</span>
                  <span class="chg-stat">
                    <span v-if="file.kind === 'removed' && !file.removed" class="chg-tag">removed</span>
                    <span v-else-if="isEmptyNew(file)" class="chg-tag">new</span>
                    <template v-else>
                      <span v-if="file.added > 0" class="chg-add">+{{ file.added }}</span>
                      <span v-if="file.removed > 0" class="chg-del">−{{ file.removed }}</span>
                    </template>
                  </span>
                </motion.div>
              </AnimatePresence>
            </div>
          </div>
        </div>
      </div>
    </div>
  </motion.div>
</template>

<style scoped>
/* Shares the Tasks dock's folder-picker shell (plan-card / plan-shell /
   picker-header / plan-body) so the two corner docks read as one family — only
   the row content differs. */
.chg-dock {
  width: min(17rem, calc(100vw - 2.5rem));
  pointer-events: auto;
  will-change: transform, opacity;
}

.plan-card {
  background: var(--surface, var(--ground));
  border-radius: 18px;
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent);
  overflow: hidden;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}

.plan-shell {
  --band-bg: color-mix(in srgb, var(--ink) 2%, var(--surface, var(--ground)));
  --band-arc: 14px;
  padding: 0 0 0.75rem 0.75rem;
  transition: padding-bottom 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.plan-shell--collapsed {
  padding-bottom: 0;
}

.plan-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  width: calc(100% + 0.75rem);
  margin: 0 0 0 -0.75rem;
  border: 0;
  cursor: pointer;
  text-align: left;
  color: inherit;
  transition: opacity 0.18s ease;
}
.plan-header:hover {
  opacity: 0.88;
}

.plan-title {
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.plan-header__trail {
  display: inline-flex;
  align-items: center;
  gap: 0.5rem;
  min-width: 0;
  padding-right: 0.75rem;
}

.plan-peek {
  display: block;
  min-width: 0;
  max-width: 6.5rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

/* Header diffstat — the aggregate +/− (or a plain count until anything's
   measured), in the same mono/tabular treatment as the change cards. */
.chg-total {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
  letter-spacing: 0.02em;
}
.chg-total--muted {
  color: var(--muted);
}

.plan-chev {
  display: inline-flex;
  flex: none;
  opacity: 0.45;
}

.picker-header {
  position: relative;
  padding: 0.625rem 1rem;
  background-color: var(--band-bg);
}
.plan-card--collapsed .picker-header::before,
.plan-card--collapsed .picker-header::after {
  opacity: 0;
}
.picker-header::before,
.picker-header::after {
  content: "";
  position: absolute;
  width: var(--band-arc);
  height: var(--band-arc);
  top: 100%;
  pointer-events: none;
  transition: opacity 0.14s ease;
}
.picker-header::before {
  left: 0;
  background: radial-gradient(circle at bottom right, transparent var(--band-arc), var(--band-bg) 0);
}
.picker-header::after {
  right: 0;
  background: radial-gradient(circle at bottom left, transparent var(--band-arc), var(--band-bg) 0);
}

.plan-body {
  display: grid;
  grid-template-rows: 0fr;
  transition: grid-template-rows 0.2s cubic-bezier(0.22, 1, 0.36, 1);
}
.plan-body--open {
  grid-template-rows: 1fr;
}
.plan-body-inner {
  overflow: hidden;
  min-height: 0;
}

.plan-scroll {
  /* Grow to fit the changed-files list; only scroll once it would run off-screen. */
  max-height: min(28rem, calc(100vh - 8rem));
}

.picker-scroll {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  overflow-y: auto;
  overflow-x: hidden;
  padding: 0.125rem 0.75rem 0.125rem 0;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--muted) 40%, transparent) transparent;
}
.picker-scroll::-webkit-scrollbar {
  width: 6px;
}
.picker-scroll::-webkit-scrollbar-track {
  background: transparent;
}
.picker-scroll::-webkit-scrollbar-thumb {
  border-radius: 999px;
  background: color-mix(in srgb, var(--muted) 35%, transparent);
}

.chg-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.5rem;
  border-radius: 10px;
}

.chg-icon {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 16px;
  height: 16px;
}

.chg-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
}

.chg-row--removed .chg-name {
  color: var(--muted);
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--muted) 70%, transparent);
}

.chg-stat {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  flex: none;
  font-family: var(--font-mono);
  font-size: 11px;
  line-height: 1;
  font-variant-numeric: tabular-nums;
}

.chg-add {
  color: var(--diff-add);
}
.chg-del {
  color: var(--diff-del);
}

.chg-tag {
  font-size: 10px;
  letter-spacing: 0.3px;
  color: var(--muted);
}

.plan-empty {
  margin: 0;
  padding: 0.35rem 0.5rem;
  font-size: 13px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .plan-card,
  .plan-shell,
  .plan-body,
  .picker-header::before,
  .picker-header::after {
    transition: none;
  }
  .chg-dock {
    will-change: auto;
  }
}
</style>
