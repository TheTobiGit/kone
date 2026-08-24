<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, useId, watch } from "vue";
import { BotEngine, type BotFrame } from "~/lib/bloub/engine";
import { DEMI_VIEWBOX, RAYON } from "~/lib/bloub/repere";
import type { StateId } from "~/lib/bloub/states";

// The attention orb: one bloub state, played or frozen. The parent picks the
// state (`notify` while a blocked thread is fresh, `exclaim` once it's gone
// stale) and the hue; this only draws it. Body is one ink shape with the eyes
// punched out as holes, so it reads on any surface. No arcs, no burst — the
// two attention states never use them.
const props = withDefaults(
  defineProps<{
    state?: Extract<StateId, "notify" | "exclaim" | "idle">;
    size?: number;
    playing?: boolean;
    frozenAt?: number;
    /** Pastille fill — the needs-a-human hue (amber `--warn`), deliberately
     *  distinct from the accent the working orb wears. */
    hue?: string;
    /** Body fill. Inherits text colour so a parent can tone it per surface. */
    ink?: string;
    ariaLabel?: string;
  }>(),
  {
    state: "notify",
    size: 44,
    playing: true,
    frozenAt: 1.2,
    hue: "var(--warn, #c99b45)",
    ink: "currentColor",
    ariaLabel: "Waiting for you",
  },
);

const VB = DEMI_VIEWBOX;
const maskId = `bloub-${useId()}`;

const host = ref<HTMLElement | null>(null);
const frame = ref<BotFrame | null>(null);

const engine = new BotEngine(RAYON, props.state);
let raf = 0;
let start = 0;
let elapsed = props.frozenAt;
let visible = true;
let reduced = false;

/** Path dots (the "!" glyph) carry their own shape in unit-ball coords, so they
 *  scale by RAYON; round dots come pre-scaled from the engine. */
function dotAttrs(dot: BotFrame["dots"][number]) {
  const common = { fill: dot.color ?? props.ink, opacity: dot.opacity };
  return dot.d
    ? { ...common, d: dot.d, transform: `translate(${dot.x} ${dot.y}) rotate(${dot.rot ?? 0}) scale(${RAYON})` }
    : { ...common, cx: dot.x, cy: dot.y, r: dot.r };
}

// A settled indicator must not keep ticking off-screen: a blocked thread can sit
// there for minutes, and a frozen orb is enough to hold the signal. Reduced
// motion freezes it too — the pastille alone still says "you're needed".
function frozen(): boolean {
  return !props.playing || reduced || !visible || document.hidden;
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function loop(now: number) {
  elapsed = (now - start) / 1000;
  frame.value = engine.sample(elapsed);
  raf = requestAnimationFrame(loop);
}

function sync() {
  stop();
  if (frozen()) {
    elapsed = props.frozenAt;
    frame.value = engine.sample(elapsed);
    return;
  }
  start = performance.now() - elapsed * 1000;
  raf = requestAnimationFrame(loop);
}

watch(() => props.state, (id) => {
  engine.setState(id, elapsed);
  if (frozen()) frame.value = engine.sample(elapsed);
});
watch([() => props.playing, () => props.size], sync);

onMounted(() => {
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    sync();
  });
  if (host.value) observer.observe(host.value);
  const onEnv = () => {
    reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    sync();
  };
  document.addEventListener("visibilitychange", onEnv);
  const media = window.matchMedia("(prefers-reduced-motion: reduce)");
  media.addEventListener("change", onEnv);
  sync();
  onBeforeUnmount(() => {
    stop();
    observer.disconnect();
    document.removeEventListener("visibilitychange", onEnv);
    media.removeEventListener("change", onEnv);
  });
});
</script>

<template>
  <span ref="host" class="bloub-orb" :style="{ width: `${size}px`, height: `${size}px` }">
    <svg
      v-if="frame"
      :width="size"
      :height="size"
      :viewBox="`${-VB} ${-VB} ${VB * 2} ${VB * 2}`"
      role="img"
      :aria-label="ariaLabel"
    >
      <defs>
        <mask :id="maskId" maskUnits="userSpaceOnUse" :x="-VB" :y="-VB" :width="VB * 2" :height="VB * 2">
          <path :d="frame.bodyPath" fill="#fff" />
          <path
            v-for="(eye, i) in frame.eyes"
            :key="i"
            :d="eye.d"
            :transform="eye.matrix"
            :opacity="eye.alpha"
            fill="#000"
          />
          <circle v-if="frame.notch" :cx="frame.notch.x" :cy="frame.notch.y" :r="frame.notch.r" fill="#000" />
        </mask>
      </defs>

      <g :opacity="frame.bodyAlpha" :mask="`url(#${maskId})`">
        <rect :x="-VB" :y="-VB" :width="VB * 2" :height="VB * 2" :fill="ink" />
      </g>

      <component
        :is="dot.d ? 'path' : 'circle'"
        v-for="(dot, i) in frame.dots"
        :key="`d${i}`"
        v-bind="dotAttrs(dot)"
      />

      <circle v-if="frame.notif" :cx="frame.notif.x" :cy="frame.notif.y" :r="frame.notif.r" :fill="hue" />
    </svg>
  </span>
</template>

<style scoped>
.bloub-orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.bloub-orb svg {
  display: block;
  pointer-events: none;
  overflow: visible;
}
</style>
