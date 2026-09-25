<script setup lang="ts">
import type { ConversationStyle } from "~/utils/conversationStyle";

// One tile's miniature for the style picker: one exchange drawn in that look —
// who sits where, and what ties the request to the reply. Owns the sheet it is
// drawn on (the accent when set, the loop when probed) as well as the art, so
// the picker keeps only the radiogroup logic and the labels.

// `kind`, never `style`: Vue reserves `style` for the inline style attribute,
// so a prop by that name never arrives and every tile draws the fallback.
defineProps<{
  kind: ConversationStyle;
  accent?: boolean;
  live?: boolean;
}>();
</script>

<template>
  <SettingsGlyphTile class="sg" :accent="accent" :live="live">
    <svg viewBox="0 0 120 52" class="sg__art" aria-hidden="true">
      <!-- Kone, and Kone Quiet without the elbow ──────────────────── -->
      <template v-if="kind === 'kone' || kind === 'kone-quiet'">
        <rect class="sg__you" x="58" y="6" width="54" height="11" rx="5.5" />
        <path v-if="kind === 'kone'" class="sg__line" d="M57 11.5 H17 Q13 11.5 13 15.5 V23.5" />
        <circle class="sg__face" cx="13" cy="30" r="4.5" />
        <rect class="sg__ink" x="21" y="28.5" width="22" height="3" rx="1.5" />
        <g class="sg__reply">
          <rect class="sg__strong" x="8" y="39" width="92" height="3.5" rx="1.75" />
          <rect class="sg__strong" x="8" y="45.5" width="62" height="3.5" rx="1.75" />
        </g>
      </template>

      <!-- Timeline ──────────────────────────────────────────────── -->
      <template v-else-if="kind === 'timeline'">
        <circle class="sg__youface" cx="9" cy="7" r="4.5" />
        <rect class="sg__ink" x="18" y="5.5" width="20" height="3" rx="1.5" />
        <rect class="sg__you" x="18" y="12" width="58" height="10" rx="3" />
        <path class="sg__line sg__line--rule" d="M9 14 V26" />
        <circle class="sg__face" cx="9" cy="31" r="4.5" />
        <rect class="sg__ink" x="18" y="29.5" width="18" height="3" rx="1.5" />
        <g class="sg__reply">
          <rect class="sg__strong" x="18" y="38" width="94" height="3.5" rx="1.75" />
          <rect class="sg__strong" x="18" y="44.5" width="60" height="3.5" rx="1.75" />
        </g>
      </template>

      <!-- Thread ──────────────────────────────────────────────────── -->
      <template v-else-if="kind === 'thread'">
        <rect class="sg__youface" x="4" y="3" width="11" height="11" rx="3" />
        <rect class="sg__ink" x="19" y="3.5" width="18" height="3" rx="1.5" />
        <rect class="sg__strong sg__soft" x="19" y="10" width="72" height="3.5" rx="1.75" />
        <path class="sg__line" d="M9.5 17 V26 Q9.5 30 13.5 30 H22" />
        <path class="sg__line" d="M19.5 27.5 L22 30 L19.5 32.5" />
        <rect class="sg__face" x="25" y="25" width="10" height="10" rx="2.5" />
        <rect class="sg__ink" x="39" y="26" width="18" height="3" rx="1.5" />
        <g class="sg__reply">
          <rect class="sg__strong" x="39" y="33" width="74" height="3.5" rx="1.75" />
          <rect class="sg__strong" x="39" y="39.5" width="48" height="3.5" rx="1.75" />
        </g>
      </template>

      <!-- Chat ────────────────────────────────────────────────────── -->
      <template v-else-if="kind === 'chat'">
        <rect class="sg__out" x="50" y="4" width="62" height="14" rx="3" />
        <polygon class="sg__out" points="110,4 117,4 112,9.5" />
        <rect class="sg__ink" x="93" y="13" width="9" height="2" rx="1" />
        <path class="sg__tick" d="M103.5 13.5 l1.5 1.5 l3 -3.2 M106.5 13.5 l1.5 1.5 l3 -3.2" />
        <g class="sg__reply">
          <rect class="sg__card" x="8" y="23" width="80" height="26" rx="3" />
          <polygon class="sg__card sg__card--flat" points="10,23 3,23 8,28.5" />
          <rect class="sg__name" x="13" y="27" width="18" height="2.5" rx="1.25" />
          <rect class="sg__strong" x="13" y="33" width="68" height="3.5" rx="1.75" />
          <rect class="sg__strong" x="13" y="39.5" width="44" height="3.5" rx="1.75" />
          <rect class="sg__ink" x="74" y="44" width="9" height="2" rx="1" />
        </g>
      </template>

      <!-- Channel ─────────────────────────────────────────────────── -->
      <template v-else-if="kind === 'channel'">
        <circle class="sg__youface" cx="9" cy="8" r="5.5" />
        <rect class="sg__ink" x="20" y="4" width="18" height="3" rx="1.5" />
        <rect class="sg__ink sg__faint" x="41" y="4" width="16" height="3" rx="1.5" />
        <rect class="sg__strong sg__soft" x="20" y="10.5" width="78" height="3.5" rx="1.75" />
        <path class="sg__line sg__line--spine" d="M9 29 V24.5 Q9 22 11.5 22 H18" />
        <circle class="sg__youface" cx="21.5" cy="22" r="2" />
        <rect class="sg__ink sg__faint" x="25" y="21" width="40" height="2" rx="1" />
        <circle class="sg__face" cx="9" cy="35" r="5.5" />
        <rect class="sg__name" x="20" y="27.5" width="18" height="3" rx="1.5" />
        <rect class="sg__ink sg__faint" x="41" y="27.5" width="16" height="3" rx="1.5" />
        <g class="sg__reply">
          <rect class="sg__strong" x="20" y="34" width="90" height="3.5" rx="1.75" />
          <rect class="sg__strong" x="20" y="40.5" width="60" height="3.5" rx="1.75" />
        </g>
      </template>

      <!-- Prompt ──────────────────────────────────────────────────── -->
      <template v-else>
        <path class="sg__line sg__line--accent" d="M7 6.5 L11 9.75 L7 13" />
        <rect class="sg__strong sg__soft" x="15" y="8" width="54" height="3.5" rx="0.5" />
        <rect class="sg__ink sg__faint" x="98" y="8" width="14" height="3" rx="0.5" />
        <path class="sg__line sg__line--rule" d="M9 20 V50" />
        <circle class="sg__dot" cx="16" cy="23" r="1.6" />
        <rect class="sg__name" x="20" y="21.5" width="18" height="3" rx="0.5" />
        <g class="sg__reply">
          <rect class="sg__strong" x="16" y="30" width="90" height="3" rx="0.5" />
          <rect class="sg__strong" x="16" y="36" width="72" height="3" rx="0.5" />
          <rect class="sg__strong" x="16" y="42" width="40" height="3" rx="0.5" />
        </g>
      </template>
    </svg>
  </SettingsGlyphTile>
