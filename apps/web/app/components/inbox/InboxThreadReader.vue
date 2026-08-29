<script setup lang="ts">
// The inbox's right pane: which thread you are looking at, and how much of a
// thread this pane can be.
//
// Two answers, and the row decides which one. A row that knows its project can
// have a live session, so it gets the full thread — transcript and composer.
// A row that does not is still perfectly readable, so it gets the transcript
// alone rather than an error: reading is keyed on the thread id against one
// database, and needs no project at all.
//
// The live pane is keyed on the project and the thread together, because the
// session registry is chosen from the project path once, at setup. Keying it
// here is what lets that stay a plain value instead of something the pane has
// to watch.

import { computed } from "vue";
import type { SessionSummary } from "~/types/session";

const props = defineProps<{
  /** The selected row. Nothing selected is not this component's case: with no
   *  thread to read the portal shows the composer instead, so there is no empty
   *  state here to write. */
  row: SessionSummary;
  /** The live session this thread is already running in, when the caller knows
   *  it — set only by the composer's handover. Without it the live pane finds
   *  the session by thread id, which is how every thread picked out of the list
   *  arrives. */
  sessionKey?: string;
}>();

const projectPath = computed(() => props.row.projectPath ?? null);
</script>

<template>
  <InboxThreadLive
    v-if="projectPath"
    :key="`${projectPath}::${row.threadId}`"
    :row="row"
    :project-path="projectPath"
    :session-key="sessionKey"
  />

  <InboxThreadStored v-else :key="row.threadId" :row="row" />
</template>
