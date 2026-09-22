<script setup lang="ts">
import ProviderLogo from "~/components/provider/ProviderLogo.vue";
import { handoffMarkVerb, type HandoffMark } from "~/utils/handoffMarkers";

// One continuation marker line in the timeline flow — a handoff or a branch:
// the verb for what happened plus the clickable other end. Centered like the
// date/compaction dividers, but interactive — `thread-date` itself is
// pointer-events: none, so this owns its root.

const props = defineProps<{
  mark: HandoffMark;
}>();

const emit = defineEmits<{
  /** Jump to the linked thread. The host owns panes/sessions and opens it. */
  "open-thread": [threadId: string];
}>();

const { cue } = useSound();

function open(): void {
  cue("select");
  emit("open-thread", props.mark.threadId);
}
</script>

<template>
  <div class="thread-mark handoff-mark">
    <span class="handoff-verb">{{ handoffMarkVerb(mark) }}</span>
    <button type="button" class="handoff-link" @click="open">
      <ProviderLogo :brand="mark.brand" :size="13" />
      <span>{{ mark.label }}</span>
    </button>
  </div>
</template>

<style scoped>
.handoff-mark {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: 100%;
  font-size: 12px;
  color: var(--muted);
  user-select: none;
}
.handoff-link {
  display: inline-flex;
  align-items: center;
  gap: 5px;
  padding: 2px 0;
  font-size: 12px;
  font-weight: 550;
  color: var(--ink-soft);
  transition: color 0.15s ease;
}
.handoff-link:hover {
  color: var(--ink);
  text-decoration: underline;
  text-underline-offset: 3px;
}
</style>
