/**
 * The idle life a resting face keeps: a slow wander of the gaze, blinks, a
 * breath. Pure in `t`, so pausing the loop, resuming it, or jumping the clock
 * all produce the same frame — which is what lets a composer park its rAF while
 * the card is open and pick up without a visible jump.
 *
 * Shared by the guest face and an agent's bot so the two beads on the composer
 * live the same way. The follow envelope lives here too: past these angles an
 * eye rides the limb of the sphere and starts to disappear, which reads as
 * looking away rather than at you.
 */

const TAU = Math.PI * 2;

export const YAW_MAX = 16;
export const PITCH_MAX = 13;
/** Held a little above the equator with the pointer centred: attentive, not vacant. */
export const PITCH_REST = 10;

/** Periodic 1D noise: loops seamlessly over `period`. */
function loopNoise(t: number, period: number, seed = 0): number {
  const p = (t / period) * TAU;
  return (
    0.55 * Math.sin(p + seed) +
    0.3 * Math.sin(2 * p + seed * 1.7 + 1.1) +
    0.15 * Math.sin(3 * p + seed * 2.3 + 2.4)
  );
}

/** Deterministic PRNG (mulberry32): same sequence every read. */
function createRng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Pre-drawn blink calendar, so blinking stays stateless and reproducible. */
const BLINKS: number[] = (() => {
  const rng = createRng(0x5eed);
  const out: number[] = [];
  let t = 1.4;
  while (t < 900) {
    out.push(t);
    // 1.9 to 4.6s apart, with the occasional double blink
    t += 1.9 + rng() * 2.7;
    if (rng() < 0.18) {
      out.push(t);
      t += 0.24;
    }
  }
  return out;
})();

const BLINK_DUR = 0.18;

function blinkLid(t: number): number {
  for (let i = 0; i < BLINKS.length; i++) {
    const start = BLINKS[i]!;
    if (t < start) break;
    const k = (t - start) / BLINK_DUR;
    if (k >= 0 && k <= 1) {
      // snaps shut, opens back a touch slower
      return k < 0.45 ? 1 - k / 0.45 : (k - 0.45) / 0.55;
    }
  }
  return 1;
}

export interface Liveliness {
  dYaw: number;
  dPitch: number;
  dRoll: number;
  /** 1 = open, 0 shut. */
  lid: number;
  driftX: number;
  driftY: number;
  breath: number;
}

/**
 * Offsets to add to a resting pose at time `t`.
 *
 * Periods coprime so the wander never quite repeats to the eye. The body is
 * all but still — a stable centre and a constant width — so the life lives in
 * the gaze and the blinks, and the body gets only enough to keep the image
 * from looking frozen.
 */
export function liveliness(t: number): Liveliness {
  return {
    dYaw: loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6,
    dPitch: loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3,
    dRoll: loopNoise(t, 13.7, 3.2) * 2.2,
    lid: blinkLid(t),
    driftX: loopNoise(t, 7.9, 1.9) * 0.006,
    driftY: loopNoise(t, 5.3, 0.3) * 0.007,
    // Only the height breathes; the width holds.
    breath: 1 + Math.sin((t / 3.4) * TAU) * 0.005,
  };
}
