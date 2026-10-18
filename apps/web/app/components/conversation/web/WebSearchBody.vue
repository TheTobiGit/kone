<script setup lang="ts">
import { computed, ref } from "vue";
import { motion } from "motion-v";
import { HugeiconsIcon } from "@hugeicons/vue";
import { Search01Icon, Tick02Icon } from "@hugeicons/core-free-icons";
import WebFavicon from "~/components/conversation/web/WebFavicon.vue";
import { webKey, type WebHit, type WebReadState } from "~/utils/webToolResult";

// A web search, drawn as the search it is: the query sits in its own field, and
// the hits land under it as the pages they are — a face, a title, a host. While
// the search runs the field types its caret and the list holds skeleton rows;
// when it settles the hits drop in one after another. Any hit the agent goes on
// to open lights up in place ("Reading" → "Read"), so the reader can see which
// of the sources the answer actually leans on.

const props = defineProps<{
  query: string;
  running: boolean;
  hits: WebHit[];
  /** Pages this turn has opened, keyed by `webKey`. */
  reads: ReadonlyMap<string, WebReadState>;
}>();

const SHOWN = 4;
const { cue } = useSound();

// Only a search the reader watched land gets the staggered entrance; one that
// was already settled when it mounted (a reloaded thread) just shows its hits.
const animate = props.running;
const expanded = ref(false);

const readOf = (h: WebHit) => props.reads.get(webKey(h.url));

const visible = computed(() =>
  expanded.value ? props.hits : props.hits.filter((h, i) => i < SHOWN || readOf(h) !== undefined),
);
const hidden = computed(() => props.hits.filter((h) => !visible.value.includes(h)));
const readCount = computed(() => props.hits.filter((h) => readOf(h) === "done").length);

function toggleMore(): void {
  expanded.value = !expanded.value;
  cue(expanded.value ? "expand" : "collapse");
}
</script>

<template>
  <div class="wsrch" :class="{ 'wsrch--running': running }">
    <div class="wsrch__field">
      <HugeiconsIcon class="wsrch__glass" :icon="Search01Icon" :size="13" :stroke-width="2" />
      <span class="wsrch__query">{{ query }}</span>
      <span v-if="running" class="wsrch__caret" aria-hidden="true" />
      <span v-else-if="hits.length" class="wsrch__count">
        {{ hits.length }} {{ hits.length === 1 ? "source" : "sources" }}<template v-if="readCount"> · {{ readCount }} read</template>
      </span>
    </div>

    <div class="wsrch__list">
      <template v-if="running && !hits.length">
        <div v-for="i in 3" :key="`sk${i}`" class="wsrch__skel" :style="{ '--i': i }" aria-hidden="true">
          <span class="wsrch__skel-fav" />
          <span class="wsrch__skel-line" />
          <span class="wsrch__skel-host" />
        </div>
      </template>

      <motion.a
        v-for="(h, i) in visible"
        :key="h.url"
        class="wsrch__hit"
        :class="{
          'wsrch__hit--reading': readOf(h) === 'running',
          'wsrch__hit--read': readOf(h) === 'done',
        }"
        :href="h.url"
        target="_blank"
        rel="noopener noreferrer"
        :title="h.url"
        :initial="animate ? { opacity: 0, y: 6 } : false"
        :animate="{ opacity: 1, y: 0 }"
        :transition="{ duration: 0.28, delay: animate ? Math.min(i, 6) * 0.06 : 0, ease: [0.22, 1, 0.36, 1] }"
      >
        <WebFavicon :host="h.host" />
        <span class="wsrch__title">{{ h.title }}</span>
        <span class="wsrch__host">{{ h.host }}</span>
        <span v-if="readOf(h) === 'running'" class="wsrch__mark wsrch__mark--reading">
          <span class="wsrch__pulse" aria-hidden="true" />Reading
        </span>
        <span v-else-if="readOf(h) === 'done'" class="wsrch__mark">
          <HugeiconsIcon :icon="Tick02Icon" :size="12" :stroke-width="2.2" />Read
        </span>
      </motion.a>

      <button
        v-if="hidden.length || expanded"
        type="button"
        class="wsrch__more"
        :aria-expanded="expanded ? 'true' : 'false'"
        @click="toggleMore"
      >
        <template v-if="!expanded">
          <span class="wsrch__stack" aria-hidden="true">
            <WebFavicon
              v-for="h in hidden.slice(0, 4)"
              :key="h.url"
              class="wsrch__stack-fav"
              :host="h.host"
              :size="14"
            />
          </span>
          {{ hidden.length }} more {{ hidden.length === 1 ? "source" : "sources" }}
        </template>
        <template v-else>Show fewer</template>
      </button>
    </div>
  </div>
</template>

<style scoped>
.wsrch {
  margin: 2px 0 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}

