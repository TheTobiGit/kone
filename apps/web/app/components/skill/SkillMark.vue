<script setup lang="ts">
import { computed } from "vue";

// A skill has no logo and never will — it is a folder with a SKILL.md in it. So
// the mark is derived rather than authored: the origin picks a family hue, and
// the skill's own name picks the angle, the halftone phase and the two stops
// within that family. The result is stable (the same skill always wears the same
// tile), sortable by eye (everything from Claude reads as one family), and
// distinct at a glance in a list of forty. An off skill drains to grey, so state
// is legible from the mark alone before any label is read.

const props = withDefaults(
  defineProps<{
    /** The skill's own name — the whole seed for angle, stops and phase. */
    name: string;
    /** Discovery origin: claude | codex | opencode | cursor | factory | agents | kone. */
    origin: string;
    size?: number;
    /** Drains the tile to grey — the list's at-a-glance "this one is off". */
    muted?: boolean;
    /** Fill the parent as a wide band instead of sitting as a small square. The
     *  seed is the same either way, so a skill's card and its row-sized tile are
     *  visibly the same object at two scales. */
    cover?: boolean;
  }>(),
  { size: 28, muted: false, cover: false },
);

/** Family hue per origin, in oklch hue degrees. Kept low-chroma on purpose: the
 *  tiles are identity, not decoration, and a wall of them has to sit quietly
 *  under the text it belongs to. An unknown origin lands on a neutral graphite
 *  rather than an invented colour. */
const ORIGIN_HUE: Record<string, number> = {
  claude: 44,
  codex: 268,
  opencode: 184,
  cursor: 318,
  factory: 92,
  agents: 232,
  kone: 44,
};

/** FNV-1a, so the same name lands on the same tile on every machine and every
 *  render — a mark that shuffles between reloads is not identity. */
function hash(input: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const tile = computed(() => {
  const h = hash(props.name);
  const hue = ORIGIN_HUE[props.origin] ?? 258;

  // Each byte of the hash drives one independent axis, so two skills that share
  // a family still differ in the way a person notices first (angle, then dot
  // rhythm) rather than in a hue shift too small to see.
  const angle = (h & 0xff) * (360 / 256);
  const lift = 6 + ((h >>> 8) & 0x0f); // how far the two stops separate
  // The family sets where a skill starts; its own name decides how far round it
  // travels from there. Origin alone would give five Claude skills five near
  // identical marks, and the origin is already said twice on a card — by the
  // logomark set into the cover and by the line under it.
  const spin = (((h >>> 12) & 0x3f) - 32) * 1.7;
  const sweep = 40 + ((h >>> 5) & 0x1f) * 1.6; // how far the second stop travels
  const dot = 2.4 + (((h >>> 17) & 0x07) * 0.28); // halftone cell size, px
  const phase = ((h >>> 20) & 0x0f) * 0.4; // where the dot grid starts

  // A band carries far more area than a 28px tile, so the same chroma that reads
  // as quiet identity at thumbnail size would read as decoration across a card.
  // It is lifted a little anyway: a wash that pale over that much area stops
  // being a colour at all.
  const chroma = props.muted ? 0 : props.cover ? 0.115 : 0.11;
  const from = `oklch(${0.78 + lift / 140} ${chroma} ${hue + spin})`;
  const to = `oklch(${0.68 + lift / 200} ${chroma * 0.94} ${hue + spin + sweep})`;

  return {
    "--mark-size": `${props.size}px`,
    "--mark-radius": props.cover ? "14px" : `${Math.max(6, Math.round(props.size * 0.3))}px`,
    "--mark-dot-scale": props.cover ? "2.6" : "1",
    "--mark-angle": `${angle}deg`,
    "--mark-from": from,
    "--mark-to": to,
    "--mark-dot": `${dot}px`,
    "--mark-phase": `${phase}px`,
  };
});
</script>

<template>
  <span
    class="mark"
    :class="{ 'mark--muted': muted, 'mark--cover': cover }"
    :style="tile"
    aria-hidden="true"
  >
    <span class="mark__halftone" />
    <slot />
  </span>
</template>

<style scoped>
.mark {
  position: relative;
  display: block;
  flex-shrink: 0;
  width: var(--mark-size);
  height: var(--mark-size);
  border-radius: var(--mark-radius);
  background-image: linear-gradient(var(--mark-angle), var(--mark-from), var(--mark-to));
  overflow: hidden;
  transition:
    filter 220ms ease,
    opacity 220ms ease;
}
/* The tile's only edge: a hairline of its own colour darkened, so it separates
   from a light ground without becoming a bordered box. */
.mark::after {
  content: "";
  position: absolute;
  inset: 0;
  border-radius: inherit;
  box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.07);
}

/* The halftone: a dot grid that thins out across the tile, so the gradient
   reads as resolving out of dither rather than as a flat swatch. */
.mark__halftone {
  position: absolute;
  inset: 0;
  background-image: radial-gradient(
    circle at center,
    rgb(255 255 255 / 0.55) 0.6px,
    transparent 0.7px
  );
  background-size: calc(var(--mark-dot) * var(--mark-dot-scale, 1))
    calc(var(--mark-dot) * var(--mark-dot-scale, 1));
  background-position: var(--mark-phase) var(--mark-phase);
  mask-image: linear-gradient(var(--mark-angle), #000, transparent 78%);
}

/* As a band the mark stops being a bullet beside the name and becomes the thing
   the eye lands on first, so it fills its slot and holds whatever is set into it. */
.mark--cover {
  display: grid;
  place-items: center;
  width: 100%;
  height: auto;
  aspect-ratio: 16 / 9;
}
/* The halftone reads bigger on a band, so the white dot grows with the cell it
   sits in rather than staying a thumbnail speck across a card. */
.mark--cover .mark__halftone {
  background-image: radial-gradient(
    circle at center,
    rgb(255 255 255 / 0.38) 1.4px,
    transparent 1.6px
  );
}

.mark--muted {
  filter: grayscale(1);
  opacity: 0.55;
}
</style>
