<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useTheme } from "~/composables/useTheme";
import {
  bakeLogo,
  drawThinkingLogo,
  type LogoPointSet,
  type LogoSource,
  type LogoState,
} from "~/utils/thinkingLogo";

const props = withDefaults(
  defineProps<{
    logo: LogoPointSet | LogoSource | string;
    state?: LogoState;
    size?: number;
    active?: boolean;
    tint?: string;
    speed?: number;
    tune?: Record<string, number | undefined>;
    ariaLabel?: string;
  }>(),
  {
    state: "thinking",
    size: 20,
    active: true,
    speed: 1,
    ariaLabel: "Active tool step",
  },
);

const canvas = ref<HTMLCanvasElement | null>(null);
const host = ref<HTMLElement | null>(null);
let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
let visible = true;
let reduced = false;
let dark = true;

const { scheme } = useTheme();
const resolvedPoints = shallowRef<LogoPointSet | null>(null);

async function resolvePoints(): Promise<void> {
  const l = props.logo;
  if (!l) {
    resolvedPoints.value = null;
    return;
  }
  if (typeof l === "object" && "version" in l && "p" in l) {
    resolvedPoints.value = l as LogoPointSet;
    return;
  }
  if (typeof l === "string") {
    // SVG or path
    const isSvg = l.trim().startsWith("<");
    const source: LogoSource = isSvg ? { svg: l } : { path: l, viewBox: 24 };
    try {
      resolvedPoints.value = await bakeLogo(source, { count: 80, shell: "dome" });
    } catch {
      resolvedPoints.value = null;
    }
    return;
  }
  try {
    resolvedPoints.value = await bakeLogo(l as LogoSource, { count: 80, shell: "dome" });
  } catch {
    resolvedPoints.value = null;
  }
}

function ancestorScheme(): boolean | null {
  let node: Element | null = host.value;
  while (node) {
    const local = node.getAttribute("data-scheme");
    if (local === "dark" || node.classList.contains("dark")) return true;
    if (local === "light" || node.classList.contains("light")) return false;
    node = node.parentElement;
  }
  return null;
}

function syncEnvironment(): void {
  dark = ancestorScheme() ?? scheme.value === "dark";
  reduced = typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function draw(time: number): void {
  const el = canvas.value;
  const points = resolvedPoints.value;
  if (!el || !ctx || !points) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const size = props.size;
  const width = Math.round(size * dpr);
  if (el.width !== width || el.height !== width) {
    el.width = width;
    el.height = width;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, size, size);

  const frozen = reduced || !props.active;
  drawThinkingLogo({
    ctx,
    size,
    time: frozen ? 4.2 : time / 1000,
    state: props.state,
    points,
    tint: props.tint,
    dark,
    reduced: frozen,
    speed: props.speed,
    tune: props.tune,
  });
}

function stop(): void {
  if (raf) cancelAnimationFrame(raf);
  raf = 0;
}

function loop(time: number): void {
  draw(time);
  if (props.active && visible && !reduced) raf = requestAnimationFrame(loop);
}

function sync(): void {
  stop();
  draw(performance.now());
  if (props.active && visible && !document.hidden && !reduced) raf = requestAnimationFrame(loop);
}

watch(() => props.logo, () => void resolvePoints(), { immediate: true });
watch(() => [props.active, props.state, props.size, props.tint, resolvedPoints.value], sync);

onMounted(() => {
  ctx = canvas.value?.getContext("2d") ?? null;
  syncEnvironment();
  const observer = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true;
    sync();
  });
  if (canvas.value) observer.observe(canvas.value);
  const onVisibility = sync;
  const onTheme = () => {
    syncEnvironment();
    sync();
  };
  document.addEventListener("visibilitychange", onVisibility);
  window.matchMedia("(prefers-reduced-motion: reduce)").addEventListener("change", onTheme);
  const mutations = new MutationObserver(onTheme);
  mutations.observe(document.documentElement, {
    attributes: true,
    subtree: true,
    attributeFilter: ["class", "data-theme", "data-scheme"],
  });
  sync();
  onBeforeUnmount(() => {
    stop();
    observer.disconnect();
    mutations.disconnect();
    document.removeEventListener("visibilitychange", onVisibility);
    window.matchMedia("(prefers-reduced-motion: reduce)").removeEventListener("change", onTheme);
  });
});
</script>

<template>
  <span ref="host" class="thinking-logo">
    <canvas
      ref="canvas"
      :style="{ width: `${size}px`, height: `${size}px` }"
      role="img"
      :aria-label="ariaLabel"
    />
  </span>
</template>

<style scoped>
.thinking-logo {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.thinking-logo canvas {
  display: block;
  pointer-events: none;
}
</style>
