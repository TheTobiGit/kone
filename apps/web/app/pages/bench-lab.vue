<script setup lang="ts">
// The bench portal, standing on its own so it can be looked at.
//
// The portal is normally reached by summoning it over a project page, which
// means seeing it at all has meant building the desktop app and opening a
// checkout. This page mounts it directly with the props the page would pass,
// against the browser-dev job list in useBench — enough to judge type,
// spacing, hierarchy and the two states that matter (a job open, and the
// composer up) without a build.
//
// Temporary, like modal-lab: it exists to settle a design question.

import { ref } from "vue";
import AppBench from "~/components/bench/AppBench.vue";
import type { PortalState } from "~/composables/usePortals";

const state = ref<PortalState>("active");
</script>

<template>
  <div class="lab">
    <AppBench :state="state" surface-top="bench" @close="state = 'hidden'" />
  </div>
</template>

<style scoped>
/* The portal positions itself absolutely inside whatever stage encloses it, so
   the lab has to be that stage. */
.lab {
  position: relative;
  width: 100vw;
  height: 100vh;
  overflow: hidden;
  background: var(--ground);
}
</style>
