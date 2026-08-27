<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, shallowRef, watch } from "vue";
import { useTheme } from "~/composables/useTheme";
import {
  bakeLogo,
  logoForHugeIcon,
  logoForToolFamily,
  type LogoPointSet,
  type LogoSource,
} from "~/utils/thinkingLogo";
import { drawTurnOrb, type TurnOrbState } from "~/utils/thinkingOrb";
import type { HugeIcon } from "~/utils/toolPresentation";

const props = withDefaults(
  defineProps<{
    state: TurnOrbState;
    size?: number;
    active?: boolean;
    ariaLabel?: string;
    icon?: HugeIcon | null;
    logo?: LogoPointSet | LogoSource | string;
    classic?: boolean;
  }>(),
  { size: 20, active: true, ariaLabel: "Active turn", classic: false },
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
  if (props.classic) {
    resolvedPoints.value = null;
    return;
  }
  if (props.logo) {
    const l = props.logo;
    if (typeof l === "object" && "version" in l && "p" in l) {
      // SAFETY: Object structure matches serialized LogoPointSet schema (contains version and point coordinates)
      resolvedPoints.value = l as LogoPointSet;
      return;
    }
    if (typeof l === "string") {
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
      // SAFETY: Logo prop is narrowed by prior branches to an object conforming to LogoSource
      resolvedPoints.value = await bakeLogo(l as LogoSource, { count: 80, shell: "dome" });
    } catch {
      resolvedPoints.value = null;
    }
    return;
  }
  if (props.icon) {
    const found = logoForHugeIcon(props.icon);
    if (found) {
      resolvedPoints.value = found;
      return;
    }
  }
  resolvedPoints.value = logoForToolFamily(props.state);
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

  const frozen = reduced || !props.active;
  drawTurnOrb(
    ctx,
    size,
    frozen ? 4.2 : time / 1000,
    dark,
    props.state,
    frozen,
    resolvedPoints.value,
    props.classic,
  );
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

watch(() => [props.state, props.icon, props.logo, props.classic], () => void resolvePoints(), {
  immediate: true,
});
watch(() => [props.active, props.state, props.size, props.classic, resolvedPoints.value], sync);

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
  <span ref="host" class="turn-orb">
    <canvas
      ref="canvas"
      :style="{ width: `${size}px`, height: `${size}px` }"
      role="img"
      :aria-label="ariaLabel"
    />
  </span>
</template>

<style scoped>
.turn-orb {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  flex: none;
}
.turn-orb canvas {
  display: block;
  pointer-events: none;
}
</style>
