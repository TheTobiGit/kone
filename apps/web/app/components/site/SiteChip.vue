<script setup lang="ts">
import { computed, ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Link01Icon } from "@hugeicons/core-free-icons";
import { parseSiteTarget, siteFaviconUrl } from "~/utils/siteChip";

// When an agent names a URL — a fetched page, an API doc, a blog post — render
// it as a chip with the site's favicon up front, the hostname dimmed and the
// path tail in ink. Same visual language as FileChip, but for the web.

const props = defineProps<{ url: string; title?: string }>();

const parts = computed(() => parseSiteTarget(props.url));
const faviconSrc = computed(() => siteFaviconUrl(parts.value.host));
const iconOk = ref(true);
</script>

<template>
  <span class="chip" :title="title ?? parts.title">
    <span class="chip__ico" aria-hidden="true">
      <img
        v-if="faviconSrc && iconOk"
        class="chip__fav"
        :src="faviconSrc"
        alt=""
        loading="lazy"
        decoding="async"
        @error="iconOk = false"
      />
      <HugeiconsIcon v-else :icon="Link01Icon" :size="12" :stroke-width="2" />
    </span>
    <span class="chip__path">
      <template v-if="parts.tail">
        <span class="chip__dir">{{ parts.host }}/</span><span class="chip__name">{{ parts.tail }}</span>
      </template>
      <span v-else class="chip__name">{{ parts.host }}</span>
    </span>
  </span>
</template>

<style scoped>
.chip {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  padding: 1px 6px 1px 5px;
  border-radius: 6px;
  background: var(--hover);
  font-family: var(--font-mono);
  font-size: 12.5px;
  line-height: 1.5;
  vertical-align: baseline;
  white-space: nowrap;
  max-width: 100%;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip__ico {
  position: relative;
  top: 2px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
  width: 13px;
  height: 13px;
  color: var(--muted);
}
.chip__fav {
  width: 13px;
  height: 13px;
  border-radius: 3px;
  object-fit: contain;
}
.chip__path {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.chip__dir {
  color: var(--muted);
}
.chip__name {
  color: var(--ink);
}
</style>
