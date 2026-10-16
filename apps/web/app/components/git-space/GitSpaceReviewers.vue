<script setup lang="ts">
import { computed } from "vue";
import type { GitHubPerson, GitHubReviewer } from "~/types/desktop";

// Who is reviewing, as overlapping faces with the verdict drawn as each face's
// ring: green approved, red changes requested, a dashed ring for someone asked
// who hasn't answered. The two verdicts also carry a small tick or cross on the
// face, so they don't rest on green against red alone. A verdict given on an
// older commit is faded, because the code it judged has since moved.
//
// The stack reads as one image whose name lists every verdict in words.

const props = defineProps<{
  reviewers: (GitHubReviewer & { stale?: boolean })[];
  size?: number;
}>();

const WORD = {
  approved: "approved",
  "changes-requested": "requested changes",
  commented: "commented",
  dismissed: "review dismissed",
  pending: "hasn't reviewed yet",
} satisfies Record<GitHubReviewer["state"], string>;

function said(r: GitHubReviewer & { stale?: boolean }) {
  return `${r.person.login} ${WORD[r.state]}${r.stale ? " an earlier commit" : ""}`;
}

const summary = computed(() => `Reviews: ${props.reviewers.map(said).join(", ")}`);

function initial(p: GitHubPerson) {
  return (p.name || p.login)[0]?.toUpperCase() ?? "";
}
</script>

<template>
  <span class="grv" role="img" :aria-label="summary" :style="{ '--s': `${size ?? 20}px` }">
    <span
      v-for="(r, i) in reviewers"
      :key="r.person.login"
      class="grv__seat"
      :class="[`grv__seat--${r.state}`, { 'grv__seat--stale': r.stale }]"
      :style="{ zIndex: reviewers.length - i }"
      :title="said(r)"
    >
      <span class="grv__face">
        <img v-if="r.person.avatarDataUrl" :src="r.person.avatarDataUrl" alt="" />
        <span v-else>{{ initial(r.person) }}</span>
      </span>
      <svg
        v-if="r.state === 'approved' || r.state === 'changes-requested'"
        class="grv__mark"
        viewBox="0 0 10 10"
        aria-hidden="true"
      >
        <path v-if="r.state === 'approved'" d="M2.6 5.3 4.3 7 7.5 3.4" />
        <path v-else d="M3.3 3.3 6.7 6.7M6.7 3.3 3.3 6.7" />
      </svg>
    </span>
  </span>
</template>

<style scoped>
.grv {
  display: inline-flex;
  align-items: center;
  padding-left: 4px;
}
.grv__seat {
  position: relative;
  display: inline-flex;
  margin-left: -4px;
}
.grv__face {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--s);
  height: var(--s);
  border-radius: 50%;
  overflow: hidden;
  background-color: var(--hover);
  font-size: calc(var(--s) * 0.45);
  color: var(--muted);
  /* Page colour first so neighbours separate, then the verdict. */
  box-shadow:
    0 0 0 1.5px var(--ground),
    0 0 0 3px var(--ring, transparent);
}
.grv__face img {
  width: 100%;
  height: 100%;
  object-fit: cover;
}
.grv__seat--approved {
  --ring: var(--ok);
}
.grv__seat--changes-requested {
  --ring: var(--danger);
}
.grv__seat--commented {
  --ring: color-mix(in srgb, var(--ink) 30%, transparent);
}
.grv__seat--pending .grv__face {
  outline: 1.5px dashed color-mix(in srgb, var(--ink) 35%, transparent);
  outline-offset: 1.5px;
}
.grv__seat--pending .grv__face > * {
  opacity: 0.55;
}
.grv__seat--stale .grv__face {
  box-shadow:
    0 0 0 1.5px var(--ground),
    0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
}
/* The verdict in shape: a small disc tucked on the lower right of the face. */
.grv__mark {
  position: absolute;
  right: -3px;
  bottom: -3px;
  width: max(10px, calc(var(--s) * 0.42));
  height: max(10px, calc(var(--s) * 0.42));
  border-radius: 50%;
  background-color: var(--ring);
  box-shadow: 0 0 0 1.5px var(--ground);
  fill: none;
  stroke: var(--raised-high);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
}
.grv__seat--stale .grv__mark {
  opacity: 0.45;
}
</style>
