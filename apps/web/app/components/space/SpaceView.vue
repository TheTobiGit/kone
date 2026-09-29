<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch,
  type ComponentPublicInstance,
} from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  FolderOpenIcon,
  Copy01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";
import type { Project } from "~/composables/useProject";
import { useSpaceUsage } from "~/composables/useSpaceUsage";
import { useSpaceInstructions } from "~/composables/useSpaceInstructions";
import { useSound } from "~/composables/useSound";
import SpaceSectionHeader from "./SpaceSectionHeader.vue";
import SpaceActivityCard from "./SpaceActivityCard.vue";
import SpaceSpendCard from "./SpaceSpendCard.vue";
import SpaceModelsCard from "./SpaceModelsCard.vue";
import SpaceInstructionsCard from "./SpaceInstructionsCard.vue";

const props = defineProps<{
  project: Project;
  /** This tab is the one on screen. Re-reads wait until it is. */
  visible: boolean;
}>();

const { cue } = useSound();

const usage = useSpaceUsage(
  () => props.project.path,
  () => props.visible,
);

const instructions = useSpaceInstructions(
  () => props.project.path,
  () => props.visible,
);

type SectionId = "telemetry" | "agents" | "claude";

const sections: Array<{ id: SectionId; label: string }> = [
  { id: "telemetry", label: "Telemetry" },
  { id: "agents", label: "AGENTS.md" },
  { id: "claude", label: "CLAUDE.md" },
];

const activeSection = ref<SectionId>("telemetry");
const activeIndex = computed(() => {
  const idx = sections.findIndex((s) => s.id === activeSection.value);
  return idx >= 0 ? idx : 0;
});
const trackEl = ref<HTMLElement | null>(null);
const sectionRefs = ref<Record<string, HTMLElement | null>>({});

const copiedSection = ref<string | null>(null);
let copyTimer: ReturnType<typeof setTimeout> | null = null;

async function copyText(text: string | null, sectionId: string): Promise<void> {
  if (!text) return;
  try {
    await navigator.clipboard.writeText(text);
    cue("press");
    copiedSection.value = sectionId;
    if (copyTimer) clearTimeout(copyTimer);
    copyTimer = setTimeout(() => {
      copiedSection.value = null;
    }, 2000);
  } catch {
    // Clipboard permission refused
  }
}

function setSectionRef(id: string, el: Element | ComponentPublicInstance | null) {
  if (el instanceof HTMLElement) {
    sectionRefs.value[id] = el;
  } else {
    sectionRefs.value[id] = null;
  }
}

function scrollToSection(id: SectionId): void {
  if (activeSection.value !== id) {
    cue("toggle");
  }
  activeSection.value = id;
  const track = trackEl.value;
  const target = sectionRefs.value[id];
  if (target && track) {
    // offsetLeft is track-relative because .sp__track is positioned, so this
    // lands the column's leading edge exactly on the track's left padding
    // (scroll-padding handles the inset) without touching vertical scroll.
    const pad = Number.parseFloat(getComputedStyle(track).paddingLeft) || 0;
    const reduceMotion =
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
    track.scrollTo({
      left: target.offsetLeft - pad,
      behavior: reduceMotion ? "auto" : "smooth",
    });
  }
}

// Translate vertical mouse wheel scrolling into horizontal scrolling across the sections
function onWheel(event: WheelEvent): void {
  const track = trackEl.value;
  if (!track) return;
  // Pinch-zoom / horizontal trackpad gestures keep native behaviour.
  if (event.ctrlKey || event.metaKey) return;
  if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
  const target = event.target;
  if (target instanceof HTMLElement) {
    // A vertical scrollable under the cursor keeps the gesture while it has
    // room; only the exhausted gesture travels sideways. The activity grid
    // also scrolls sideways when stacked, so it keeps horizontal deltas.
    const verticalChild = target.closest(".inst__body-wrap, .sp__telemetry-stack");
    if (verticalChild instanceof HTMLElement) {
      const canScrollUp = verticalChild.scrollTop > 0 && event.deltaY < 0;
      const canScrollDown =
        verticalChild.scrollTop + verticalChild.clientHeight < verticalChild.scrollHeight &&
        event.deltaY > 0;
      if (canScrollUp || canScrollDown) {
        return;
      }
    }
    const horizontalChild = target.closest(".act__main.is-stacked > .act__wrap");
    if (horizontalChild instanceof HTMLElement) {
      const canScrollLeft = horizontalChild.scrollLeft > 0;
      const canScrollRight =
        horizontalChild.scrollLeft + horizontalChild.clientWidth < horizontalChild.scrollWidth;
      if (canScrollLeft || canScrollRight) return;
    }
  }
  event.preventDefault();
  track.scrollLeft += event.deltaY;
}

let observer: IntersectionObserver | null = null;

