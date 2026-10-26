<script setup lang="ts">
import { computed, inject, ref } from "vue";
import { parsePullRequestLink, PULL_REQUEST_OPENER } from "~/utils/pullRequestLink";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Link01Icon } from "@hugeicons/core-free-icons";

// A link in an agent reply. External web links wear the site's favicon in front
// — the little signal that says "this goes to Stripe / GitHub / MDN" before you
// read a word — with a globe glyph as the graceful fallback when the icon 404s
// or hasn't loaded. Anchor/relative links stay plain (no favicon, no new tab).
//
// `bare` is for a link whose content is itself an image — a README badge or a
// logo wrapped in an anchor. There the image is the whole point, so no favicon
// is prefixed and the label gets no underline; the picture just sits there,
// clickable.

const props = defineProps<{ href: string; bare?: boolean }>();
const openPullRequest = inject(PULL_REQUEST_OPENER, null);

function onClick(event: MouseEvent) {
  if (!openPullRequest || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = parsePullRequestLink(props.href);
  if (!link) return;
  const origin = event.currentTarget instanceof HTMLElement ? event.currentTarget.getBoundingClientRect() : null;
  if (openPullRequest(link, origin)) event.preventDefault();
}

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
  external.value && host.value && !props.bare
    ? `https://www.google.com/s2/favicons?domain=${encodeURIComponent(host.value)}&sz=64`
    : "",
);
const iconOk = ref(true);
</script>

<template>
  <a
    class="mdlink"
    :class="{ 'mdlink--ext': external && !bare, 'mdlink--bare': bare }"
    :href="href"
    :target="external ? '_blank' : undefined"
    :rel="external ? 'noopener noreferrer' : undefined"
    @click="onClick"
  >
    <span v-if="external && !bare" class="mdlink__ico" aria-hidden="true">
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
/* An image link carries its own visual weight; the label is just a box. */
.mdlink--bare .mdlink__text {
  text-decoration: none;
}
.mdlink--bare {
  display: inline-block;
  vertical-align: top;
}
</style>
