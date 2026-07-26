<script setup lang="ts">
// The "working" orb — shown while the agent is composing and there's nothing to
// read yet. It's the *orbits* variant from orbs.jakubantalik.com ("Working…"),
// ported faithfully to Canvas 2D: a dozen randomly-oriented orbit rings, each
// traced by a spray of faint "ghost" dots with a few brighter particles running
// along it, the whole cloud yawing slowly. Grayscale like the reference —
// luminous grey on a dark ground, ink-grey on a light one, matching
// [[ParticleOrb]]. No WebGL.
// Honours prefers-reduced-motion (holds a still frame) and parks its render loop
// whenever it's inactive or the tab is hidden.
import { onBeforeUnmount, onMounted, ref, watch } from "vue";

const props = withDefaults(
  defineProps<{
    size?: number;
    /** Global rate. 1 = the reference "Working…" tempo. */
    speed?: number;
    /** When false the render loop parks — e.g. while faded out. */
    active?: boolean;
  }>(),
  { size: 44, speed: 1, active: true },
);

const canvas = ref<HTMLCanvasElement | null>(null);

// ── the orbits geometry (ported from the reference "working" drawer) ─────────
// A cheap sin-hash stands in for per-orbit randomness (same one the reference
// uses), so the ring layout is deterministic and evenly scattered.
function hash(a: number, b: number): number {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

// Reference "orbits" opts at the size-64 preset (speed baked into RATE below).
const ORBIT_N = 12; // rings
const GHOST_N = 40; // faint dots tracing each ring
const PARTICLES = 3; // bright dots orbiting each ring
const GHOST_R = 0.9;
const GHOST_A = 0.5;
const PART_R = 1.2;
const PART_R_DEPTH = 1.6;
const RS_POW = 0.6; // dot-radius falloff with canvas size
const R_MIN = 0.35;
const RATE = 1.885; // the reference "Working…" angular speed

// A projector: yaw about the vertical axis, pitch by a fixed tilt, drop to 2D.
// Returns [screenX, screenY, depth].
function projector(yaw: number, tilt: number, cx: number, cy: number) {
  const o = Math.sin(tilt);
  const u = Math.cos(tilt);
  const si = Math.sin(yaw);
  const co = Math.cos(yaw);
  return (x: number, y: number, z: number): [number, number, number] => {
    const p = x * co + z * si;
    const v = -x * si + z * co;
    const g = y * u - v * o;
    const w = y * o + v * u;
    return [cx + p, cy - g, w];
  };
}

type Dot = { x: number; y: number; z: number; r: number; depth: number; a: number; bright: boolean };

let dots: Dot[] = [];

function build(time: number, S: number): Dot[] {
  const cx = S / 2;
  const cy = S / 2;
  const R = (S / 2) * 0.82;
  const proj = projector(time * 0.12, 0.3, cx, cy);
  const rScale = (S / 300) ** RS_POW;
  const out: Dot[] = [];

  for (let g = 0; g < ORBIT_N; g++) {
    // Three hashes per orbit: radius, phase offset, speed/direction.
    const h1 = hash(g, 1.7);
    const h2 = hash(g, 5.2);
    const h3 = hash(g, 8.9);
    const rad = R * (0.45 + 0.52 * h1);
    // A random great-circle: its normal is a uniform point on the sphere.
    const theta = h1 * 2 * Math.PI;
    const phi = Math.acos(2 * h2 - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);
    // Two orthonormal tangents spanning that orbit's plane.
    let ex = -ny;
    let ey = nx;
    const ez = 0;
    const en = Math.max(1e-6, Math.sqrt(ex * ex + ey * ey));
    ex /= en;
    ey /= en;
    const jx = ny * ez - nz * ey;
    const jy = nz * ex - nx * ez;
    const jz = nx * ey - ny * ex;
    const spin = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

    // Ghost dots — the static ring outline.
    for (let k = 0; k < GHOST_N; k++) {
      const ang = (k / GHOST_N) * 2 * Math.PI;
      const px = (ex * Math.cos(ang) + jx * Math.sin(ang)) * rad;
      const py = (ey * Math.cos(ang) + jy * Math.sin(ang)) * rad;
      const pz = (ez * Math.cos(ang) + jz * Math.sin(ang)) * rad;
      const [sx, sy, sz] = proj(px, py, pz);
      const depth = (sz / rad + 1) / 2;
      out.push({
        x: sx,
        y: sy,
        z: sz,
        r: GHOST_R * rScale,
        depth,
        a: GHOST_A * (0.4 + 0.6 * depth),
        bright: false,
      });
    }
    // Particles — bright dots running along the ring.
    for (let k = 0; k < PARTICLES; k++) {
      const ang = time * spin + (k / PARTICLES) * 2 * Math.PI + h2 * 6;
      const px = (ex * Math.cos(ang) + jx * Math.sin(ang)) * rad;
      const py = (ey * Math.cos(ang) + jy * Math.sin(ang)) * rad;
      const pz = (ez * Math.cos(ang) + jz * Math.sin(ang)) * rad;
      const [sx, sy, sz] = proj(px, py, pz);
      const depth = (sz / rad + 1) / 2;
      out.push({
        x: sx,
        y: sy,
        z: sz,
        r: (PART_R + PART_R_DEPTH * depth) * rScale,
        depth,
        a: 1,
        bright: true,
      });
    }
  }
  return out;
}

// ── theme + motion ───────────────────────────────────────────────────────────
const darkMedia =
  typeof window !== "undefined" ? window.matchMedia("(prefers-color-scheme: dark)") : null;
let isDark = darkMedia?.matches ?? true;
const onTheme = (e: MediaQueryListEvent) => (isDark = e.matches);
const reduced =
  typeof window !== "undefined" &&
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches === true;

let ctx: CanvasRenderingContext2D | null = null;
let raf = 0;
// Motion runs off an accumulated phase (not raw elapsed time) so a pause/resume
// never lurches the cloud forward.
let phase = 0;
let last = 0;

function draw(now: number) {
  const el = canvas.value;
  if (!el || !ctx) return;
  if (!last) last = now;
  phase += Math.min(0.05, (now - last) / 1000) * RATE * Math.max(0, props.speed);
  last = now;
  const time = reduced ? 0.6 : phase;

  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  const S = props.size;
  const px = Math.round(S * dpr);
  if (el.width !== px) {
    el.width = px;
    el.height = px;
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, S, S);

  dots = build(time, S);
  dots.sort((p, q) => p.z - q.z); // back to front

  // On dark the dots glow (ADD their light); on light they're ink painted over
  // the page (source-over) — same idiom as ParticleOrb.
  ctx.globalCompositeOperation = isDark ? "lighter" : "source-over";
  for (const d of dots) {
    let L: number;
    let alpha: number;
    if (isDark) {
      L = 82 + d.depth * 14 + (d.bright ? 4 : 0);
      alpha = d.a * (0.14 + Math.pow(d.depth, 1.5) * 0.86);
    } else {
      L = 44 + (1 - d.depth) * 26 - (d.bright ? 4 : 0);
      alpha = d.a * (0.2 + Math.pow(d.depth, 1.4) * 0.7);
    }
    if (alpha < 0.02) continue;
    // Monochrome: neutral oklab (zero chroma), tone carried by L/alpha.
    ctx.fillStyle = `oklab(${L}% 0 0 / ${alpha})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, Math.max(R_MIN, d.r), 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalCompositeOperation = "source-over";
}

// ── render loop ───────────────────────────────────────────────────────────────
function loop(now: number) {
  draw(now);
  raf = requestAnimationFrame(loop);
}
function shouldRun() {
  return props.active && !(typeof document !== "undefined" && document.hidden) && !reduced;
}
function play() {
  if (raf || !shouldRun()) {
    if (!raf) draw(performance.now()); // reduced-motion / inactive: hold one frame
    return;
  }
  last = 0;
  raf = requestAnimationFrame(loop);
}
function pause() {
  if (!raf) return;
  cancelAnimationFrame(raf);
  raf = 0;
}
function sync() {
  shouldRun() ? play() : pause();
}

watch(() => props.active, sync);

onMounted(() => {
  ctx = canvas.value?.getContext("2d") ?? null;
  darkMedia?.addEventListener("change", onTheme);
  document.addEventListener("visibilitychange", sync);
  play();
});
onBeforeUnmount(() => {
  pause();
  darkMedia?.removeEventListener("change", onTheme);
  document.removeEventListener("visibilitychange", sync);
});
</script>

<template>
  <canvas
    ref="canvas"
    class="working-orb"
    :style="{ width: size + 'px', height: size + 'px' }"
    role="img"
    aria-label="Working…"
  />
</template>

<style scoped>
.working-orb {
  display: block;
  pointer-events: none;
}
</style>
