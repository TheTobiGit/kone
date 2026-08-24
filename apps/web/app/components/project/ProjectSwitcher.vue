<script setup lang="ts">
import { computed, watch } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowRight01Icon } from "@hugeicons/core-free-icons";
import type { RecentProject } from "~/composables/useRecentProjects";

// The in-project switcher: the other projects you've opened, as small live
// folders that rise into view — from the greeting (click) or the corner folder
// (hover). Picking one swaps the active project; "All projects" backs out to the
// launcher. It's the same physical folder object used everywhere else, just
// scaled down, so switching reads as reaching for another folder on the desk —
// not opening a menu.

const props = defineProps<{
  projects: RecentProject[];
}>();

const emit = defineEmits<{
  switch: [project: RecentProject];
  all: [];
}>();

// Show a healthy handful inline; the rest live one click away in All projects,
// so the panel never grows into a scrolling wall of folders.
const CAP = 6;
const shown = computed(() => props.projects.slice(0, CAP));
const overflow = computed(() => Math.max(0, props.projects.length - CAP));

// Real git for each folder — same summaries the launcher grid draws, so the
// peeking papers, branch and ± are live, not placeholders.
const { summaries, subscribe } = useProjectSummaries();
subscribe(() => shown.value.map((p) => p.path));
</script>

<template>
  <motion.div
    class="switcher"
    role="menu"
    aria-label="Switch project"
    :initial="{ opacity: 0, y: -10, scale: 0.97 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: -10, scale: 0.97 }"
    :transition="{ type: 'spring', stiffness: 460, damping: 32, mass: 0.7 }"
  >
    <!-- Head: the way back to the launcher, tucked top-right with an arrow. -->
    <div class="switcher__head">
      <button type="button" role="menuitem" class="switcher__all" @click="emit('all')">
        <span>All projects</span>
        <span v-if="overflow" class="switcher__more">+{{ overflow }}</span>
        <HugeiconsIcon
          :icon="ArrowRight01Icon"
          :size="15"
          :stroke-width="2.2"
          aria-hidden="true"
        />
      </button>
    </div>

    <!-- The other folders — a compact two-up shelf that staggers in. -->
    <div v-if="shown.length" class="switcher__grid">
      <motion.button
        v-for="(p, i) in shown"
        :key="p.path"
        type="button"
        role="menuitem"
        class="mf"
        :title="p.path"
        :initial="{ opacity: 0, y: 8, scale: 0.96 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :transition="{
          type: 'spring',
          stiffness: 420,
          damping: 20,
          mass: 0.7,
          delay: i * 0.04,
        }"
        :while-hover="{ y: -4 }"
        :while-tap="{ y: -2, scale: 0.98 }"
        @click="emit('switch', p)"
      >
        <ProjectFolder
          :name="p.name"
          :repo="summaries[p.path]?.repo ?? true"
          :branch="summaries[p.path]?.branch ?? null"
          :added="summaries[p.path]?.added ?? 0"
          :removed="summaries[p.path]?.removed ?? 0"
          :files="summaries[p.path]?.files ?? []"
          :scale="0.62"
          :hovered="false"
        />
      </motion.button>
    </div>

    <!-- No other projects yet — All projects (top-right) is still the way out. -->
    <p v-else class="switcher__empty">No other projects open</p>
  </motion.div>
</template>

<style scoped>
.switcher {
  /* A quiet floating surface — no border, only a soft low lift and a faint
     backdrop so the folders behind read as pushed back, not boxed. */
  width: max-content;
  max-width: 300px;
  padding: 12px 12px 8px;
  border-radius: 20px;
  background-color: color-mix(in srgb, var(--ground) 86%, transparent);
  -webkit-backdrop-filter: blur(16px) saturate(1.4);
  backdrop-filter: blur(16px) saturate(1.4);
  box-shadow:
    0 1px 0 color-mix(in srgb, var(--ink) 5%, transparent) inset,
    0 16px 40px -18px rgb(0 0 0 / 0.32);
}

.switcher__head {
  display: flex;
  justify-content: flex-end;
  margin: 0 0 8px;
}

.switcher__grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 6px 10px;
}

/* Each folder is the whole hit target — borderless, no backing plate; it just
   lifts on hover (driven by motion). Keyboard focus still rings for a11y. */
.mf {
  display: block;
  padding: 4px;
  border-radius: 14px;
  cursor: pointer;
}
.mf:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}

.switcher__empty {
  margin: 6px 4px 12px;
  font-family: var(--font-mono);
  font-size: 11px;
  letter-spacing: 0.02em;
  color: var(--muted);
}

.switcher__all {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 5px 7px 5px 9px;
  border-radius: 9px;
  font-family: var(--font-sans);
  font-size: 12.5px;
  font-weight: 500;
  color: var(--muted);
  cursor: pointer;
  transition:
    color 0.2s ease,
    background-color 0.2s ease;
}
.switcher__all:hover,
.switcher__all:focus-visible {
  color: var(--ink);
  outline: none;
}
/* The arrow nudges toward the launcher on hover — the only motion it needs. */
.switcher__all :deep(svg) {
  transition: transform 0.2s ease;
}
.switcher__all:hover :deep(svg) {
  transform: translateX(2px);
}
.switcher__all:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 26%, transparent);
  outline-offset: 1px;
}
.switcher__more {
  font-family: var(--font-mono);
  font-size: 10px;
  color: var(--muted);
}

@media (prefers-reduced-motion: reduce) {
  .switcher,
  .mf {
    transition: none;
  }
}
</style>
