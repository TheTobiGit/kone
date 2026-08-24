<script setup lang="ts">
import { ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Image02Icon } from "@hugeicons/core-free-icons";

// An image (or illustration) in an agent reply. It settles into a rounded,
// width-capped frame with a soft tonal placeholder while it loads and an inline
// caption drawn from the alt text. A broken source degrades to a labelled tile
// rather than the browser's default torn-image glyph.

const props = defineProps<{ src: string; alt?: string }>();

const state = ref<"loading" | "ok" | "error">("loading");
</script>

<template>
  <figure class="mdimg">
    <div class="mdimg__frame" :class="`mdimg__frame--${state}`">
      <img
        v-show="state === 'ok'"
        class="mdimg__img"
        :src="src"
        :alt="alt ?? ''"
        loading="lazy"
        decoding="async"
        @load="state = 'ok'"
        @error="state = 'error'"
      />
      <span v-if="state === 'loading'" class="mdimg__shimmer" aria-hidden="true" />
      <span v-else-if="state === 'error'" class="mdimg__broken">
        <HugeiconsIcon :icon="Image02Icon" :size="20" :stroke-width="1.6" />
        <span class="mdimg__broken-label">{{ alt || "Image unavailable" }}</span>
      </span>
    </div>
    <figcaption v-if="alt && state !== 'error'" class="mdimg__cap">{{ alt }}</figcaption>
  </figure>
</template>

<style scoped>
.mdimg {
  margin: 4px 0 8px;
}
.mdimg__frame {
  position: relative;
  max-width: 100%;
  border-radius: 12px;
  overflow: hidden;
  background: var(--hover);
}
.mdimg__frame--loading {
  min-height: 120px;
}
.mdimg__img {
  display: block;
  max-width: 100%;
  height: auto;
  border-radius: 12px;
}
.mdimg__shimmer {
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 20%,
    color-mix(in oklab, var(--ink) 7%, transparent) 45%,
    transparent 70%
  );
  background-size: 220% 100%;
  animation: mdimg-shimmer 1.4s ease-in-out infinite;
}
@keyframes mdimg-shimmer {
  to { background-position: -180% 0; }
}
.mdimg__broken {
  display: flex;
  align-items: center;
  gap: 9px;
  padding: 18px 16px;
  color: var(--muted);
}
.mdimg__broken-label {
  font-size: 13px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mdimg__cap {
  margin-top: 7px;
  font-size: 12.5px;
  line-height: 18px;
  color: var(--muted);
  text-align: center;
}
@media (prefers-reduced-motion: reduce) {
  .mdimg__shimmer { animation: none; }
}
</style>
