<script setup lang="ts">
import { computed } from "vue";
import WebSourceNode from "~/components/conversation/web/WebSourceNode.vue";
import { parseSiteTarget } from "~/utils/siteChip";
import type { WebPage } from "~/utils/webToolResult";

// A page fetched on its own — not one of a search's hits, which grow under the
// search instead. Drawn as that same branch: the page's face and its own
// heading off the rail, a ring while it loads, then what it said.

const props = defineProps<{
  url: string;
  running: boolean;
  page: WebPage | null;
}>();

const site = computed(() => parseSiteTarget(props.url));
const animate = props.running;
</script>

<template>
  <div class="wfetch">
    <WebSourceNode
      last
      :url="site.href"
      :host="site.host"
      :title="page?.title || site.tail || site.host"
      :state="running ? 'reading' : 'read'"
      :excerpt="page?.excerpt"
      :enter="animate"
    />
  </div>
</template>

<style scoped>
.wfetch {
  padding-bottom: 4px;
}
</style>
