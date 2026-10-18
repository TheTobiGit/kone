<script setup lang="ts">
import { ref, watch } from "vue";
import { HugeiconsIcon } from "@hugeicons/vue";
import { ArrowUpRight01Icon } from "@hugeicons/core-free-icons";
import WebFavicon from "~/components/conversation/web/WebFavicon.vue";

// One source on the web trail, hung off the thread's own rail. The rail that
// joins a run of steps carries on down past the step's icon and turns into each
// source with a soft elbow, so a search's hits read as branches of the thread
// rather than a list dropped into it. A source carries its face, its title and
// its host; when the agent opens it, a ring turns round the face while the page
// loads, and the words it took away ink in underneath.

const props = withDefaults(
  defineProps<{
    url?: string;
    host?: string;
    title?: string;
    /** Has the agent opened this page — and is it still loading? */
    state?: "idle" | "reading" | "read" | "failed";
    /** The page's first real paragraph, once it's been read. */
    excerpt?: string;
    /** The last branch: the rail turns into it and stops. */
    last?: boolean;
    /** Draw the branch in (a source landing live), after `delay` seconds. */
    enter?: boolean;
    delay?: number;
  }>(),
  { url: undefined, host: "", title: "", state: "idle", excerpt: "", last: false, enter: false, delay: 0 },
);

// Only a read the reader watched happen inks in; a source that was already read
// when it mounted (a reloaded thread) just shows what the page said.
const watchedRead = ref(props.state === "reading");
watch(
  () => props.state,
  (s) => {
    if (s === "reading") watchedRead.value = true;
  },
);
</script>

<template>
  <div
    class="wnode"
    :class="[`wnode--${state}`, { 'wnode--last': last, 'wnode--enter': enter, 'wnode--ink': watchedRead }]"
    :style="{ '--d': `${delay}s` }"
  >
    <span v-if="!last" class="wnode__trunk" aria-hidden="true" />
    <span class="wnode__elbow" aria-hidden="true" />

    <!-- A branch can carry something other than a source (the folded tail, a
         placeholder while the search is out) by filling this slot. -->
    <slot name="line">
      <component
        :is="url ? 'a' : 'div'"
        class="wnode__line"
        :href="url"
        :target="url ? '_blank' : undefined"
        :rel="url ? 'noopener noreferrer' : undefined"
        :title="url"
      >
        <span class="wnode__face">
          <WebFavicon :host="host" :size="16" round />
        </span>
        <span class="wnode__title">{{ title }}</span>
        <span class="wnode__host">{{ host }}</span>
        <HugeiconsIcon
          v-if="url"
          class="wnode__out"
          :icon="ArrowUpRight01Icon"
          :size="13"
          :stroke-width="2"
        />
      </component>
    </slot>

    <p v-if="state === 'reading'" class="wnode__note wnode__note--reading">Reading the page</p>
    <p v-else-if="state === 'failed'" class="wnode__note">Couldn't open this page</p>
    <p v-else-if="state === 'read' && excerpt" class="wnode__excerpt">{{ excerpt }}</p>
  </div>
</template>

<style scoped>
.wnode {
  /* The rail's own ink, made opaque so a branch crossing the trunk never
     doubles up into a darker joint. */
  --rail: color-mix(in srgb, var(--ink) 12%, var(--ground));
  position: relative;
  /* Hold the excerpt's margin inside, so the trunk runs the node's full height. */
  display: flow-root;
  padding-left: 24px;
}

/* ── The rail, carried on and turned into the source ───────────────────────── */
.wnode__trunk {
  position: absolute;
  left: 7px;
  top: 0;
  bottom: 0;
  width: 1.5px;
  background: var(--rail);
}
.wnode__elbow {
  position: absolute;
  left: 7px;
  /* Reach up into the gap under the step's icon (or the branch above), so the
     line reads as one stroke from the icon down to this face. */
  top: -6px;
  width: 11px;
  height: 19px;
  border-left: 1.5px solid var(--rail);
  border-bottom: 1.5px solid var(--rail);
  border-bottom-left-radius: 7px;
}
/* The first branch reaches all the way up to the step's icon. */
.wnode:first-child .wnode__elbow {
  top: -10px;
  height: 23px;
}

