<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { motion } from "motion-v";

// The Ctrl+Tab HUD: a held app-switcher, not a click-to-toggle menu. It only
// exists while Ctrl is down — ProjectView mounts it on the first Tab and tears
// it down the instant Ctrl comes back up, so it never has to manage its own
// open/closed state. It's a dock, not a modal: a full-width shelf on the same
// ground as the rest of the app (no glass, no border), holding the real,
// full-size, detailed folders — same object the launcher and switcher use —
// so the current one reads as bigger and lifted, not just labeled.

type CycleEntry = { path: string; name: string; isSelf: boolean };

const props = defineProps<{
  entries: CycleEntry[];
  selectedIndex: number;
}>();

// Real git detail for each folder in the dock — same cache the launcher grid
// and in-project switcher already warm, so this is a cache hit, not more git.
const { summaries, subscribe } = useProjectSummaries();
subscribe(() => props.entries.map((e) => e.path));

// Springy pop for the whole dock's entrance (mirrors the clone/create card).
const dockSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

// `layout` catches the resize+reflow FLIP-style as the selected folder grows
// and pushes its neighbours — standing in for ProjectFolder's un-transitioned
// :scale prop. Damping ratio ~0.5 here (vs ~0.67 on the dock spring above) so
// the step overshoots and settles rather than gliding straight to rest.
const cellSpring = { type: "spring", stiffness: 300, damping: 15, mass: 0.9 } as const;
// Opacity doesn't want to overshoot — a bounce there reads as flicker, not
// life — so it gets a plain eased crossfade instead.
const cellFade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;
const cellMove = {
  layout: cellSpring,
  y: cellSpring,
  opacity: cellFade,
} as const;

// The dock scrolls when the list overflows, but it's driven by the keyboard,
// not a mouse — a scrollbar would just be visual noise. Instead the selected
// cell scrolls itself into view as the index moves, so cycling past the edge
// of the shelf brings the next folder into frame automatically.
const cellRefs = ref<(HTMLElement | null)[]>([]);
function setCellRef(el: unknown, i: number) {
  // The ref sits on a <motion.div> (a component), so a template ref hands back
  // the component instance, not the DOM node — reach through `$el` to the real
  // element (plain elements pass straight through) so scrollIntoView exists.
  const node = (el as { $el?: unknown } | null)?.$el ?? el;
  cellRefs.value[i] = node instanceof HTMLElement ? node : null;
}
watch(
  () => props.selectedIndex,
  (i) => {
    void nextTick(() => {
      cellRefs.value[i]?.scrollIntoView({ behavior: "smooth", inline: "nearest", block: "nearest" });
    });
  },
  { immediate: true },
);
</script>

<template>
  <motion.div
    class="cycle-dock"
    :initial="{ opacity: 0, y: 28 }"
    :animate="{ opacity: 1, y: 0 }"
    :exit="{ opacity: 0, y: 20 }"
    :transition="dockSpring"
  >
    <div class="cycle-dock__row">
      <motion.div
        v-for="(entry, i) in props.entries"
        :key="entry.path"
        :ref="(el) => setCellRef(el as Element | null, i)"
        layout
        class="cell"
        :initial="{ opacity: 0, y: 14 }"
        :animate="{
          opacity: i === props.selectedIndex ? 1 : 0.55,
          y: i === props.selectedIndex ? -10 : 0,
        }"
        :transition="{ ...cellMove, opacity: { ...cellFade, delay: i * 0.03 } }"
      >
        <ProjectFolder
          :name="entry.name"
          :repo="summaries[entry.path]?.repo ?? true"
          :branch="summaries[entry.path]?.branch ?? null"
          :added="summaries[entry.path]?.added ?? 0"
          :removed="summaries[entry.path]?.removed ?? 0"
          :files="summaries[entry.path]?.files ?? []"
          :scale="i === props.selectedIndex ? 1.1 : 0.86"
          :hovered="i === props.selectedIndex"
        />
      </motion.div>
    </div>
  </motion.div>
</template>

<style scoped>
.cycle-dock {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 70;
  display: flex;
  justify-content: center;
  padding: 0 64px 44px;
  /* Same ground as the rest of the app — a shelf, not a floating card. */
  background-color: var(--ground);
  pointer-events: none;
}

.cycle-dock__row {
  display: flex;
  align-items: flex-end;
  gap: 40px;
  max-width: 100%;
  /* Setting overflow-x here forces overflow-y to compute as "auto" too (a CSS
     quirk), which would otherwise clip the selected folder's papers as they
     fan up above its box. The padding-top gives that fan-out headroom before
     the auto-clip boundary, instead of cutting it off. */
  padding-top: 96px;
  overflow-x: auto;
  overflow-y: visible;
  scrollbar-width: none;
}
.cycle-dock__row::-webkit-scrollbar {
  display: none;
}

.cell {
  flex-shrink: 0;
}
</style>
