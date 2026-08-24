<script setup lang="ts">
// A wrapper that animates its own height to match its content, so a block whose
// content changes size (a provider card resolving from a short placeholder to
// its full set of meters) *grows* smoothly instead of snapping — and everything
// below it glides down rather than jumping. The content is measured with a
// ResizeObserver and the height eased; overflow is clipped so taller content
// wipes in top-down as the box opens rather than spilling past the old height.
import { onBeforeUnmount, onMounted, ref } from "vue";

const host = ref<HTMLElement>();
const inner = ref<HTMLElement>();
let ro: ResizeObserver | null = null;
// The first measurement sets the height with no transition, so a card that is
// already resolved on first paint just sits at its size rather than animating
// open from nothing.
let primed = false;

function sync() {
  const el = host.value;
  const content = inner.value;
  if (!el || !content) return;
  const h = content.offsetHeight;
  if (!primed) {
    el.style.height = `${h}px`;
    primed = true;
    return;
  }
  el.style.height = `${h}px`;
}

onMounted(() => {
  if (!inner.value) return;
  sync();
  ro = new ResizeObserver(() => sync());
  ro.observe(inner.value);
});

onBeforeUnmount(() => {
  ro?.disconnect();
  ro = null;
});
</script>

<template>
  <div ref="host" class="smooth-resize">
    <div ref="inner">
      <slot />
    </div>
  </div>
</template>

<style scoped>
.smooth-resize {
  /* clip (not hidden) with a small margin so a button's focus ring inside the
     body isn't shaved off at rest, while taller content is still clipped as the
     box grows open. */
  overflow: clip;
  overflow-clip-margin: 6px;
  transition: height 0.42s cubic-bezier(0.22, 1, 0.36, 1);
}
@media (prefers-reduced-motion: reduce) {
  .smooth-resize {
    transition: none;
  }
}
</style>
