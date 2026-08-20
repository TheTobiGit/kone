<script setup lang="ts">
// The needs-a-human beacon: one big bloub at the bottom-centre — the app's action
// locus, where the composer's own orb lives — instead of a pill tucked in the
// dismissible corner. It stands for every OTHER thread parked on you (the focused
// thread carries its own docked cue). At rest it's just the orb with a soft warn
// halo and a count; hover or click blooms the parked threads upward as the pills
// you'd otherwise hunt for, and picking one drops you into it.
import { computed, ref } from "vue";
import { motion, AnimatePresence } from "motion-v";
import BloubOrb from "~/components/BloubOrb.vue";
import AttentionPill from "~/components/AttentionPill.vue";
import type { ThreadAttentionKind } from "~/composables/useAgent";
import type { BrandKey } from "~/utils/modelCatalog";

type BeaconItem = {
  key: string;
  threadId: string;
  title: string;
  brand?: BrandKey;
  kind: ThreadAttentionKind;
  detail?: string;
  /** Fresh waits wear the pastille; a stale one escalates this row's orb. */
  orbState: "notify" | "exclaim";
};

const props = defineProps<{ items: BeaconItem[] }>();
const emit = defineEmits<{ open: [threadId: string] }>();

const count = computed(() => props.items.length);
const single = computed(() => count.value === 1);
// One orb for the lot: if anything has gone stale, the whole beacon escalates —
// you shouldn't have to open it to learn something's been waiting too long.
const beaconOrb = computed<"notify" | "exclaim">(() =>
  props.items.some((i) => i.orbState === "exclaim") ? "exclaim" : "notify",
);

// Hover reveals; a click pins it open (so it survives on touch, and so a click
// on the orb with several waiting doesn't force a blind jump).
const hovered = ref(false);
const pinned = ref(false);
const expanded = computed(() => hovered.value || pinned.value);

function onOrbClick(): void {
  if (single.value) {
    emit("open", props.items[0]!.threadId);
    return;
  }
  pinned.value = !pinned.value;
}
function onRowOpen(threadId: string): void {
  pinned.value = false;
  emit("open", threadId);
}

const orbLabel = computed(() =>
  single.value
    ? `A thread needs you: ${props.items[0]!.title}. Open it.`
    : `${count.value} threads need you. Show them.`,
);
</script>

<template>
  <motion.div
    class="beacon"
    :initial="{ opacity: 0, y: 26, scale: 0.7 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 18, scale: 0.72 }"
    :transition="{ type: 'spring', stiffness: 200, damping: 26, mass: 1.1 }"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
  >
    <!-- The bloomed list — the parked threads, newest concerns nearest the orb.
         Same pills as everywhere; here they're summoned rather than resident. -->
    <AnimatePresence :initial="false">
      <motion.div
        v-if="expanded"
        class="beacon__list"
        :initial="{ opacity: 0, y: 10, scale: 0.97 }"
        :animate="{ opacity: 1, y: 0, scale: 1 }"
        :exit="{ opacity: 0, y: 8, scale: 0.98 }"
        :transition="{ type: 'spring', stiffness: 260, damping: 30, mass: 0.8 }"
      >
        <AttentionPill
          v-for="a in items"
          :key="a.key"
          :thread-title="a.title"
          :brand="a.brand"
          :kind="a.kind"
          :detail="a.detail"
          :orb-state="a.orbState"
          @open="onRowOpen(a.threadId)"
        />
      </motion.div>
    </AnimatePresence>

    <button
      type="button"
      class="beacon__orb"
      :class="{ 'beacon__orb--open': expanded }"
      :aria-label="orbLabel"
      :aria-expanded="!single ? expanded : undefined"
      @click="onOrbClick"
      @focus="hovered = true"
      @blur="hovered = false"
    >
      <span class="beacon__halo" aria-hidden="true" />
      <BloubOrb :state="beaconOrb" :size="88" :aria-label="orbLabel" />
      <span v-if="count > 1" class="beacon__count">{{ count }}</span>
    </button>
  </motion.div>
</template>

<style scoped>
.beacon {
  pointer-events: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 14px;
}

/* The bloomed pills stack above the orb, newest nearest it (column-reverse so
   the last — the freshest — sits at the bottom, closest to the beacon). */
.beacon__list {
  display: flex;
  flex-direction: column-reverse;
  align-items: center;
  gap: 10px;
}

/* The button hugs the bloub's VISIBLE body — the drawn orb fills only the middle
   ~63% of its SVG box, so a 88px bloub reads as a ~55px marble, matching the
   composer's own resting orb. The SVG overflows this box; the box is what the
   halo and the count chip pin to. */
.beacon__orb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 55px;
  height: 55px;
  padding: 0;
  border: 0;
  background: transparent;
  cursor: pointer;
  color: var(--ink);
  overflow: visible;
  transition: transform 0.3s cubic-bezier(0.22, 1, 0.36, 1);
}
.beacon__orb:hover {
  transform: translateY(-2px) scale(1.04);
}
.beacon__orb:focus-visible {
  outline: none;
}
.beacon__orb:focus-visible .beacon__halo {
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--warn) 55%, transparent);
}

/* A soft warm halo that breathes — the eye-catch. It never hardens into a ring;
   it's a low glow that swells and settles, the calm "over here" the corner pill
   could never give. */
.beacon__halo {
  position: absolute;
  inset: -14px;
  border-radius: 50%;
  background: radial-gradient(
    circle,
    color-mix(in srgb, var(--warn) 20%, transparent) 0%,
    transparent 72%
  );
  animation: beacon-breathe 3.4s ease-in-out infinite;
}
@keyframes beacon-breathe {
  0%,
  100% {
    transform: scale(0.96);
    opacity: 0.4;
  }
  50% {
    transform: scale(1.08);
    opacity: 0.66;
  }
}

/* How many are waiting — a small tabular chip riding the orb's shoulder, in the
   attention hue so it reads as one thing with the halo. */
.beacon__count {
  position: absolute;
  top: -2px;
  right: -2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 20px;
  height: 20px;
  padding: 0 5px;
  border-radius: 999px;
  background: var(--warn);
  color: var(--ground);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 650;
  font-variant-numeric: tabular-nums;
  line-height: 1;
}

@media (prefers-reduced-motion: reduce) {
  .beacon__halo {
    animation: none;
    opacity: 0.5;
  }
  .beacon__orb {
    transition: none;
  }
}
</style>
