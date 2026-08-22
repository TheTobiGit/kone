<script setup lang="ts">
// The agent orb as a dot-globe: a lattice of small crisp points wrapped on a
// slowly-turning, rippling sphere. Points are laid out in equal-area latitude
// rings (count per ring ∝ cos(lat)) so the dots stay evenly spaced — a halftone
// weave rather than clumping at the poles. The near side reads strong, the far
// side sinks to a ghost, so the globe has real depth. There's no disc behind the
// dots: they ARE the orb, coloured to sit on the page — luminous grey on a dark
// ground, ink-grey on a light one. Monochrome throughout: no hue, only tone.
// Canvas 2D, no WebGL. Honours prefers-reduced-motion by holding the field
// still, and pauses its render loop whenever it's inactive or the tab is hidden.
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'

const props = withDefaults(defineProps<{
  size?: number
  /** Latitude rings pole-to-pole. Higher = denser weave. */
  rings?: number
  /** Dots on the equator (rings taper from this by cos(lat)). */
  density?: number
  /** 0 rest → 1 fully awake: brightens and speeds the spin. */
  energy?: number
  /** When false the render loop parks — e.g. while the orb is faded out. */
  active?: boolean
}>(), {
  size: 55,
  rings: 30,
  density: 54,
  energy: 0,
  active: true,
})

const canvas = ref<HTMLCanvasElement | null>(null)

// Bleed room around the visual orb so the rippling silhouette can bulge past the
// sphere's core edge without being clipped.
const PAD = 14

// A point is stored by its position on the sphere (lat/lon), not a frozen xyz,
// so the surface can be warped fresh every frame — the dots ride a soft,
// rippling membrane rather than a rigid cage. The projection buffer (`proj`)
// holds each point's warped screen-space position; it's reused across frames and
// re-sorted in place, so a full frame allocates nothing.
type P = { lat: number; lon: number }
type Proj = { x: number; y: number; z: number }
let pts: P[] = []
let proj: Proj[] = []

function buildPoints() {
  const out: P[] = []
  const R = props.rings
  for (let i = 0; i <= R; i++) {
    // Latitude from pole to pole, biased to skip the exact poles (a single dot
    // there reads as a defect).
    const lat = (-Math.PI / 2) + Math.PI * (i / R)
    const ringR = Math.cos(lat)
    const n = Math.max(1, Math.round(props.density * ringR))
    // Half-step offset per ring gives the dots a woven brick-lay instead of
    // straight meridians.
    const off = (i % 2) * 0.5
    for (let j = 0; j < n; j++) {
      const lon = ((j + off) / n) * Math.PI * 2
      out.push({ lat, lon })
    }
  }
  pts = out
  proj = out.map(() => ({ x: 0, y: 0, z: 0 }))
}

let raf = 0
// Motion runs off an accumulated phase (not raw elapsed time) so changing the
// speed mid-flight — e.g. easing down when a turn starts — never jumps.
let phase = 0
let last = 0
let ctx: CanvasRenderingContext2D | null = null
const reduced = typeof window !== 'undefined'
  && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

// The particles ARE the orb — there's no disc behind them, so they're toned to
// read against the page: luminous grey on a dark ground, ink-grey on a light
// one. The scheme comes from the theme, not the OS, so a forced light or dark
// appearance re-tones the orb; reading it per frame keeps it live for free.
const { scheme } = useTheme()

