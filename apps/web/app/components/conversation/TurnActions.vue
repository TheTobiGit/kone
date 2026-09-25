<script setup lang="ts">
import { HugeiconsIcon } from "@hugeicons/vue";
import {
  Copy01Icon,
  GitForkIcon,
  Note01Icon,
  PencilEdit01Icon,
  Tick02Icon,
} from "@hugeicons/core-free-icons";

// One turn's icon actions, wherever its style seats them: at the far end of
// the head line (YouHead / the speaker line), at the end of the prompt's
// command line, or in the chat request's hover row under it. Purely
// presentational — the thread owns what each button does and when this
// mounts (settled turns with something to act on; never while editing).
defineProps<{
  /** Whose turn this acts on: a request (`you` — Edit / Copy / Scratchpad)
   *  or a reply (`kone` — Copy / Scratchpad / Fork). */
  kind: "you" | "kone";
  /** This turn's text just landed on the clipboard. */
  copied: boolean;
  /** Whether the Scratchpad button is offered here at all. */
  allowScratchpad: boolean;
  /** Whether the Fork button is offered here at all. Replies only. */
  allowBranch?: boolean;
  /** A turn is in flight — Fork is refused while one is. Replies only. */
  busy?: boolean;
  /** There is settled text worth acting on. The thread gates mounting on
   *  this too; the buttons re-check it so the component never depends on
   *  being mounted correctly to stay quiet. */
  canAct: boolean;
}>();

const emit = defineEmits<{
  edit: [];
  copy: [];
  scratchpad: [];
  fork: [];
}>();
</script>

<template>
  <span class="turn-acts">
    <button
      v-if="kind === 'you'"
      type="button"
      class="act"
      data-tip="Edit"
      aria-label="Edit request"
      @click="emit('edit')"
    >
      <HugeiconsIcon :icon="PencilEdit01Icon" :size="14" :stroke-width="1.8" />
    </button>
    <button
      v-if="canAct"
      type="button"
      class="act"
      :class="{ 'act--done': copied }"
      :data-tip="copied ? 'Copied' : 'Copy'"
      :aria-label="copied ? 'Copied' : kind === 'you' ? 'Copy request' : 'Copy reply'"
      @click="emit('copy')"
    >
      <HugeiconsIcon :icon="copied ? Tick02Icon : Copy01Icon" :size="14" :stroke-width="1.8" />
    </button>
    <button
      v-if="allowScratchpad && canAct"
      type="button"
      class="act"
      data-tip="Scratchpad"
      :aria-label="kind === 'you' ? 'Add request to scratchpad' : 'Add to scratchpad'"
      @click="emit('scratchpad')"
    >
      <HugeiconsIcon :icon="Note01Icon" :size="14" :stroke-width="1.8" />
    </button>
    <button
      v-if="kind === 'kone' && allowBranch && canAct"
      type="button"
      class="act"
      data-tip="Fork"
      :disabled="busy"
      aria-label="Fork a new thread from this reply"
      @click="emit('fork')"
    >
      <HugeiconsIcon :icon="GitForkIcon" :size="14" :stroke-width="1.8" />
    </button>
  </span>
</template>

<style scoped>
/* The row itself is only layout — where it sits and when it shows is the
   thread's (conversationStyles.css), because the heads it docks into render
   in other components. The `.act` chrome below is the single authority for
   turn-action buttons; nothing else restates it. */
.turn-acts {
  display: inline-flex;
  align-items: center;
  gap: 0;
}
.act {
  position: relative;
  display: inline-flex;
  flex: none;
  align-items: center;
  justify-content: center;
  width: 24px;
  height: 24px;
  padding: 0;
  border: 0;
  border-radius: 7px;
  background: transparent;
  color: var(--muted);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease;
}
.act:hover {
  background: var(--hover);
  color: var(--ink);
}
.act:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--ink) 30%, transparent);
  outline-offset: 1px;
}
.act--done {
  color: var(--ink-soft);
}
.act:disabled {
  opacity: 0.45;
  cursor: default;
}
.act:disabled:hover {
  background: transparent;
  color: var(--muted);
}
.act[data-tip]::after {
  content: attr(data-tip);
  position: absolute;
  bottom: calc(100% + 6px);
  left: 50%;
  z-index: 6;
  padding: 3px 7px;
  border-radius: 6px;
  background: var(--ink);
  color: var(--ground);
  font-family: var(--font-sans);
  font-size: 11px;
  font-weight: 500;
  line-height: 1.3;
  white-space: nowrap;
  opacity: 0;
  pointer-events: none;
  transform: translate(-50%, 2px);
  transition: opacity 0.12s ease, transform 0.12s ease;
}
.act[data-tip]:hover::after,
.act[data-tip]:focus-visible::after {
  opacity: 1;
  transform: translate(-50%, 0);
  transition-delay: 0.3s;
}
</style>
