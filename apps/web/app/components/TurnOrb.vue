<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from "vue";
import { drawTurnOrb, type TurnOrbState } from "~/utils/thinkingOrb";

const props = withDefaults(
  defineProps<{ state: TurnOrbState; size?: number; active?: boolean; ariaLabel?: string }>(),
  { size: 20, active: true, ariaLabel: "Active turn" },
);

const canvas = ref<HTMLCanvasElement | null>(null);
const host = ref<HTMLElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let visible = true;
let reduced = false;
let dark = true;

function ancestorDark(): boolean | null {
  let node: Element | null = host.value;
  while (node) {
    const theme = node.getAttribute("data-theme");
    if (theme === "dark" || node.classList.contains("dark")) return true;
    if (theme === "light" || node.classList.contains("light")) return false;
    node = node.parentElement;
  }
  return null;
}

function syncEnvironment() {
  const treeTheme = ancestorDark();
  dark = treeTheme ?? window.matchMedia("(prefers-color-scheme: dark)").matches;
  reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function draw(time: number) {
  const el = canvas.value;
  if (!el || !ctx) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = props.size;
  const width = Math.round(size * dpr);
  if (el.width !== width || el.height !== width) {
    el.width = width;
    el.height = width;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);
  drawTurnOrb(ctx, size, reduced ? 0.6 : time / 1000, dark, props.state, reduced);
}

function stop() {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}
function loop(time: number) {
  draw(time);
  raf = requestAnimationFrame(loop);
}
function sync() {
  stop();
  draw(performance.now());
  if (props.active && visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop);
}

watch(() => [props.active, props.state, props.size], sync);

onMounted(() => {
  ctx = canvas.value?.getContext("2d") ?? null;
  syncEnvironment();
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    sync();
  });
  if (canvas.value) observer.observe(canvas.value);
  const onVisibility = sync;
  const onTheme = () => { syncEnvironment(); sync(); };
  document.addEventListener("visibilitychange", onVisibility);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", onTheme);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", onTheme);
  const mutations = new MutationObserver(onTheme);
  mutations.observe(document.documentElement, { attributes: true, subtree: true, attributeFilter: ["class", "data-theme"] });
  sync();
  onBeforeUnmount(() => {
    stop();
    observer.disconnect();
    mutations.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.matchMedia("(prefers-color-scheme: dark)").removeEventListener("change", onTheme);
    window.matchMedia("(prefers-reduced-motion: reduce)").removeEventListener("change", onTheme);
  });
});
</script>

<template>
  <span ref="host" class="turn-orb">
    <canvas ref="canvas" :style="{ width: `${size}px`, height: `${size}px` }" role="img" :aria-label="ariaLabel" />
  </span>
</template>

<style scoped>
.turn-orb { display: inline-flex; align-items: center; justify-content: center; flex: none; }
.turn-orb canvas { display: block; pointer-events: none; }
</style>
