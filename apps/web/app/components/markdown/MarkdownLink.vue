<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Link01Icon } from "@hugeicons/core-free-icons";

// A link in an agent reply. External web links wear the site's favicon in front
// — the little signal that says "this goes to Stripe / GitHub / MDN" before you
// read a word — with a globe glyph as the graceful fallback when the icon 404s
// or hasn't loaded. Anchor/relative links stay plain (no favicon, no new tab).

const props = defineProps<{ href: string }>();

const url = computed<URL | null>(() => {
  try {
    return new URL(props.href, "https://_");
  } catch {
    return null;
  }
});
const external = computed(() => /^https?:\/\//i.test(props.href));
const host = computed(() => url.value?.hostname.replace(/^www\./, "") ?? "");

// Google's favicon service resolves almost any host and ships a real 64px icon;
// on failure (or before it paints) we drop to the globe glyph below.
const faviconSrc = computed(() =>
  external.value && host.value
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host.value)}&sz=64`
    : "",
);
const iconOk = ref(true);
</script>

<template>
  <a
    class="mdlink"
    :class="{ 'mdlink--ext': external }"
    :href="href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
  >
    <span v-if="external" class="mdlink__ico" aria-hidden="true">
      <img
        v-if="faviconSrc && iconOk"
        class="mdlink__fav"
        :src="faviconSrc"
        alt=""
        loading="lazy"
        decoding="async"
        @error="iconOk = false"
      />
      <HugeiconsIcon v-else :icon="Link01Icon" :size="12" :stroke-width="2" />
    </span>
    <span class="mdlink__text"><slot /></span>
  </a>
</template>

<style scoped>
.mdlink {
  color: var(--accent);
  text-decoration: none;
  border-radius: 4px;
  transition: color 0.15s ease, background-color 0.15s ease;
}
.mdlink__text {
  text-decoration: underline;
  text-decoration-color: color-mix(in oklab, var(--accent) 40%, transparent);
  text-underline-offset: 2px;
  text-decoration-thickness: 1px;
}
.mdlink:hover .mdlink__text {
  text-decoration-color: var(--accent);
}
/* Favicon links: keep the icon and its label on one line so the glyph never
   dangles at the end of a wrap. */
.mdlink--ext {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
}
.mdlink__ico {
  position: relative;
  top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 14px;
  height: 14px;
  color: var(--muted);
}
.mdlink__fav {
  width: 14px;
  height: 14px;
  border-radius: 3px;
  object-fit: contain;
}
</style>
