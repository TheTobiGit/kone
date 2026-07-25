<script setup lang="ts">
import { nextTick, ref, watch } from "vue";
import { motion } from "motion-v";

// The Ctrl+Tab HUD: a held app-switcher, not a click-to-toggle menu. It only
// exists while Ctrl is down — ProjectView mounts it on the first Tab and tears
// it down the instant Ctrl comes back up, so it never has to manage its own
// open/closed state. The selected folder reads as current through scale and
// clarity alone — bigger and sharp, the rest smaller, dimmer, softer — and
// every step between them is a real spring, not a snap.

type CycleEntry = { path: string; name: string; isSelf: boolean };

const props = defineProps<{
  entries: CycleEntry[];
  selectedIndex: number;
}>();

// Springy pop for the whole HUD's entrance (mirrors the clone/create card).
const panelSpring = { type: "spring", stiffness: 300, damping: 22, mass: 0.9 } as const;

// `layout` catches the resize+reflow FLIP-style as the selected folder grows
// and pushes its neighbours — this is the one that has to actually bounce,
// since it's standing in for ProjectFolder's un-transitioned :scale prop.
// Damping ratio ~0.5 here (vs. ~0.67 on the panel spring above) so the step
// overshoots and settles rather than gliding straight to rest.
const cellSpring = { type: "spring", stiffness: 300, damping: 15, mass: 0.9 } as const;
// Opacity/blur/desaturation don't want to overshoot — a bounce there reads as
// flicker, not life — so they get a plain eased crossfade instead.
const cellFade = { duration: 0.22, ease: [0.22, 1, 0.36, 1] } as const;
const cellMove = {
  layout: cellSpring,
  y: cellSpring,
  opacity: cellFade,
  filter: cellFade,
} as const;

// The panel scrolls when the list overflows, but it's driven by the keyboard,
// not a mouse — the bar itself would just be visual noise. Instead the
// selected cell scrolls itself into view as the index moves, so cycling past
// the edge of the strip brings the next folder into frame automatically.
const cellRefs = ref<(HTMLElement | null)[]>([]);
function setCellRef(el: Element | null, i: number) {
  cellRefs.value[i] = el as HTMLElement | null;
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
    class="cycle-scrim"
    :initial="{ opacity: 0 }"
    :animate="{ opacity: 1 }"
    :exit="{ opacity: 0 }"
    :transition="{ duration: 0.16 }"
  >
    <motion.div
      class="cycle-panel"
      :initial="{ opacity: 0, scale: 0.9, y: 10 }"
      :animate="{ opacity: 1, scale: 1, y: 0 }"
      :exit="{ opacity: 0, scale: 0.92, y: 6 }"
      :transition="panelSpring"
    >
      <motion.div
        v-for="(entry, i) in props.entries"
        :key="entry.path"
        :ref="(el) => setCellRef(el as Element | null, i)"
        layout
        class="cell"
        :initial="{ opacity: 0, y: 10 }"
        :animate="{
          opacity: i === props.selectedIndex ? 1 : 0.4,
          y: i === props.selectedIndex ? -4 : 0,
          filter: i === props.selectedIndex ? 'blur(0px) saturate(1)' : 'blur(0.5px) saturate(0.7)',
        }"
        :transition="{ ...cellMove, opacity: { ...cellFade, delay: i * 0.03 } }"
      >
        <div class="cell__folder">
          <ProjectFolder
            :name="entry.name"
            :repo="true"
            :branch="null"
            :added="0"
            :removed="0"
            :files="[]"
            :scale="i === props.selectedIndex ? 1.05 : 0.62"
            :hovered="false"
          />
        </div>
        <span class="cell__name">{{ entry.name }}</span>
      </motion.div>
    </motion.div>
  </motion.div>
</template>

<style scoped>
.cycle-scrim {
  position: fixed;
  inset: 0;
  z-index: 70;
  display: flex;
  align-items: center;
  justify-content: center;
  background: color-mix(in srgb, var(--ground) 22%, transparent);
  pointer-events: none;
}

.cycle-panel {
  display: flex;
  align-items: flex-end;
  gap: 30px;
  padding: 32px 40px 26px;
  max-width: min(88vw, 880px);
  overflow-x: auto;
  scrollbar-width: none;
  border-radius: 28px;
  /* Glass: mostly the page behind, frosted — not a solid card. */
  background-color: color-mix(in srgb, var(--ground) 42%, transparent);
  -webkit-backdrop-filter: blur(14px) saturate(1.5);
  backdrop-filter: blur(14px) saturate(1.5);
  border: 1px solid color-mix(in srgb, var(--ink) 10%, transparent);
}
.cycle-panel::-webkit-scrollbar {
  display: none;
}

.cell {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  flex-shrink: 0;
}

.cell__folder {
  padding: 6px;
}

.cell__name {
  max-width: 140px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 500;
  color: var(--muted);
  transition: color 0.2s ease;
}
</style>
