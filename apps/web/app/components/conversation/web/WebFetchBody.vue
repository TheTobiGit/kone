<script setup lang="ts">
import { computed } from "vue";
import { motion } from "motion-v";
import WebFavicon from "~/components/conversation/web/WebFavicon.vue";
import { parseSiteTarget } from "~/utils/siteChip";
import { formatBytes, type WebPage } from "~/utils/webToolResult";

// A fetched page, drawn as a page: the site's face beside the page's own
// heading, then its first real paragraph — the row above already names the
// address. While the fetch
// runs the sheet holds skeleton lines and a reading band travels down them;
// when it lands, the words the agent actually took away replace them.

const props = defineProps<{
  url: string;
  running: boolean;
  page: WebPage | null;
}>();

const site = computed(() => parseSiteTarget(props.url));
const animate = props.running;
</script>

<template>
  <div class="wpage" :class="{ 'wpage--running': running }" :title="site.href">
    <div class="wpage__sheet">
      <div v-if="running" class="wpage__skel" aria-hidden="true">
        <span class="wpage__skel-title" />
        <span v-for="i in 3" :key="i" class="wpage__skel-line" :style="{ '--i': i }" />
        <span class="wpage__band" />
      </div>
      <motion.div
        v-else-if="page"
        class="wpage__read"
        :initial="animate ? { opacity: 0, y: 4 } : false"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }"
      >
        <div class="wpage__head">
          <WebFavicon :host="site.host" :size="14" />
          <span class="wpage__title">{{ page.title || site.host }}</span>
          <span class="wpage__size">{{ formatBytes(page.bytes) }}</span>
        </div>
        <p v-if="page.excerpt" class="wpage__excerpt">{{ page.excerpt }}</p>
      </motion.div>
    </div>
  </div>
</template>

<style scoped>
.wpage {
  margin: 2px 0 8px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 2%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  overflow: hidden;
}
.wpage__sheet {
  position: relative;
  padding: 9px 12px 10px;
  /* The page's own hue runs down the left edge, so the sheet reads as quoted. */
  box-shadow: inset 2px 0 0 color-mix(in oklab, var(--hue, var(--muted)) 55%, transparent);
}
.wpage__head {
  display: flex;
  align-items: center;
  gap: 7px;
  margin-bottom: 4px;
}
.wpage__size {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}
.wpage__title {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--ink);
  font-size: 13px;
  font-weight: 550;
  line-height: 1.4;
}
.wpage__excerpt {
  margin: 0;
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 3;
  line-clamp: 3;
  overflow: hidden;
  color: var(--ink-soft);
  font-size: 12.5px;
  line-height: 1.55;
}

/* While the page loads: skeleton lines and a reading band that travels down. */
.wpage__skel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: 7px;
  padding: 2px 0;
}
.wpage__skel-title,
.wpage__skel-line {
  height: 8px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.wpage__skel-title {
  width: 46%;
  height: 10px;
  margin-bottom: 2px;
  background: color-mix(in srgb, var(--ink) 10%, transparent);
}
.wpage__skel-line {
  width: calc(100% - var(--i) * 14%);
}
.wpage__band {
  position: absolute;
  left: -12px;
  right: -12px;
  top: 0;
  height: 14px;
  background: linear-gradient(
    180deg,
    transparent,
    color-mix(in oklab, var(--hue, var(--muted)) 18%, transparent),
    transparent
  );
  animation: wpage-read 1.5s cubic-bezier(0.45, 0, 0.55, 1) infinite;
  pointer-events: none;
}
@keyframes wpage-read {
  from { transform: translateY(-14px); }
  to { transform: translateY(62px); }
}
@media (prefers-reduced-motion: reduce) {
  .wpage__band {
    animation: none;
    display: none;
  }
}
</style>
