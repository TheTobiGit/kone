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

import { liveliness, PITCH_MAX, PITCH_REST, YAW_MAX } from "./idleLife";

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
  const life = liveliness(t);

  const mix = aim ? clamp(aim.mix) : 0;
  const gaze: HeadGaze = {
    // The aim REPLACES the resting direction as the blend rises; the drift is
    // added after the blend so a following head still keeps its life.
    yaw: lerp(REST_GAZE.yaw, aim ? aim.nx * YAW_MAX : 0, mix) + life.dYaw,
    // pitch is positive upward while screen y runs down
    pitch: lerp(REST_GAZE.pitch, aim ? PITCH_REST - aim.ny * PITCH_MAX : 0, mix) + life.dPitch,
    // Roll follows nothing: the -13deg lean is the face's signature, and rolling
    // it with the pointer throws that away.
    roll: REST_GAZE.roll + life.dRoll,
  };

  const cx = R + life.driftX * R;
  const cy = R + life.driftY * R;

  const eyes: RenderedEye[] = [];
  const eyePath = capsulePath(EYE_W * R, EYE_H * R);
  for (const e of eyePoses(gaze, R)) {
    // Past the limb of the sphere the eye has turned away from us entirely.
    if (e.depth <= 0.02) continue;
    const k = blinkScale(life.lid);
    eyes.push({
      d: eyePath,
      matrix:
        `matrix(${r2(e.a)},${r2(e.b * k)},${r2(e.c)},${r2(e.d * k)},` +
        `${r2(cx + e.x)},${r2(cy + e.y)})`,
      // Fades out over the last sliver of the sphere instead of blinking off.
      alpha: r2(clamp(e.depth / 0.12)),
    });
  }

  return { bodyPath: bodyEllipse(cx, cy, R, R * life.breath), eyes };
}
