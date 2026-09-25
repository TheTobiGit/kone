<script setup lang="ts">
import { computed } from "vue";

// The head of the settings root: who this is, as a card rather than a row. It
// opens the profile page, same as the Profile row it replaces. The identity
// lives here because it's the one setting about the person rather than the tool.
//
// The drawing behind it is ambient, not information. A few contour lines drift
// slowly past, one of them in the accent, and a ring turns around the avatar
// with a mote on it. It moves slowly enough to stay out of the way, and holds
// still under prefers-reduced-motion.

defineProps<{ tabbable: boolean }>();
const emit = defineEmits<{ open: [] }>();

const { name, handle, initial, image, avatarStyle } = useProfile();

// A greeting keyed to the hour: it makes the card read as addressed to someone
// rather than as a form field.
const greeting = computed(() => {
  const h = new Date().getHours();
  if (h < 5) return "Up late";
  if (h < 12) return "Good morning";
  if (h < 18) return "Good afternoon";
  return "Good evening";
});

// A smooth wave three times the card's width, built from one quadratic hump and
// its reflections (T), so it has no seams. The period divides 160, so sliding it
// 160 left is a seamless loop; the card shows the first 160. The extra width
// covers the hover boost, which slides a further 160 on top of the drift.
function wave(y: number, amp: number, period: number): string {
  const half = period / 2;
  let d = `M 0 ${y} Q ${half / 2} ${y - amp} ${half} ${y}`;
  for (let x = half * 2; x <= 480; x += half) d += ` T ${x} ${y}`;
  return d;
}
const contours = [
  { d: wave(8, 4, 80), cls: "c1" },
  { d: wave(20, 6, 160), cls: "c2" },
  { d: wave(31, 5, 80), cls: "c3 accent" },
  { d: wave(43, 7, 160), cls: "c4" },
  { d: wave(53, 4, 80), cls: "c5" },
];
</script>

<template>
  <button
    type="button"
    class="hero group"
    :tabindex="tabbable ? 0 : -1"
    aria-label="Open profile settings"
    @click="emit('open')"
  >
    <svg class="hero__art" viewBox="0 0 160 60" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g v-for="(c, i) in contours" :key="i" class="lane" :class="c.cls">
        <g class="boost">
          <path :d="c.d" />
        </g>
      </g>
    </svg>

    <span class="hero__avatar-wrap" aria-hidden="true">
      <svg class="hero__orbit" viewBox="0 0 60 60">
        <circle class="ring" cx="30" cy="30" r="27" pathLength="100" />
        <g class="mote">
          <g class="boost">
            <circle cx="30" cy="3" r="2.4" />
          </g>
        </g>
      </svg>
      <span class="hero__avatar" :style="avatarStyle">
        <template v-if="!image">{{ initial }}</template>
      </span>
    </span>

    <span class="hero__text">
      <span class="hero__greet">{{ greeting }}</span>
      <span class="hero__name">{{ name || "You" }}</span>
      <span v-if="handle" class="hero__handle">@{{ handle }}</span>
    </span>

    <svg class="hero__go" viewBox="0 0 16 16" aria-hidden="true">
      <path d="M6 3.5 10.5 8 6 12.5" />
    </svg>
  </button>
</template>

<style scoped>
.hero {
  --ease: cubic-bezier(0.22, 1, 0.36, 1);
  position: relative;
  display: flex;
  align-items: center;
  gap: 14px;
  width: 100%;
  padding: 16px 14px 16px 16px;
  border-radius: 18px;
  overflow: hidden;
  isolation: isolate;
  text-align: left;
  cursor: pointer;
  background: linear-gradient(
    150deg,
    color-mix(in srgb, var(--raised) 92%, var(--accent)) 0%,
    var(--raised) 55%
  );
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--ink) 7%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent);
  transition:
    transform 420ms cubic-bezier(0.34, 1.56, 0.64, 1),
    box-shadow 480ms var(--ease);
}
.hero:hover {
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--accent) 22%, transparent),
    0 1px 2px color-mix(in srgb, var(--ink) 5%, transparent);
}
.hero:active {
  transform: scale(0.985);
}
.hero:focus-visible {
  outline: none;
  box-shadow:
    inset 0 0 0 1px color-mix(in srgb, var(--accent) 30%, transparent),
    0 0 0 2px color-mix(in srgb, var(--ink) 32%, transparent);
}

