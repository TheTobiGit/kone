/**
 * The resting face: a round body with two capsule eyes cut out of it.
 *
 * Everything here is a pure function of time. There is no internal state, so
 * pausing the loop, resuming it, or jumping to an arbitrary clock all produce
 * exactly the same frame — which is what lets the caller park its rAF while the
 * composer is open and pick up again without a visible jump.
 *
 * The eyes are painted on a SPHERE, not laid flat on a disc. Each eye gets the
 * sphere's tangent frame at its own position, projected orthographically; the
 * squash and the tilt of the far eye then fall out of the geometry instead of
 * being tuned by hand. That is the whole reason the face reads as a volume
 * rather than as two ovals on a circle.
 */

const TAU = Math.PI * 2;

const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const deg = (d: number) => (d * Math.PI) / 180;
/** Short round: roughly halves the weight of the path strings built each frame. */
const r2 = (v: number) => Math.round(v * 100) / 100;

/** Half-separation of the eyes across the sphere, in degrees. */
const EYE_SPLIT = 15.46;
/** Eye size at rest, in units of body radius. */
const EYE_W = 0.186;
const EYE_H = 0.412;

/** Head orientation at rest: turned up and to its right, tipped slightly. */
const REST_GAZE = { yaw: 28.49, pitch: 28.62, roll: -13 };

/**
 * Where the head goes when it is following the pointer.
 *
 * These are ABSOLUTE angles that replace the resting pose as the blend rises,
 * not offsets added on top of it — otherwise the resting yaw of +28deg would
 * ride along and the face would never actually look at anything. Wide enough to
 * read as attention rather than drift, narrow enough that neither eye crosses
 * the limb of the sphere and pops out of frame.
 */
const YAW_MAX = 16;
const PITCH_MAX = 13;
/** Held a little above the equator with the pointer centred: attentive, not vacant. */
const PITCH_REST = 10;

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

/**
 * The blink is a VERTICAL squash in screen space around the eye's centre — the
 * bounding width holds while the height collapses — not a shrink along the
 * capsule's own tilted axis. So it is composed after the tangent matrix, and
 * only touches the y outputs.
 */
const blinkScale = (lid: number) => 0.06 + 0.94 * clamp(lid);

type Vec3 = [number, number, number];

interface EyePose {
  x: number;
  y: number;
  /** tangent 2x2, in the sense of SVG matrix(a,b,c,d,e,f) */
  a: number;
  b: number;
  c: number;
  d: number;
  /** z of the normal: > 0 means this side of the sphere faces us */
  depth: number;
}

interface HeadGaze {
  /** degrees, positive looks right */
  yaw: number;
  /** degrees, positive looks up */
  pitch: number;
  /** degrees, head tilt */
  roll: number;
}

/** Rotates two vectors of an orthonormal frame within their shared plane. */
function spin(u: Vec3, v: Vec3, angle: number): [Vec3, Vec3] {
  const c = Math.cos(angle);
  const s = Math.sin(angle);
  return [
    [u[0] * c + v[0] * s, u[1] * c + v[1] * s, u[2] * c + v[2] * s],
    [v[0] * c - u[0] * s, v[1] * c - u[1] * s, v[2] * c - u[2] * s],
  ];
}

/**
 * Head frame, then the two eye frames.
 * Screen axes: x right, y down, z toward the viewer.
 */
function eyePoses(gaze: HeadGaze, scale: number): [EyePose, EyePose] {
  let f: Vec3 = [0, 0, 1];
  let right: Vec3 = [1, 0, 0];
  let down: Vec3 = [0, 1, 0];

  // yaw: forward tips toward right
  [f, right] = spin(f, right, deg(gaze.yaw));
  // pitch: forward tips upward, so away from down
  [down, f] = spin(down, f, deg(gaze.pitch));
  // roll: the head leans within its own plane
  [right, down] = spin(right, down, deg(gaze.roll));

  const build = (side: number): EyePose => {
    const [ef, er] = spin(f, right, deg(EYE_SPLIT * side));
    return {
      x: ef[0] * scale,
      y: ef[1] * scale,
      a: er[0],
      b: er[1],
      c: down[0],
      d: down[1],
      depth: ef[2],
    };
  };

  return [build(-1), build(1)];
}

