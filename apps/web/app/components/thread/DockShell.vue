<script setup lang="ts">
import { computed } from "vue";
import { motion } from "motion-v";
import { cardSpring } from "~/utils/cardSpring";
import { provideDockSections, type DockSectionId } from "~/composables/useDockSections";

// The thread dock's frame — the intent menu's construction (PickerShell) worn
// by the docks: a band-coloured shell with a header strip, a tray of section
// cards with the band showing between them, and a footer strip. The cards'
// own rounded corners are what curve the strips, top and bottom.
//
// The sections (DockSection) fold themselves and may stand open together; the
// shell only sums them, for the footer's Expand all / Collapse all. Without
// `bands` the shell is just the rim around its cards — the single-section
// corner dock, where a header would only repeat the section's own title.

const props = withDefaults(
  defineProps<{
    /** Show the header and footer strips. */
    bands?: boolean;
    title?: string;
    /** Something in the dock is still in flight — the header's orb pulses. */
    live?: boolean;
    /** The footer's one-line summary of what the sections hold. */
    meta?: string;
    /** Where the shell grows from, for its pop-in. */
    origin?: string;
    ariaLabel?: string;
    /** A section to open on arrival — the rail tile the shell was opened from. */
    focus?: DockSectionId | null;
  }>(),
  {
    bands: false,
    title: "",
    live: false,
    meta: "",
    origin: "100% 100%",
    ariaLabel: "Thread docks",
    focus: null,
  },
);

const { cue } = useSound();
const { count, allOpen, wide, setAll } = provideDockSections(() => props.focus);

const canToggleAll = computed(() => count.value > 1);

function toggleAll(): void {
  const open = !allOpen.value;
  setAll(open);
  cue(open ? "expand" : "collapse");
}
</script>

<template>
  <!-- data-agent-dock: dock clicks must not collapse the composer bar, whose
       click-outside ignores marked surfaces. -->
  <motion.div
    data-agent-dock
    class="dock-shell"
    :class="{ 'dock-shell--bands': props.bands, 'dock-shell--wide': wide }"
    :style="{ transformOrigin: props.origin }"
    :initial="{ opacity: 0, y: 16, scale: 0.94 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 12, scale: 0.95 }"
    :transition="cardSpring"
    role="region"
    :aria-label="props.ariaLabel"
  >
    <div v-if="props.bands" class="dock-band dock-band--head">
      <span class="dock-title">
        <span v-if="props.live" class="dock-orb" aria-hidden="true" />
        {{ props.title }}
      </span>
    </div>

    <div class="dock-tray">
      <slot />
    </div>

    <div v-if="props.bands" class="dock-band dock-band--foot">
      <span class="dock-meta" :title="props.meta">{{ props.meta }}</span>
      <button
        v-if="canToggleAll"
        type="button"
        class="dock-action"
        @click="toggleAll"
      >
        {{ allOpen ? "Collapse all" : "Expand all" }}
      </button>
    </div>
  </motion.div>
</template>

<style scoped>
/* The shell — PickerShell's: band fill, 20px radius, hairline ring and a soft
   drop. It clips so the strips' square corners never paint past the curve. */
.dock-shell {
  width: var(--dock-width, min(18rem, calc(100vw - 2.5rem)));
  pointer-events: auto;
  will-change: transform, opacity;
  background: var(--band);
  border-radius: 20px;
  overflow: hidden;
  box-shadow:
    0 0 0 1px color-mix(in srgb, var(--ink) 8%, transparent),
    0 10px 28px -12px rgb(0 0 0 / 0.18);
  /* The morph: the same shell widens in place when a section asks for room (a
     diff read inside the Changes section), so the diff arrives where the list
     was rather than in a new surface. */
  transition: width 0.28s cubic-bezier(0.22, 1, 0.36, 1);
}
.dock-shell--wide {
  width: var(--dock-width-wide, min(37rem, calc(100vw - 2.5rem)));
}

/* ── strips ── */
.dock-band {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  min-width: 0;
  padding: 0.5rem 0.8rem;
}
.dock-title {
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  min-width: 0;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  color: var(--ink-soft);
  white-space: nowrap;
}
.dock-orb {
  flex: none;
  width: 7px;
  height: 7px;
  border-radius: 999px;
  background: var(--accent);
  animation: dock-orb-pulse 1.4s ease-in-out infinite;
}
@keyframes dock-orb-pulse {
  50% {
    opacity: 0.35;
    transform: scale(0.8);
  }
}
.dock-meta {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-family: var(--font-mono);
  font-size: 10.5px;
  font-variant-numeric: tabular-nums;
  color: var(--muted);
}
.dock-action {
  flex: none;
  border: 0;
  padding: 0;
  background: transparent;
  font-size: 12.5px;
  font-weight: 600;
  letter-spacing: -0.01em;
  white-space: nowrap;
  color: var(--muted);
  cursor: pointer;
  transition: color 0.16s ease;
}
.dock-action:hover,
.dock-action:focus-visible {
  outline: none;
  color: var(--ink);
}

/* ── tray ── the section cards, 5px of band between them. Without strips the
   tray is the whole shell, so it keeps a 1px rim all round; with them the
   strips carry the top and bottom. */
.dock-tray {
  display: flex;
  flex-direction: column;
  gap: 5px;
  max-height: var(--dock-tray-max, none);
  padding: 1px;
  overflow-y: auto;
  overflow-x: hidden;
  scrollbar-width: none;
}
.dock-tray::-webkit-scrollbar {
  display: none;
}
.dock-shell--bands .dock-tray {
  padding-block: 0;
}

@media (prefers-reduced-motion: reduce) {
  .dock-shell {
    transition: none;
    will-change: auto;
  }
  .dock-orb {
    animation: none;
  }
}
</style>