function setupObserver(): void {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (!import.meta.client || !("IntersectionObserver" in window) || !trackEl.value) {
    return;
  }

  // The last ratio per column, so the most-visible column wins even when
  // the observer batches only the entries that changed this tick.
  const ratios = new Map<Element, number>();
  observer = new IntersectionObserver(
    (entries) => {
      // Several columns can clear the threshold at once on a wide viewport,
      // so the most-visible one wins rather than the last callback entry.
      for (const entry of entries) {
        ratios.set(entry.target, entry.isIntersecting ? entry.intersectionRatio : 0);
      }
      let bestId: string | null = null;
      let bestRatio = 0;
      for (const [el, ratio] of ratios) {
        if (ratio >= 0.35 && ratio > bestRatio) {
          bestRatio = ratio;
          bestId = el.getAttribute("data-section-id");
        }
      }
      if (bestId === "telemetry" || bestId === "agents" || bestId === "claude") {
        activeSection.value = bestId;
      }
    },
    {
      root: trackEl.value,
      threshold: [0.35, 0.6],
    },
  );

  for (const id of ["telemetry", "agents", "claude"]) {
    const el = sectionRefs.value[id];
    if (el) observer.observe(el);
  }
}

watch(
  () => props.visible,
  (vis) => {
    if (vis) {
      void nextTick(setupObserver);
    }
  },
);

onMounted(() => {
  void nextTick(setupObserver);
});

onBeforeUnmount(() => {
  if (observer) {
    observer.disconnect();
    observer = null;
  }
  if (copyTimer) clearTimeout(copyTimer);
});
</script>

<template>
  <div class="sp">
    <!-- Horizontal Sub-Nav positioned directly under Project Nav -->
    <nav class="sp__subnav" aria-label="Space sections">
      <i class="sp__subnav-mark" :style="{ '--at': activeIndex }" aria-hidden="true" />
      <button
        v-for="s in sections"
        :key="s.id"
        type="button"
        class="sp__subnav-btn"
        :class="{ 'is-active': activeSection === s.id }"
        :aria-current="activeSection === s.id ? 'page' : undefined"
        @click="scrollToSection(s.id)"
      >
        {{ s.label }}
      </button>
    </nav>

    <!-- Main Horizontal Track with Section Columns -->
    <main ref="trackEl" class="sp__track" @wheel="onWheel">
      <!-- Section 1: Telemetry -->
      <section
        :ref="(el) => setSectionRef('telemetry', el)"
        data-section-id="telemetry"
        class="sp__column sp__column--telemetry"
        aria-label="Telemetry"
      >
        <SpaceSectionHeader title="Telemetry" />
        <div class="sp__telemetry-stack">
          <SpaceActivityCard :usage="usage" />
          <div class="sp__telemetry-grid">
            <SpaceSpendCard :usage="usage" />
            <SpaceModelsCard :usage="usage" />
          </div>
        </div>
      </section>

      <!-- Section 2: AGENTS.md -->
      <section
        :ref="(el) => setSectionRef('agents', el)"
        data-section-id="agents"
        class="sp__column sp__column--instructions"
        aria-label="AGENTS.md"
      >
        <SpaceSectionHeader title="AGENTS.md">
          <template #aside>
            <div v-if="instructions.agents.value.detected" class="sp__head-actions">
              <span class="sp__head-lines">{{ instructions.agents.value.lines }} lines</span>
              <button
                type="button"
                class="sp__head-btn"
                title="Reveal file in Finder"
                @click="instructions.reveal(instructions.agents.value.path)"
              >
                <HugeiconsIcon :icon="FolderOpenIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                <span class="sr-only">Reveal file</span>
              </button>
              <button
                type="button"
                class="sp__head-btn"
                :title="copiedSection === 'agents' ? 'Copied' : 'Copy contents'"
                @click="copyText(instructions.agents.value.text, 'agents')"
              >
                <HugeiconsIcon
                  :icon="copiedSection === 'agents' ? Tick02Icon : Copy01Icon"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ copiedSection === 'agents' ? 'Copied' : 'Copy' }}</span>
              </button>
            </div>
          </template>
        </SpaceSectionHeader>
        <SpaceInstructionsCard
          :info="instructions.agents.value"
          @create="instructions.createAgentsMd"
        />
      </section>

      <!-- Section 3: CLAUDE.md -->
      <section
        :ref="(el) => setSectionRef('claude', el)"
        data-section-id="claude"
        class="sp__column sp__column--instructions"
        aria-label="CLAUDE.md"
      >
        <SpaceSectionHeader title="CLAUDE.md">
          <template #aside>
            <div v-if="instructions.claude.value.detected" class="sp__head-actions">
              <span class="sp__head-lines">{{ instructions.claude.value.lines }} lines</span>
              <button
                type="button"
                class="sp__head-btn"
                title="Reveal file in Finder"
                @click="instructions.reveal(instructions.claude.value.path)"
              >
                <HugeiconsIcon :icon="FolderOpenIcon" :size="13" :stroke-width="1.8" aria-hidden="true" />
                <span class="sr-only">Reveal file</span>
              </button>
              <button
                type="button"
                class="sp__head-btn"
                :title="copiedSection === 'claude' ? 'Copied' : 'Copy contents'"
                @click="copyText(instructions.claude.value.text, 'claude')"
              >
                <HugeiconsIcon
                  :icon="copiedSection === 'claude' ? Tick02Icon : Copy01Icon"
                  :size="13"
                  :stroke-width="1.8"
                  aria-hidden="true"
                />
                <span class="sr-only">{{ copiedSection === 'claude' ? 'Copied' : 'Copy' }}</span>
              </button>
            </div>
          </template>
        </SpaceSectionHeader>
        <SpaceInstructionsCard
          :info="instructions.claude.value"
          @create="instructions.createClaudeMd"
        />
      </section>
    </main>
  </div>
