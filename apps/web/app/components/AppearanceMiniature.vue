<script setup lang="ts">
import type { ThemeColors } from "~/theme/roles";

// kone drawn at thumbnail size: the rail, the thread column, one exchange, the
// composer. It is painted from a role table rather than the live custom
// properties, which is the whole point — a tile can show the appearance you are
// *considering* while the surrounding interface is still the one you have.
//
// Geometry is percentage-based so the same markup serves a 150px tile and a
// wider one. `clip` lets two of these stack into a single split frame for the
// System tile: the light half on the left, the dark half on the right.
defineProps<{
  colors: ThemeColors;
  clip?: "left" | "right";
}>();

const CLIPS = {
  left: "polygon(0 0, 50% 0, 50% 100%, 0 100%)",
  right: "polygon(50% 0, 100% 0, 100% 100%, 50% 100%)",
} as const;

/** A role value read off a table may be relational (`var(--raised)`), which is
 *  meaningless here — this element is not inside a themed subtree. Anything that
 *  isn't a literal falls back to a neighbour that always is. */
function literal(value: string, fallback: string): string {
  return value.startsWith("var(") ? fallback : value;
}
</script>

<template>
  <span class="mini" :style="clip ? { clipPath: CLIPS[clip] } : undefined" aria-hidden="true">
    <span class="mini__ground" :style="{ backgroundColor: colors.ground }" />

    <!-- The rail down the side -->
    <span
      class="mini__strip"
      :style="{ backgroundColor: literal(colors.strip, colors.ground) }"
    />
    <span class="mini__mark" :style="{ backgroundColor: colors.accent }" />
    <span class="mini__raildot" :style="{ backgroundColor: colors.faint, top: '30%' }" />
    <span class="mini__raildot" :style="{ backgroundColor: colors.faint, top: '41%' }" />
    <span class="mini__raildot" :style="{ backgroundColor: colors.faint, top: '52%' }" />

    <!-- Thread column -->
    <span
      class="mini__panel"
      :style="{ backgroundColor: literal(colors.panel, colors.raised) }"
    />
    <span
      class="mini__field"
      :style="{ backgroundColor: literal(colors.field, colors.raisedHigh) }"
    />
    <span
      v-for="row in 4"
      :key="row"
      class="mini__row"
      :class="{ 'mini__row--on': row === 2 }"
      :style="{
        top: `${29 + (row - 1) * 13}%`,
        backgroundColor: row === 2 ? colors.selected : 'transparent',
      }"
    >
      <span class="mini__rowink" :style="{ backgroundColor: row === 2 ? colors.ink : colors.muted }" />
    </span>

    <!-- One exchange -->
    <span class="mini__bubble" :style="{ backgroundColor: literal(colors.chip, colors.raised) }" />
    <span class="mini__orb" :style="{ backgroundColor: colors.agent }" />
    <span class="mini__line" :style="{ backgroundColor: colors.inkSoft, top: '46%', width: '38%' }" />
    <span class="mini__line" :style="{ backgroundColor: colors.inkSoft, top: '55%', width: '30%' }" />

    <!-- A change card, so the file voice gets a say -->
    <span
      class="mini__card"
      :style="{ backgroundColor: literal(colors.raised, colors.ground) }"
    >
      <span class="mini__filedot" :style="{ backgroundColor: colors.file }" />
      <span class="mini__filebar" :style="{ backgroundColor: colors.diffAdd }" />
    </span>

    <!-- Composer -->
    <span
      class="mini__composer"
      :style="{ backgroundColor: literal(colors.field, colors.raisedHigh) }"
    >
      <span class="mini__caret" :style="{ backgroundColor: colors.placeholder }" />
      <span class="mini__send" :style="{ backgroundColor: colors.accent }" />
    </span>
  </span>
</template>

<style scoped>
.mini {
  position: absolute;
  inset: 0;
  display: block;
}

.mini__ground,
.mini__strip,
.mini__panel {
  position: absolute;
}

.mini__ground {
  inset: 0;
}

.mini__strip {
  inset-block: 0;
  left: 0;
  width: 8%;
}

.mini__mark {
  position: absolute;
  left: 2.6%;
  top: 9%;
  width: 2.8%;
  aspect-ratio: 1;
  border-radius: 2px;
}

.mini__raildot {
  position: absolute;
  left: 3.2%;
  width: 1.6%;
  aspect-ratio: 1;
  border-radius: 50%;
  opacity: 0.7;
}

.mini__panel {
  inset-block: 0;
  left: 8%;
  width: 25%;
}

.mini__field {
  position: absolute;
  left: 11%;
  top: 9%;
  width: 19%;
  height: 8%;
  border-radius: 999px;
}

.mini__row {
  position: absolute;
  left: 10%;
  width: 21%;
  height: 10%;
  border-radius: 3px;
  display: flex;
  align-items: center;
  padding-left: 5%;
}

.mini__rowink {
  display: block;
  width: 62%;
  height: 16%;
  border-radius: 999px;
  opacity: 0.55;
}

.mini__row--on .mini__rowink {
  opacity: 0.85;
}

.mini__bubble {
  position: absolute;
  right: 4%;
  top: 10%;
  width: 30%;
  height: 13%;
  border-radius: 6px;
}

.mini__orb {
  position: absolute;
  left: 37%;
  top: 32%;
  width: 4.4%;
  aspect-ratio: 1;
  border-radius: 50%;
}

.mini__line {
  position: absolute;
  left: 37%;
  height: 3.4%;
  border-radius: 999px;
  opacity: 0.42;
}

.mini__card {
  position: absolute;
  left: 37%;
  top: 65%;
  width: 34%;
  height: 11%;
  border-radius: 4px;
  display: flex;
  align-items: center;
  gap: 6%;
  padding-inline: 5%;
}

.mini__filedot {
  display: block;
  width: 10%;
  aspect-ratio: 1;
  border-radius: 1.5px;
}

.mini__filebar {
  display: block;
  width: 40%;
  height: 16%;
  border-radius: 999px;
  opacity: 0.8;
}

.mini__composer {
  position: absolute;
  left: 36%;
  right: 4%;
  bottom: 6%;
  height: 13%;
  border-radius: 999px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding-inline: 4%;
}

.mini__caret {
  display: block;
  width: 34%;
  height: 14%;
  border-radius: 999px;
  opacity: 0.6;
}

.mini__send {
  display: block;
  height: 56%;
  aspect-ratio: 1;
  border-radius: 50%;
}
</style>
