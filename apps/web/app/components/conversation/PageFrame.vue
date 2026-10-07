<script setup lang="ts">
import { ref } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowExpand01Icon } from "@hugeicons/core-free-icons";
import { clampPageHeight, type PageRef } from "@kone/protocol/page-render";
import PageViewerModal from "~/components/conversation/PageViewerModal.vue";
import { usePageFrame } from "~/composables/usePageFrame";

// A page the agent showed, standing in its reply where the call landed: the
// agent's own HTML on the thread's own ground, borderless, so it reads as part
// of what the agent said rather than as an embed.
//
// The frame starts at the height the agent measured and then follows the
// height the page reports, so a page that wraps taller here than it did in the
// agent's preview never ends up scrolling inside the thread and taking the
// reader's scroll. Past the cap the page scrolls inside the frame instead.

const props = defineProps<{
  page: PageRef;
  /** Play the arrival. Off for a transcript loaded from history. */
  animate?: boolean;
}>();

const { cue } = useSound();

const frame = ref<HTMLIFrameElement | null>(null);
const height = ref(props.page.height);
const { src } = usePageFrame(props.page.attachmentId, frame, (reported) => {
  height.value = clampPageHeight(reported);
});

const viewing = ref(false);
function expand(): void {
  cue("expand");
  viewing.value = true;
}
</script>

<template>
  <div class="pagef" :class="{ 'pagef--enter': animate }" :style="{ height: `${height}px` }">
    <!-- Scripts run, in an origin of their own; nothing else is granted. -->
    <iframe
      ref="frame"
      class="pagef__frame"
      :src="src"
      :title="page.title"
      sandbox="allow-scripts allow-forms"
      referrerpolicy="no-referrer"
      loading="lazy"
    />
    <button type="button" class="pagef__expand" :aria-label="`Open ${page.title} full size`" @click="expand">
      <HugeiconsIcon :icon="ArrowExpand01Icon" :size="13" :stroke-width="2" />
    </button>
  </div>
  <PageViewerModal v-if="viewing" :page="page" @close="viewing = false" />
</template>

<style scoped>
.pagef {
  position: relative;
  width: 100%;
  max-width: 100%;
  min-width: 0;
  transition: height 0.24s cubic-bezier(0.22, 1, 0.36, 1);
}
.pagef__frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: transparent;
  color-scheme: normal;
}
/* Out of the way until the reader is on the page: it is the one piece of
   chrome on something that is otherwise all the agent's. */
.pagef__expand {
  position: absolute;
  top: 6px;
  right: 6px;
  display: grid;
  place-items: center;
  width: 24px;
  height: 24px;
  border-radius: 7px;
  color: var(--ink-soft);
  background: color-mix(in oklab, var(--raised) 82%, transparent);
  box-shadow: 0 0 0 1px var(--line-soft);
  backdrop-filter: blur(8px);
  opacity: 0;
  transition: opacity 0.15s ease;
}
.pagef:hover .pagef__expand,
.pagef__expand:focus-visible {
  opacity: 1;
}
.pagef__expand:hover {
  color: var(--ink);
  background: var(--raised);
}
.pagef--enter {
  animation: pagef-in 520ms cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
@keyframes pagef-in {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .pagef {
    transition: none;
  }
  .pagef--enter {
    animation: none;
  }
}
</style>