</template>

<style scoped>
.sp {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  min-height: 0;
  overflow: hidden;
  background-color: var(--ground);
}

/* Horizontal Sub-Navigation under Project Nav */
.sp__subnav {
  position: absolute;
  top: 3.75rem;
  left: 50%;
  transform: translateX(-50%);
  display: inline-flex;
  align-items: center;
  z-index: 30;
  padding: 2px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ground) 80%, transparent);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  animation: sp-subnav-in 0.42s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}

.sp__subnav-mark {
  position: absolute;
  top: 2px;
  bottom: 2px;
  left: 2px;
  width: 96px;
  border-radius: 999px;
  background-color: color-mix(in srgb, var(--ink) 6.5%, transparent);
  transform: translateX(calc(var(--at, 0) * 96px));
  transition: transform 0.38s cubic-bezier(0.22, 1, 0.36, 1);
  pointer-events: none;
}

.sp__subnav-btn {
  position: relative;
  z-index: 1;
  width: 96px;
  padding: 5px 0;
  border-radius: 999px;
  border: none;
  background: transparent;
  font-size: 12px;
  letter-spacing: -0.1px;
  text-align: center;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.25s ease;
  user-select: none;
}
.sp__subnav-btn:hover:not(.is-active) {
  color: var(--ink-soft);
}
.sp__subnav-btn:focus-visible {
  outline: none;
  color: var(--ink);
}
.sp__subnav-btn.is-active {
  color: var(--ink);
  font-weight: 500;
}

/* Horizontal Track */
.sp__track {
  position: relative;
  width: 100%;
  height: 100%;
  overflow-x: auto;
  overflow-y: hidden;
  display: flex;
  flex-direction: row;
  gap: 32px;
  padding: 6.5rem 3rem 2.5rem 3rem;
  scroll-padding-left: 3rem;
  /* Instant for wheel-driven camera moves (smooth would queue an animation
     per tick and lag); section jumps scroll smoothly via scrollTo instead. */
  scroll-behavior: auto;
  scroll-snap-type: x proximity;
  box-sizing: border-box;
  overscroll-behavior-x: contain;
}

/* Section Columns */
.sp__column {
  display: flex;
  flex-direction: column;
  gap: 12px;
  flex-shrink: 0;
  height: 100%;
  min-height: 0;
  scroll-snap-align: start;
}

.sp__column--telemetry {
  width: min(820px, 86vw);
  animation: sp-col-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: 0ms;
}

.sp__column--instructions {
  width: min(520px, 78vw);
}
.sp__column--instructions > :last-child {
  flex: 1;
  min-height: 0;
}

.sp__column:nth-child(2) {
  animation: sp-col-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: 80ms;
}
.sp__column:nth-child(3) {
  animation: sp-col-in 0.4s cubic-bezier(0.16, 1, 0.3, 1) backwards;
  animation-delay: 160ms;
}

.sp__telemetry-stack {
  display: flex;
  flex-direction: column;
  gap: 12px;
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding-right: 4px;
}
.sp__telemetry-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(330px, 1fr));
  gap: 12px;
}

.sp__head-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.sp__head-lines {
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.sp__head-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  border-radius: 6px;
  color: var(--muted);
  cursor: pointer;
  background-color: transparent;
  transition:
    color 0.15s ease,
    background-color 0.15s ease;
}
.sp__head-btn:hover {
  color: var(--ink);
  background-color: var(--hover);
}

@keyframes sp-subnav-in {
  from {
    opacity: 0;
    transform: translate(-50%, -6px);
  }
  to {
    opacity: 1;
    transform: translate(-50%, 0);
  }
}

@keyframes sp-col-in {
  from {
    opacity: 0;
    transform: translateY(10px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

@media (prefers-reduced-motion: reduce) {
  .sp__subnav,
  .sp__column {
    animation: none;
  }
  .sp__subnav-mark {
    transition: none;
  }
  .sp__track {
    scroll-behavior: auto;
  }
}
</style>