/* ── the drifting contours ─────────────────────────────────────────────────── */
.hero__art {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  z-index: -1;
  pointer-events: none;
  -webkit-mask-image: linear-gradient(90deg, transparent 18%, #000 70%);
  mask-image: linear-gradient(90deg, transparent 18%, #000 70%);
}
.lane path {
  fill: none;
  stroke: color-mix(in srgb, var(--ink) 9%, transparent);
  stroke-width: 1;
}
.lane.accent path {
  stroke: color-mix(in srgb, var(--accent) 45%, transparent);
  stroke-width: 1.2;
}
.lane {
  animation: drift var(--dur, 18s) linear infinite var(--dir, normal);
}
.c1 { --dur: 22s; }
.c2 { --dur: 16s; --dir: reverse; }
.c3 { --dur: 13s; }
.c4 { --dur: 19s; --dir: reverse; }
.c5 { --dur: 25s; }
@keyframes drift {
  to {
    transform: translateX(-160px);
  }
}
/* Pointer on the card: the lines quicken, as if the card leaned into it. The
   extra speed is a second drift layered on top that only runs while hovered.
   Changing the base animation's duration instead would make every line jump to
   a new position; pausing and resuming a layer keeps them where they are. */
.lane .boost {
  animation: drift calc(var(--dur, 18s) * 0.82) linear infinite var(--dir, normal) paused;
}
.hero:hover .boost {
  animation-play-state: running;
}

/* ── avatar and its orbit ──────────────────────────────────────────────────── */
.hero__avatar-wrap {
  position: relative;
  display: grid;
  place-items: center;
  width: 52px;
  height: 52px;
  flex-shrink: 0;
}
.hero__avatar {
  display: grid;
  place-items: center;
  width: 42px;
  height: 42px;
  border-radius: 999px;
  font-size: 17px;
  font-weight: 600;
  letter-spacing: -0.01em;
  animation: pop-in 560ms cubic-bezier(0.34, 1.56, 0.64, 1) 80ms both;
}
@keyframes pop-in {
  from {
    transform: scale(0.6);
    opacity: 0;
  }
}
.hero__orbit {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.ring {
  fill: none;
  stroke: color-mix(in srgb, var(--ink) 16%, transparent);
  stroke-width: 1;
  stroke-dasharray: 2 4;
  transform-origin: 30px 30px;
  animation: spin 40s linear infinite;
}
.mote {
  transform-origin: 30px 30px;
  animation: spin 7s linear infinite;
}
.mote .boost {
  transform-origin: 30px 30px;
  animation: spin 3.2s linear infinite paused;
}
.mote circle {
  fill: var(--accent);
  filter: drop-shadow(0 0 3px color-mix(in srgb, var(--accent) 70%, transparent));
}
@keyframes spin {
  to {
    transform: rotate(360deg);
  }
}

/* ── words ─────────────────────────────────────────────────────────────────── */
.hero__text {
  display: flex;
  min-width: 0;
  flex: 1;
  flex-direction: column;
}
.hero__greet {
  font-size: 10px;
  font-weight: 500;
  text-transform: uppercase;
  letter-spacing: 0.08em;
  color: var(--accent);
  animation: rise 520ms var(--ease) 120ms both;
}
.hero__name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 17px;
  font-weight: 600;
  line-height: 1.25;
  letter-spacing: -0.01em;
  color: var(--ink);
  animation: rise 520ms var(--ease) 180ms both;
}
.hero__handle {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 12px;
  color: var(--muted);
  animation: rise 520ms var(--ease) 240ms both;
}
@keyframes rise {
  from {
    opacity: 0;
    transform: translateY(5px);
  }
}

.hero__go {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  fill: none;
  stroke: var(--muted);
  stroke-width: 1.6;
  stroke-linecap: round;
  stroke-linejoin: round;
  transition:
    transform 420ms var(--ease),
    stroke 320ms var(--ease);
}
.hero:hover .hero__go,
.hero:focus-visible .hero__go {
  stroke: var(--accent);
  transform: translateX(3px);
}

@media (prefers-reduced-motion: reduce) {
  .hero,
  .hero * {
    animation: none !important;
    transition: none !important;
  }
}
</style>
