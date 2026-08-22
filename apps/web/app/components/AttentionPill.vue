<script setup lang="ts">
// The needs-a-human pill — a sibling of the turn-status "dynamic island", but
// for the one thing that must never go quiet: a thread parked on YOU. It wears
// the bloub orb (the pastille while the wait is fresh, the "!" once it's gone
// stale) in the attention hue, names the conversation and what it's asking, and
// drops you straight back into it on click.
//
// Unlike the completion pill it can't be dismissed and it isn't gated by which
// surface you're on: a blocked thread stays lit, everywhere, until it's answered.
import { computed } from "vue";
import { motion, AnimatePresence } from "motion-v";
import ProviderLogo from "~/components/ProviderLogo.vue";
import BloubOrb from "~/components/BloubOrb.vue";
import type { ThreadAttentionKind } from "~/composables/useAgent";
import type { BrandKey } from "~/utils/modelCatalog";

const props = defineProps<{
  /** The conversation this belongs to — the pill's identity overline. */
  threadTitle?: string;
  /** Vendor logomark of the thread's model, when known. */
  brand?: BrandKey;
  /** Why it's waiting — decides the headline. */
  kind: ThreadAttentionKind;
  /** The specific ask: the tool/command for a permission, the question header. */
  detail?: string;
  /** Fresh waits wear the pastille; stale ones escalate to the "!". */
  orbState: "notify" | "exclaim";
}>();

const emit = defineEmits<{ open: [] }>();

const REASON = {
  permission: "Needs your permission",
  question: "Waiting on your answer",
  "parked-spawn": "A spawned thread is parked",
} satisfies Record<ThreadAttentionKind, string>;

const headline = computed(() => REASON[props.kind]);
const title = computed(() => props.threadTitle?.trim() || "");
const hasOverline = computed(() => !!title.value);
// The "!" body carries the urgency on its own, so it takes the hue; the resting
// orb stays neutral and lets the amber pastille be the only coloured thing.
const orbInk = computed(() => (props.orbState === "exclaim" ? "var(--warn)" : "currentColor"));
</script>

<template>
  <motion.div
    class="attn-pill-wrap"
    :initial="{ opacity: 0, y: 18, scale: 0.92 }"
    :animate="{ opacity: 1, y: 0, scale: 1 }"
    :exit="{ opacity: 0, y: 14, scale: 0.94 }"
    :transition="{ type: 'spring', stiffness: 210, damping: 30, mass: 0.9 }"
  >
    <button
      type="button"
      class="attn-pill"
      :class="{ 'attn-pill--bare': !hasOverline }"
      aria-live="polite"
      :aria-label="`${title ? `${title}: ` : ''}${headline}${detail ? ` — ${detail}` : ''}. Open the conversation.`"
      @click="emit('open')"
    >
      <span class="attn-pill__orb">
        <AnimatePresence mode="wait">
          <motion.span
            :key="orbState"
            class="attn-pill__orb-layer"
            :initial="{ opacity: 0, scale: 0.7 }"
            :animate="{ opacity: 1, scale: 1 }"
            :exit="{ opacity: 0, scale: 0.7 }"
            :transition="{ duration: 0.24, ease: [0.22, 1, 0.36, 1] }"
          >
            <BloubOrb :state="orbState" :size="30" :ink="orbInk" :aria-label="headline" />
          </motion.span>
        </AnimatePresence>
      </span>

      <span class="attn-pill__text">
        <span v-if="hasOverline" class="attn-pill__row">
          <ProviderLogo v-if="brand" class="attn-pill__brand" :brand="brand" :size="13" />
          <span class="attn-pill__title">{{ title }}</span>
        </span>

        <span class="attn-pill__row attn-pill__row--status">
          <span class="attn-pill__label">{{ headline }}</span>
          <span v-if="detail" class="attn-pill__detail">
            <span class="attn-pill__detail-dot" />
            <span class="attn-pill__detail-text">{{ detail }}</span>
          </span>
        </span>
      </span>

    </button>
  </motion.div>
</template>

<style scoped>
.attn-pill-wrap {
  /* The stack disables pointer events across its gaps; the pill re-enables its
     own so only the capsule is clickable. */
  pointer-events: auto;
  position: relative;
  display: inline-block;
}

/* A capsule cut from the same cloth as the turn-status pill, warmed with a
   whisper of the attention hue so a stack of these reads as a different, more
   insistent thing than a settled reply — without ever raising its voice. */
.attn-pill {
  display: flex;
  align-items: center;
  gap: 11px;
  width: min(21rem, calc(100vw - 4rem));
  height: 52px;
  padding: 0 16px 0 9px;
  border: 0;
  border-radius: 999px;
  background: color-mix(in oklab, var(--ground) 84%, var(--warn) 9%);
  overflow: hidden;
  cursor: pointer;
  text-align: left;
  -webkit-backdrop-filter: blur(10px);
  backdrop-filter: blur(10px);
  transition:
    transform 0.35s cubic-bezier(0.22, 1, 0.36, 1),
    background-color 0.25s ease;
}
.attn-pill--bare {
  height: 44px;
}
.attn-pill:hover,
.attn-pill-wrap:focus-within .attn-pill {
  transform: translateY(-2px);
  background: color-mix(in oklab, var(--ground) 78%, var(--warn) 13%);
}
.attn-pill:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--warn) 70%, transparent);
  outline-offset: 2px;
}

.attn-pill__orb {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 34px;
  height: 34px;
  color: var(--ink);
}
.attn-pill__orb-layer {
  position: absolute;
  inset: 0;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}

.attn-pill__text {
  display: flex;
  flex-direction: column;
  justify-content: center;
  gap: 1px;
  flex: 1;
  min-width: 0;
}
.attn-pill__row {
  display: flex;
  align-items: center;
  gap: 5px;
  min-width: 0;
}
.attn-pill__row--status {
  align-items: baseline;
}
.attn-pill__brand {
  display: inline-flex;
  align-items: center;
  flex: none;
  opacity: 0.65;
}
.attn-pill__title {
  flex: 1;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-sans);
  font-size: 10.5px;
  font-weight: 550;
  letter-spacing: 0.01em;
  color: var(--muted);
}

/* The reason is the headline here — it's the whole point of the pill, so it
   speaks in full ink, not the muted voice a running status uses. */
.attn-pill__label {
  flex: none;
  font-family: var(--font-sans);
  font-size: 13px;
  font-weight: 600;
  letter-spacing: -0.012em;
  color: var(--ink);
  white-space: nowrap;
}
/* The specific ask, trailing quietly behind the reason and clipping first. */
.attn-pill__detail {
  display: flex;
  align-items: baseline;
  gap: 5px;
  min-width: 0;
}
.attn-pill__detail-dot {
  flex: none;
  align-self: center;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: var(--warn);
  opacity: 0.85;
}
.attn-pill__detail-text {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  letter-spacing: -0.004em;
  color: color-mix(in srgb, var(--muted) 88%, transparent);
}

@media (prefers-reduced-motion: reduce) {
  .attn-pill {
    transition: none;
  }
}
</style>