</template>

<style scoped>
/* ── the miniature ──────────────────────────────────────────────────────────
   Drawn in the same inks as the choices' glyphs: low-strength ink until the
   style is set, when the reply's lines take the accent. Your side is always a
   touch of accent, since in most styles that is what tells it apart. */
.sg {
  --gt-wash: 4%;
  --gt-edge: 7%;
  --gt-accent-wash: 8%;
  --sg-ink: color-mix(in srgb, var(--ink) 22%, transparent);
  --sg-ink-strong: color-mix(in srgb, var(--ink) 38%, transparent);
  --sg-you: color-mix(in oklab, var(--accent) 26%, transparent);
  display: flex;
  align-items: center;
  justify-content: center;
  height: 64px;
  padding: 6px 8px;
  border-radius: 10px;
  overflow: hidden;
}
.sg.gt--accent {
  --sg-ink-strong: color-mix(in srgb, var(--accent) 70%, transparent);
  --sg-you: color-mix(in oklab, var(--accent) 40%, transparent);
}
.sg__art {
  display: block;
  width: 100%;
  max-width: 132px;
  height: 100%;
  overflow: visible;
}
.sg__you {
  fill: var(--sg-you);
}
.sg__them {
  fill: color-mix(in srgb, var(--ink) 8%, transparent);
}
.sg__out {
  fill: color-mix(in oklab, var(--ok, #25d366) 34%, transparent);
}
.sg__card {
  fill: var(--raised-high, var(--ground));
  stroke: color-mix(in srgb, var(--ink) 10%, transparent);
  stroke-width: 0.8;
}
.sg__card--flat {
  stroke: none;
}
.sg__tick {
  fill: none;
  stroke: #53bdeb;
  stroke-width: 1;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sg__dot {
  fill: var(--accent);
}
.sg__youface {
  fill: color-mix(in oklab, var(--accent) 55%, transparent);
}
.sg__face {
  fill: color-mix(in srgb, var(--ink) 32%, transparent);
}
.sg__ink {
  fill: var(--sg-ink);
}
.sg__faint {
  opacity: 0.55;
}
.sg__strong {
  fill: var(--sg-ink-strong);
  opacity: 0.85;
}
.sg__soft {
  fill: var(--sg-ink);
}
.sg__name {
  fill: color-mix(in oklab, var(--accent) 60%, transparent);
}
.sg__line {
  fill: none;
  stroke: color-mix(in srgb, var(--ink) 34%, transparent);
  stroke-width: 1.3;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.sg__line--accent {
  stroke: var(--accent);
  stroke-width: 1.6;
}
.sg__line--spine {
  stroke-width: 1.5;
  stroke: color-mix(in srgb, var(--ink) 24%, transparent);
}
.sg__line--rule {
  stroke: color-mix(in srgb, var(--ink) 16%, transparent);
  stroke-width: 1;
}

/* The one motion: the reply arrives under the request it answers. */
.gt--live .sg__reply {
  animation: sg-reply 2.4s var(--gt-ease) infinite;
}
@keyframes sg-reply {
  0%,
  20% {
    opacity: 0;
    transform: translateY(3px);
  }
  38%,
  100% {
    opacity: 1;
    transform: none;
  }
}
</style>
