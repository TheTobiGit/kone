<script setup lang="ts">
import { computed, ref } from "vue";
import WebFavicon from "~/components/conversation/web/WebFavicon.vue";
import WebSourceNode from "~/components/conversation/web/WebSourceNode.vue";
import { webKey, type WebHit, type WebRead } from "~/utils/webToolResult";

// A web search's hits, grown off the thread's rail as branches. While the
// search is out, faint branches hold the place; when it lands the hits draw in
// one after another. A hit the agent goes on to open turns its ring and then
// keeps what the page said underneath, so the reader can see exactly which
// sources the answer stands on — without the fetch needing a row of its own.

const props = defineProps<{
  running: boolean;
  hits: WebHit[];
  /** Pages this batch has opened, keyed by `webKey`. */
  reads: ReadonlyMap<string, WebRead>;
}>();

const SHOWN = 4;
const { cue } = useSound();

// Only a search the reader watched land draws its branches in.
const animate = props.running;
const expanded = ref(false);

const readOf = (h: WebHit) => props.reads.get(webKey(h.url));

function stateOf(h: WebHit): "idle" | "reading" | "read" | "failed" {
  const r = readOf(h);
  if (!r) return "idle";
  if (r.state === "running") return "reading";
  return r.state === "error" ? "failed" : "read";
}

// The top hits, plus any further down that the agent opened: a source the
// answer leans on never hides behind the fold.
const visible = computed(() =>
  expanded.value ? props.hits : props.hits.filter((h, i) => i < SHOWN || readOf(h) !== undefined),
);
const hidden = computed(() => props.hits.filter((h) => !visible.value.includes(h)));
const hasTail = computed(() => hidden.value.length > 0 || expanded.value);

function toggleMore(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
}
</script>

<template>
  <div class="wsrch">
    <template v-if="running && !hits.length">
      <WebSourceNode v-for="i in 3" :key="`ghost${i}`" :last="i === 3" class="wsrch__ghost">
        <template #line>
          <span class="wsrch__ghost-line" :style="{ '--i': i }" aria-hidden="true">
            <span class="wsrch__ghost-face" />
            <span class="wsrch__ghost-bar" />
          </span>
        </template>
      </WebSourceNode>
    </template>

    <template v-else>
      <WebSourceNode
        v-for="(h, i) in visible"
        :key="h.url"
        :url="h.url"
        :host="h.host"
        :title="h.title"
        :state="stateOf(h)"
        :excerpt="readOf(h)?.page?.excerpt"
        :last="!hasTail && i === visible.length - 1"
        :enter="animate"
        :delay="Math.min(i, 6) * 0.1"
      />
      <WebSourceNode
        v-if="hasTail"
        last
        :enter="animate"
        :delay="Math.min(visible.length, 6) * 0.1"
      >
        <template #line>
          <button
            type="button"
            class="wsrch__more"
            :aria-expanded="expanded ? 'true' : 'false'"
            @click="toggleMore"
          >
            <template v-if="!expanded">
              <span class="wsrch__stack" aria-hidden="true">
                <WebFavicon
                  v-for="h in hidden.slice(0, 3)"
                  :key="h.url"
                  class="wsrch__stack-face"
                  :host="h.host"
                  :size="16"
                  round
                />
              </span>
              Show {{ hidden.length }} more
            </template>
            <template v-else>Show fewer</template>
          </button>
        </template>
      </WebSourceNode>
    </template>
  </div>
</template>

<style scoped>
.wsrch {
  padding-bottom: 4px;
}

/* ── Placeholder branches, while the search is out ──────────────────────────── */
.wsrch__ghost-line {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  animation: wsrch-breathe 1.4s ease-in-out infinite;
  animation-delay: calc(var(--i) * 160ms);
}
.wsrch__ghost-face {
  flex: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  background: color-mix(in srgb, var(--ink) 8%, transparent);
}
.wsrch__ghost-bar {
  width: calc(64% - var(--i) * 10%);
  height: 7px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
}
.wsrch__ghost :deep(.wnode__elbow),
.wsrch__ghost :deep(.wnode__trunk) {
  opacity: 0.55;
}

/* ── The folded tail ────────────────────────────────────────────────────────── */
.wsrch__more {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0;
  border: 0;
  background: transparent;
  color: var(--ink-soft);
  font-size: 12.5px;
  cursor: pointer;
  transition: color 0.15s ease-out;
}
.wsrch__more:hover {
  color: var(--ink);
}
.wsrch__more:focus-visible {
  outline-offset: 2px;
  border-radius: 6px;
}
.wsrch__stack {
  display: inline-flex;
}
.wsrch__stack-face {
  box-shadow: 0 0 0 2px var(--ground);
}
.wsrch__stack-face + .wsrch__stack-face {
  margin-left: -5px;
}

@keyframes wsrch-breathe {
  50% {
    opacity: 0.4;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wsrch__ghost-line {
    animation: none;
  }
}
</style>