function draw(now: number) {
  const el = canvas.value
  if (!el || !ctx) return
  if (!last) last = now
  const e = Math.max(0, Math.min(1, props.energy))
  // Busy = working, so it slows to a calm, deliberate turn rather than speeding
  // up. dt is clamped so a resume after a pause doesn't lurch forward.
  const speed = 1 - e * 0.62
  phase += Math.min(0.05, (now - last) / 1000) * speed
  last = now
  const time = phase

  const dpr = Math.min(window.devicePixelRatio || 1, 2)
  const S = props.size
  // The canvas is drawn larger than the visual orb so the flexing silhouette can
  // bulge past the sphere's core without being sliced — no hard circular clip.
  const box = S + PAD * 2
  const px = Math.round(box * dpr)
  if (el.width !== px) {
    el.width = px
    el.height = px
  }

  ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
  ctx.clearRect(0, 0, box, box)

  const cx = box / 2
  const cy = box / 2
  const breathe = 1 + Math.sin(time * 1.1) * 0.03
  const rad = (S / 2) * breathe

  // A live tumble, not a flat spin: it turns on its axis, nods, and gives a
  // slow roll, the three at different periods so it never repeats obviously.
  // (The busy slow-down is already baked into `phase`, so the rates are fixed.)
  // Reduced-motion freezes it at a pleasant three-quarter angle.
  const spin = reduced ? 0.7 : time * 0.55
  const tilt = reduced ? -0.5 : -0.45 + Math.sin(time * 0.6) * 0.32
  const roll = reduced ? 0 : Math.sin(time * 0.37) * 0.09
  const cosT = Math.cos(tilt)
  const sinT = Math.sin(tilt)
  const cosR = Math.cos(roll)
  const sinR = Math.sin(roll)

  // Warp amplitude — how much the membrane flexes.
  const amp = 0.11

  // Warp each point onto the flexing membrane and stash its screen position in
  // the reusable buffer (no per-frame allocation), then depth-sort back-to-front
  // so near dots paint over far ones.
  for (let k = 0; k < pts.length; k++) {
    const p = pts[k]!
    // Longitudinal flow: bands slide back and forth at a latitude-dependent
    // rate, so the weave shears and breathes instead of turning as one rigid
    // shell. The global spin rides on top.
    const lon = p.lon + spin + 0.22 * Math.sin(time * 0.7 + p.lat * 2.3)
    // Layered sinusoids stand in for noise: the local radius swells and dents,
    // giving the surface its flexible, liquid ripple.
    const warp = 1 + amp * (
      0.55 * Math.sin(p.lon * 3 + time * 1.35)
      + 0.35 * Math.sin(p.lat * 4 - time * 1.7)
      + 0.30 * Math.sin((p.lon + p.lat) * 2 + time * 0.9)
    )
    const cl = Math.cos(p.lat) * warp
    const bx = Math.cos(lon) * cl
    const by = Math.sin(p.lat) * warp
    const bz = Math.sin(lon) * cl

    // Nod about X, then roll the whole thing in-plane about Z.
    const y2 = by * cosT - bz * sinT
    const q = proj[k]!
    q.z = by * sinT + bz * cosT
    q.x = bx * cosR - y2 * sinR
    q.y = bx * sinR + y2 * cosR
  }
  proj.sort((a, b) => a.z - b.z)

  // On dark: dots glow, so ADD their light (lighter). On light: dots are ink, so
  // paint them normally over the page (source-over) — no glow, no shadow disc.
  const isDark = scheme.value === 'dark'
  ctx.globalCompositeOperation = isDark ? 'lighter' : 'source-over'
  for (const q of proj) {
    const depth = (q.z + 1) / 2 // 0 far → 1 near
    const sx = cx + q.x * rad
    const sy = cy + q.y * rad
    const dot = 0.5 + depth * 0.7 // px radius, near dots a touch fatter
    let L: number
    let alpha: number
    if (isDark) {
      // Facing side near-white and bright; far side a faint ghost.
      L = Math.min(99, 88 + depth * 10 + e * 2)
      alpha = (0.06 + Math.pow(depth, 1.6) * 0.9) * (0.7 + e * 0.4)
    } else {
      // Deep ink on the light page: near dots dark and solid, far dots lift
      // toward the page so the sphere still has depth.
      L = 40 + (1 - depth) * 30 - e * 3
      alpha = (0.18 + Math.pow(depth, 1.4) * 0.72) * (0.85 + e * 0.15)
    }
    // Monochrome: neutral oklab (zero chroma), tone carried entirely by L/alpha.
    ctx.fillStyle = `oklab(${L}% 0 0 / ${alpha})`
    ctx.beginPath()
    ctx.arc(sx, sy, dot, 0, Math.PI * 2)
    ctx.fill()
  }
  ctx.globalCompositeOperation = 'source-over'
}

// ── render loop ─────────────────────────────────────────────────────────────
// Parked whenever the orb is inactive (faded out) or the tab is hidden, so an
// off-screen orb costs nothing. Resuming rebases the clock so the animation
// picks up smoothly rather than jumping by the elapsed pause.
function loop(now: number) {
  draw(now)
  raf = requestAnimationFrame(loop)
}
function shouldRun() {
  return props.active && !(typeof document !== 'undefined' && document.hidden)
}
function play() {
  if (raf || !shouldRun()) return
  last = 0
  raf = requestAnimationFrame(loop)
}
function pause() {
  if (!raf) return
  cancelAnimationFrame(raf)
  raf = 0
}
function sync() {
  if (shouldRun()) play()
  else pause()
}

watch([() => props.rings, () => props.density], buildPoints)
watch(() => props.active, sync)

onMounted(() => {
  buildPoints()
  ctx = canvas.value?.getContext('2d') ?? null
  document.addEventListener('visibilitychange', sync)
  play()
})
onBeforeUnmount(() => {
  pause()
  document.removeEventListener('visibilitychange', sync)
})
</script>

<template>
  <!-- The canvas is drawn PAD px larger than the visual orb on every side so the
       flexing silhouette can bulge out; a negative margin keeps it centred over
       the orb's footprint without affecting layout. -->
  <canvas
    ref="canvas"
    class="particle-orb"
    :style="{
      width: size + PAD * 2 + 'px',
      height: size + PAD * 2 + 'px',
      margin: -PAD + 'px',
    }"
    aria-hidden="true"
  />
</template>

<style scoped>
.particle-orb {
  display: block;
  pointer-events: none;
}
</style>
