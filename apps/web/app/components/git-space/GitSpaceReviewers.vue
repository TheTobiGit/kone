<script setup lang="ts">
import type { GitHubPerson, GitHubReviewer } from "~/types/desktop";

// Who is reviewing, as overlapping faces with the verdict drawn as each face's
// ring: green approved, red changes requested, a dashed ring for someone asked
// who hasn't answered. A verdict given on an older commit is faded, because
// the code it judged has since moved.

defineProps<{
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

function initial(p: GitHubPerson) {
  return (p.name || p.login)[0]?.toUpperCase() ?? "";
}
</script>

<template>
  <span class="grv" :style="{ '--s': `${size ?? 20}px` }">
    <span
      v-for="(r, i) in reviewers"
      :key="r.person.login"
      class="grv__face"
      :class="[`grv__face--${r.state}`, { 'grv__face--stale': r.stale }]"
      :style="{ zIndex: reviewers.length - i }"
      :title="`${r.person.login} ${WORD[r.state]}${r.stale ? ' an earlier commit' : ''}`"
    >
      <img v-if="r.person.avatarDataUrl" :src="r.person.avatarDataUrl" alt="" />
      <span v-else>{{ initial(r.person) }}</span>
    </span>
  </span>
</template>

<style scoped>
.grv {
  display: inline-flex;
  align-items: center;
  padding-left: 4px;
}
.grv__face {
  position: relative;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: var(--s);
  height: var(--s);
  margin-left: -4px;
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
.grv__face--approved {
  --ring: var(--ok);
}
.grv__face--changes-requested {
  --ring: var(--danger);
}
.grv__face--commented {
  --ring: color-mix(in srgb, var(--ink) 30%, transparent);
}
.grv__face--pending {
  --ring: transparent;
  outline: 1.5px dashed color-mix(in srgb, var(--ink) 35%, transparent);
  outline-offset: 1.5px;
}
.grv__face--pending img,
.grv__face--pending span {
  opacity: 0.55;
}
.grv__face--stale {
  box-shadow:
    0 0 0 1.5px var(--ground),
    0 0 0 3px color-mix(in srgb, var(--ring) 35%, transparent);
}
</style>
