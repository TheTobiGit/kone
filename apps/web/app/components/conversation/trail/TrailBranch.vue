<script setup lang="ts">
// One branch off the thread's rail. The rail that joins a run of steps carries
// on down past the step's icon and turns into whatever the step wants to show
// (a file a search landed in, the lines an edit changed, how a run came out)
// with a soft elbow, so what a tool did reads as part of the thread rather than
// a box dropped into it. The web trail's sources hang off the same geometry.

withDefaults(
  defineProps<{
    /** The last branch: the rail turns into it and stops. */
    last?: boolean;
    /** Draw the branch in (a result landing live), after `delay` seconds. */
    enter?: boolean;
    delay?: number;
  }>(),
  { last: false, enter: false, delay: 0 },
);
</script>

<template>
  <div class="tbranch" :class="{ 'tbranch--enter': enter }" :style="{ '--d': `${delay}s` }">
    <span v-if="!last" class="tbranch__trunk" aria-hidden="true" />
    <span class="tbranch__elbow" aria-hidden="true" />
    <div class="tbranch__body">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.tbranch {
  /* The rail's own ink, made opaque so a branch crossing the trunk never
     doubles up into a darker joint. */
  --rail: color-mix(in srgb, var(--ink) 12%, var(--ground));
  position: relative;
  display: flow-root;
  padding-left: 24px;
}
.tbranch__trunk {
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--rail);
}
/* Turns into the branch's first line (26px tall, centred at 13px). */
.tbranch__elbow {
  position: absolute;
  left: 7px;
  top: -6px;
  width: 11px;
  height: 19px;
  border-left: 1.5px solid var(--rail);
  border-bottom: 1.5px solid var(--rail);
  border-bottom-left-radius: 7px;
}
/* The first branch reaches all the way up to the step's icon. */
.tbranch:first-child .tbranch__elbow {
  top: -10px;
  height: 23px;
}

.tbranch--enter .tbranch__elbow,
.tbranch--enter .tbranch__trunk {
  animation: tbranch-draw 0.32s cubic-bezier(0.22, 1, 0.36, 1) var(--d) backwards;
}
.tbranch--enter .tbranch__body {
  animation: tbranch-rise 0.3s ease-out calc(var(--d) + 0.08s) backwards;
}
@keyframes tbranch-draw {
  from {
    clip-path: inset(0 100% 100% 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
@keyframes tbranch-rise {
  from {
    opacity: 0;
    filter: blur(4px);
    transform: translateX(-4px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .tbranch--enter .tbranch__elbow,
  .tbranch--enter .tbranch__trunk {
    animation: none;
  }
  .tbranch--enter .tbranch__body {
    animation-name: tbranch-fade;
  }
}
@keyframes tbranch-fade {
  from {
    opacity: 0;
  }
}
</style>
