<script setup lang="ts">
import { computed } from "vue";
import type { GitHubIssue } from "~/types/desktop";

// Where an issue stands, as one small mark: an open ring with a dot at its
// heart, a filled disc with a tick once it's done, and a ring struck through
// when it was closed without being done. The shape carries the meaning, so it
// still reads without the colour.

const props = withDefaults(
  defineProps<{
    issue: Pick<GitHubIssue, "state" | "stateReason">;
    size?: number;
  }>(),
  { size: 16 },
);

const kind = computed(() => {
  if (props.issue.state === "open") return "open";
  return props.issue.stateReason === "not-planned" || props.issue.stateReason === "duplicate" ? "skipped" : "done";
});

const label = computed(() => {
  if (kind.value === "open") return "Open";
  if (props.issue.stateReason === "duplicate") return "Closed as a duplicate";
  return kind.value === "skipped" ? "Closed as not planned" : "Closed as done";
});
</script>

<template>
  <svg
    class="gig"
    :class="`gig--${kind}`"
    :width="size"
    :height="size"
    viewBox="0 0 16 16"
    role="img"
    :aria-label="label"
  >
    <title>{{ label }}</title>
    <template v-if="kind === 'open'">
      <circle cx="8" cy="8" r="6.25" class="gig__ring" />
      <circle cx="8" cy="8" r="2" class="gig__fill" />
    </template>
    <template v-else-if="kind === 'done'">
      <circle cx="8" cy="8" r="7" class="gig__fill" />
      <path d="M5 8.2 7.1 10.2 11 6" class="gig__mark" />
    </template>
    <template v-else>
      <circle cx="8" cy="8" r="6.25" class="gig__ring" />
      <path d="M3.8 12.2 12.2 3.8" class="gig__ring" />
    </template>
  </svg>
</template>

<style scoped>
.gig {
  display: block;
  flex-shrink: 0;
}
.gig__ring {
  fill: none;
  stroke: var(--tone);
  stroke-width: 1.5;
  stroke-linecap: round;
}
.gig__fill {
  fill: var(--tone);
}
.gig__mark {
  fill: none;
  stroke: var(--raised-high);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.gig--open {
  --tone: var(--ok);
}
.gig--done {
  --tone: var(--accent-2);
}
.gig--skipped {
  --tone: var(--ink-soft);
}
</style>