/* ── The query, in a field of its own ─────────────────────────────────────── */
.wsrch__field {
  position: relative;
  display: flex;
  align-items: center;
  gap: 7px;
  height: 28px;
  padding: 0 10px;
  border-radius: 8px;
  background: color-mix(in srgb, var(--ink) 3%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--ink) 6%, transparent);
  overflow: hidden;
  font-size: 12.5px;
  color: var(--ink);
}
/* A running search sweeps a band of its hue across the field. */
.wsrch--running .wsrch__field::after {
  content: "";
  position: absolute;
  inset: 0;
  background: linear-gradient(
    100deg,
    transparent 30%,
    color-mix(in oklab, var(--hue, var(--muted)) 14%, transparent) 50%,
    transparent 70%
  );
  background-size: 250% 100%;
  animation: wsrch-sweep 1.6s ease-in-out infinite;
  pointer-events: none;
}
.wsrch__glass {
  flex: none;
  color: var(--hue, var(--muted));
}
.wsrch__query {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wsrch__caret {
  flex: none;
  width: 1.5px;
  height: 14px;
  margin-left: -5px;
  background: var(--hue, var(--ink));
  animation: wsrch-blink 1s steps(1) infinite;
}
.wsrch__count {
  flex: none;
  margin-left: auto;
  padding-left: 8px;
  font-size: 11.5px;
  color: var(--muted);
  font-variant-numeric: tabular-nums;
}

/* ── The hits ──────────────────────────────────────────────────────────────── */
.wsrch__list {
  display: flex;
  flex-direction: column;
}
.wsrch__hit,
.wsrch__skel {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  padding: 0 6px 0 10px;
  border-radius: 6px;
}
.wsrch__hit {
  color: var(--ink-soft);
  text-decoration: none;
  font-size: 12.5px;
}
.wsrch__hit:hover {
  background: var(--hover);
  color: var(--ink);
}
.wsrch__hit:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hue, var(--ink)) 50%, transparent);
  outline-offset: -2px;
}
.wsrch__title {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.wsrch__host {
  flex: 0 1 auto;
  min-width: 0;
  max-width: 40%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-family: var(--font-mono);
  font-size: 11px;
  color: var(--muted);
}
.wsrch__hit--read .wsrch__title,
.wsrch__hit--reading .wsrch__title {
  color: var(--ink);
}
.wsrch__mark {
  flex: none;
  display: inline-flex;
  align-items: center;
  gap: 3px;
  height: 18px;
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--hue, var(--ink)) 12%, transparent);
  color: var(--hue, var(--ink));
  font-size: 11px;
  font-weight: 500;
}
.wsrch__pulse {
  width: 5px;
  height: 5px;
  margin-right: 2px;
  border-radius: 50%;
  background: currentColor;
  animation: wsrch-pulse 1s ease-in-out infinite;
}

/* Skeleton rows, while the search is out. */
.wsrch__skel-fav,
.wsrch__skel-line,
.wsrch__skel-host {
  flex: none;
  border-radius: 4px;
  background: color-mix(in srgb, var(--ink) 7%, transparent);
  animation: wsrch-fade 1.2s ease-in-out infinite;
  animation-delay: calc(var(--i) * 140ms);
}
.wsrch__skel-fav {
  width: 16px;
  height: 16px;
}
.wsrch__skel-line {
  flex: 0 1 auto;
  width: calc(78% - var(--i) * 12%);
  height: 8px;
}
.wsrch__skel-host {
  width: 54px;
  height: 7px;
  margin-left: auto;
}

/* "N more sources" — the folded tail, faces first. */
.wsrch__more {
  display: inline-flex;
  align-items: center;
  gap: 8px;
  align-self: flex-start;
  height: 26px;
  padding: 0 8px 0 10px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--muted);
  font-size: 12px;
  cursor: pointer;
}
.wsrch__more:hover {
  background: var(--hover);
  color: var(--ink);
}
.wsrch__stack {
  display: inline-flex;
}
.wsrch__stack-fav {
  box-shadow: 0 0 0 1.5px var(--ground);
}
.wsrch__stack-fav + .wsrch__stack-fav {
  margin-left: -4px;
}

@keyframes wsrch-sweep {
  from { background-position: 150% 0; }
  to { background-position: -100% 0; }
}
@keyframes wsrch-blink {
  50% { opacity: 0; }
}
@keyframes wsrch-fade {
  50% { opacity: 0.45; }
}
@keyframes wsrch-pulse {
  50% { opacity: 0.3; transform: scale(0.7); }
}
@media (prefers-reduced-motion: reduce) {
  .wsrch--running .wsrch__field::after,
  .wsrch__caret,
  .wsrch__skel-fav,
  .wsrch__skel-line,
  .wsrch__skel-host,
  .wsrch__pulse {
    animation: none;
  }
}
</style>
