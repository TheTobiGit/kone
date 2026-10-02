<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import { PuzzleIcon } from "@hugeicons/core-free-icons";

// A picked skill as an atomic chip. It shares the mention pill's shape so the
// field reads as one line of tokens, but it is an invocation rather than
// context: a puzzle mark, and the bare name — no `/`, since the chip already
// says what it is. The same chip sits in the live field (where
// `data-skill-*` lets the editor read it back) and on the sent turn.
//
// `unavailable` marks a pick the conversation can no longer invoke — removed,
// disabled, or not installed for the provider the draft now goes to. The
// composer toggles it on chips it already rendered, so the look hangs off the
// `mchip--unavailable` class rather than off this prop alone.
defineProps<{ name: string; path: string; unavailable?: boolean }>();
</script>

<template>
  <span
    class="mchip mchip--skill"
    :class="{ 'mchip--unavailable': unavailable }"
    :data-skill-name="name"
    :data-skill-path="path"
    :title="path"
    contenteditable="false"
  >
    <HugeiconsIcon class="mchip__puzzle" :icon="PuzzleIcon" :size="14" :stroke-width="1.8" />
    <span class="mchip__name">{{ name }}</span>
  </span>
</template>

<style scoped>
/* The mention pill's metrics, so a skill and a file sit on one baseline. */
.mchip {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  vertical-align: middle;
  max-width: 100%;
  margin: 0 1px;
  padding: 1px 6px 1px 5px;
  border-radius: 6px;
  font-size: calc(var(--font-size-composer) + 0.5px);
  line-height: 1.15;
  white-space: nowrap;
  cursor: default;
  user-select: none;
}
/* Ink, not accent: mentions are accent-washed context, and a skill is an
   instruction to the agent — a different kind of token deserves a different
   colour, not just a different icon. */
.mchip--skill {
  background: color-mix(in srgb, var(--ink, currentColor) 8%, transparent);
  color: color-mix(in srgb, var(--ink, currentColor) 82%, transparent);
}
.mchip__puzzle {
  flex: 0 0 auto;
  transform: translateY(-0.5px);
  opacity: 0.8;
}
.mchip__name {
  overflow: hidden;
  text-overflow: ellipsis;
  letter-spacing: -0.005em;
}
/* A pick that can't be sent any more: struck through and faded, still
   removable, so the draft says why it won't send instead of sending less. */
.mchip--unavailable {
  opacity: 0.55;
}
.mchip--unavailable .mchip__name {
  text-decoration: line-through;
}
</style>
