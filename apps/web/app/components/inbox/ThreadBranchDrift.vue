<script setup lang="ts">
// The thread's work was done on one branch, and its next turn would land on
// another.
//
// Said where the turn would go, because that is the moment it matters: the
// agent is about to read and edit a working tree that is not the one the rest
// of this conversation was written against, and nothing else on screen would
// have mentioned it.
//
// Not an error, and deliberately not styled as one — switching branches under a
// thread is a perfectly ordinary thing to do on purpose. The banner states the
// two names and gets out of the way; deciding what to do about it is the user's.
//
// Only ever for a thread sharing the project's checkout. A thread that works in
// a directory of its own cannot drift, and the resolver refuses to report one
// before it gets here — so this never has to know about worktrees.

import type { BranchDrift } from "~/utils/branchDrift";

defineProps<{
  /** The drift to report, or null for the ordinary case — bind it
   *  unconditionally and the banner renders nothing when there is none. */
  drift: BranchDrift | null;
}>();
</script>

<template>
  <div v-if="drift" class="bd" role="status">
    <p class="bd__text">
      This thread's work was done on <span class="bd__ref">{{ drift.ranOn }}</span
      >. You are on <span class="bd__ref">{{ drift.nowOn }}</span> now, so that is where the
      next turn lands.
    </p>
  </div>
</template>

<style scoped>
.bd {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border: 1px solid color-mix(in srgb, var(--warn) 24%, transparent);
  border-radius: 10px;
  background-color: color-mix(in srgb, var(--warn) 7%, var(--raised));
}

.bd__text {
  flex: 1;
  min-width: 0;
  margin: 0;
  font-size: 12.5px;
  line-height: 1.45;
  color: var(--ink);
}

/* The names are the whole content of the sentence, so they are set as refs
   rather than left to read as ordinary words in it. */
.bd__ref {
  font-family: var(--font-mono);
  font-size: 11.5px;
  padding: 1px 5px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  word-break: break-all;
}
</style>