/* ── The source ─────────────────────────────────────────────────────────────── */
.wnode__line {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 26px;
  min-width: 0;
  color: var(--ink-soft);
  font-size: 13px;
  letter-spacing: -0.005em;
  text-decoration: none;
}
a.wnode__line:hover .wnode__title,
.wnode--reading .wnode__title,
.wnode--read .wnode__title {
  color: var(--ink);
}
a.wnode__line:focus-visible {
  outline: 2px solid color-mix(in srgb, var(--hue, var(--ink)) 45%, transparent);
  outline-offset: 2px;
  border-radius: 6px;
}
.wnode__face {
  position: relative;
  display: inline-flex;
  flex: none;
}
/* Reading: a fine arc of the step's hue turns round the face. */
.wnode--reading .wnode__face::after {
  content: "";
  position: absolute;
  inset: -3px;
  border-radius: 50%;
  border: 1.5px solid color-mix(in oklab, var(--hue, var(--ink)) 85%, transparent);
  border-right-color: transparent;
  border-bottom-color: transparent;
  animation: wnode-turn 0.9s linear infinite;
}
/* Read: a dot of the hue settles on the face's shoulder. */
.wnode--read .wnode__face::after {
  content: "";
  position: absolute;
  right: -2px;
  bottom: -2px;
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: var(--hue, var(--ink));
  box-shadow: 0 0 0 2px var(--ground);
}
.wnode--ink.wnode--read .wnode__face::after {
  animation: wnode-pop 0.36s cubic-bezier(0.34, 1.56, 0.64, 1) backwards;
}
.wnode__title {
  flex: 0 1 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  transition: color 0.2s ease;
}
.wnode__host {
  flex: 0 10 auto;
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  color: var(--muted);
  font-size: 12px;
}
.wnode__out {
  flex: none;
  margin-left: -2px;
  color: var(--muted);
  opacity: 0;
  transform: translate(-2px, 2px);
  transition:
    opacity 0.16s ease,
    transform 0.16s ease;
}
a.wnode__line:hover .wnode__out,
a.wnode__line:focus-visible .wnode__out {
  opacity: 1;
  transform: none;
}

/* ── What the page said ─────────────────────────────────────────────────────── */
.wnode__excerpt,
.wnode__note {
  margin: -2px 0 6px 24px;
  font-size: 12.5px;
  line-height: 1.55;
  color: var(--muted);
}
.wnode__excerpt {
  display: -webkit-box;
  -webkit-box-orient: vertical;
  -webkit-line-clamp: 2;
  line-clamp: 2;
  overflow: hidden;
  text-wrap: pretty;
  /* The words ink in from the left as the page lands. */
}
.wnode--ink .wnode__excerpt {
  mask-image: linear-gradient(100deg, #000 45%, transparent 55%);
  mask-size: 250% 100%;
  mask-position: 0 0;
  animation: wnode-ink 0.9s cubic-bezier(0.22, 1, 0.36, 1) backwards;
}
.wnode__note--reading {
  width: fit-content;
  background: linear-gradient(
    90deg,
    var(--muted) 0%,
    var(--muted) 35%,
    var(--ink) 50%,
    var(--muted) 65%,
    var(--muted) 100%
  );
  background-size: 250% 100%;
  background-clip: text;
  -webkit-background-clip: text;
  color: transparent;
  animation: wnode-shimmer 1.6s linear infinite;
}

/* ── Landing live ───────────────────────────────────────────────────────────── */
.wnode--enter .wnode__elbow,
.wnode--enter .wnode__trunk {
  animation: wnode-draw 0.32s cubic-bezier(0.22, 1, 0.36, 1) var(--d) backwards;
}
.wnode--enter .wnode__line {
  animation: wnode-rise 0.42s cubic-bezier(0.22, 1, 0.36, 1) calc(var(--d) + 0.08s) backwards;
}

@keyframes wnode-draw {
  from {
    clip-path: inset(0 100% 100% 0);
  }
  to {
    clip-path: inset(0 0 0 0);
  }
}
@keyframes wnode-rise {
  from {
    opacity: 0;
    transform: translateX(-4px);
  }
}
@keyframes wnode-turn {
  to {
    transform: rotate(1turn);
  }
}
@keyframes wnode-pop {
  from {
    transform: scale(0);
  }
}
@keyframes wnode-ink {
  from {
    mask-position: 100% 0;
  }
}
@keyframes wnode-shimmer {
  from {
    background-position: 100% 0;
  }
  to {
    background-position: -150% 0;
  }
}
@media (prefers-reduced-motion: reduce) {
  .wnode--enter .wnode__elbow,
  .wnode--enter .wnode__trunk,
  .wnode--enter .wnode__line,
  .wnode--ink.wnode--read .wnode__face::after,
  .wnode--ink .wnode__excerpt,
  .wnode__note--reading {
    animation: none;
  }
  .wnode--reading .wnode__face::after {
    animation-duration: 2.4s;
  }
}
</style>