/** Stadium path centred on the origin: the eye shape. */
function capsulePath(w: number, h: number): string {
  const hw = Math.max(w, 0.01) / 2;
  const hh = Math.max(h, 0.01) / 2;
  const r = Math.min(hw, hh);
  return (
    `M${r2(-hw)} ${r2(-hh + r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw + r)} ${r2(-hh)}` +
    `L${r2(hw - r)} ${r2(-hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw)} ${r2(-hh + r)}` +
    `L${r2(hw)} ${r2(hh - r)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(hw - r)} ${r2(hh)}` +
    `L${r2(-hw + r)} ${r2(hh)}` +
    `A${r2(r)} ${r2(r)} 0 0 1 ${r2(-hw)} ${r2(hh - r)}Z`
  );
}

/** The body: an ellipse centred on `cx, cy`, drawn as a path so it can breathe. */
function bodyEllipse(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M${r2(cx - rx)} ${r2(cy)}` +
    `A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(cx + rx)} ${r2(cy)}` +
    `A${r2(rx)} ${r2(ry)} 0 0 1 ${r2(cx - rx)} ${r2(cy)}Z`
  );
}

export interface RenderedEye {
  d: string;
  matrix: string;
  alpha: number;
}

export interface FaceFrame {
  bodyPath: string;
  eyes: RenderedEye[];
}

export interface Aim {
  /** pointer offset from the face's centre, -1 to 1, right positive */
  nx: number;
  /** pointer offset, -1 to 1, screen-down positive */
  ny: number;
  /** how far the pointer commands the direction: 0 = resting pose only */
  mix: number;
}

export interface FaceOptions {
  /** Diameter of the body, in px. */
  size: number;
  aim?: Aim;
}

/**
 * One frame of the face at time `t`, in seconds.
 */
export function sampleFace(t: number, opt: FaceOptions): FaceFrame {
  const { size, aim } = opt;
  const R = size / 2;

  // Idle life. The body is all but still — a stable centre and a constant width
  // — so the liveliness lives in the gaze and the blinks, and the body gets only
  // enough to keep the image from looking frozen.
  const dYaw = loopNoise(t, 11.3, 0.4) * 5.5 + loopNoise(t, 3.7, 2.1) * 1.6;
  const dPitch = loopNoise(t, 9.1, 1.3) * 4.2 + loopNoise(t, 4.3, 0.7) * 1.3;
  const dRoll = loopNoise(t, 13.7, 3.2) * 2.2;
  const driftX = loopNoise(t, 7.9, 1.9) * 0.006;
  const driftY = loopNoise(t, 5.3, 0.3) * 0.007;
  // Only the height breathes; the width holds.
  const breath = 1 + Math.sin((t / 3.4) * TAU) * 0.005;
  const lid = blinkLid(t);

  const mix = aim ? clamp(aim.mix) : 0;
  const gaze: HeadGaze = {
    // The aim REPLACES the resting direction as the blend rises; the drift is
    // added after the blend so a following head still keeps its life.
    yaw: lerp(REST_GAZE.yaw, aim ? aim.nx * YAW_MAX : 0, mix) + dYaw,
    // pitch is positive upward while screen y runs down
    pitch: lerp(REST_GAZE.pitch, aim ? PITCH_REST - aim.ny * PITCH_MAX : 0, mix) + dPitch,
    // Roll follows nothing: the -13deg lean is the face's signature, and rolling
    // it with the pointer throws that away.
    roll: REST_GAZE.roll + dRoll,
  };

  const cx = R + driftX * R;
  const cy = R + driftY * R;

  const eyes: RenderedEye[] = [];
  const eyePath = capsulePath(EYE_W * R, EYE_H * R);
  for (const e of eyePoses(gaze, R)) {
    // Past the limb of the sphere the eye has turned away from us entirely.
    if (e.depth <= 0.02) continue;
    const k = blinkScale(lid);
    eyes.push({
      d: eyePath,
      matrix:
        `matrix(${r2(e.a)},${r2(e.b * k)},${r2(e.c)},${r2(e.d * k)},` +
        `${r2(cx + e.x)},${r2(cy + e.y)})`,
      // Fades out over the last sliver of the sphere instead of blinking off.
      alpha: r2(clamp(e.depth / 0.12)),
    });
  }

  return { bodyPath: bodyEllipse(cx, cy, R, R * breath), eyes };
}
