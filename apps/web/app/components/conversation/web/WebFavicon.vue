<script setup lang="ts">
import { computed, ref } from "vue";
import { siteFaviconUrl } from "~/utils/siteChip";

// A site's face: its favicon, or — offline, or a site without one — its first
// letter on a tint picked from the hostname, so a list of hits never turns into
// a column of identical link glyphs.

const props = withDefaults(defineProps<{ host: string; size?: number; round?: boolean }>(), {
  size: 16,
  round: false,
});

const iconOk = ref(true);
const src = computed(() => siteFaviconUrl(props.host));
const letter = computed(() => (props.host.replace(/^www\./, "")[0] ?? "?").toUpperCase());
const tint = computed(() => {
  let h = 0;
  for (const c of props.host) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `oklch(0.62 0.11 ${h})`;
});
</script>

<template>
  <span
    class="wfav"
    :class="{ 'wfav--round': round }"
    :style="{ '--size': `${size}px`, '--tint': tint }"
    aria-hidden="true"
  >
    <img
      v-if="src && iconOk"
      class="wfav__img"
      :src="src"
      alt=""
      loading="lazy"
      decoding="async"
      @error="iconOk = false"
    />
    <span v-else class="wfav__letter">{{ letter }}</span>
  </span>
</template>

<style scoped>
.wfav {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: var(--size);
  height: var(--size);
  border-radius: 4px;
  overflow: hidden;
}
.wfav--round {
  border-radius: 50%;
  /* A hairline keeps a white favicon from dissolving into a light ground. */
  outline: 1px solid color-mix(in srgb, var(--ink) 8%, transparent);
  outline-offset: -1px;
}
.wfav__img {
  width: 100%;
  height: 100%;
  object-fit: contain;
}
.wfav__letter {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  height: 100%;
  background: color-mix(in oklab, var(--tint) 16%, var(--ground));
  color: var(--tint);
  font-size: calc(var(--size) * 0.62);
  font-weight: 600;
  line-height: 1;
}
</style>
