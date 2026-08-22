/**
 * The geometry a bot is built from: a radial profile for the body, and a tangent
 * frame on a sphere for each eye.
 *
 * A body is described as `r(theta)` sampled at a FIXED number of angles, never
 * as a path. That is the load-bearing decision here: two profiles sampled at the
 * same angles have points that correspond one-to-one, so morphing between any
 * two shapes is a linear interpolation of radii and needs no path-morphing
 * library. The static mark drawn today doesn't morph, but every shape in the
 * catalogue is already expressed in the form that will.
 *
 * The eyes are placed on a SPHERE of radius 1, not laid flat on the outline.
 * Each one gets the sphere's tangent frame at its own position, projected
 * orthographically, so the squash of the far eye and its tilt fall out of the
 * geometry rather than being dialled in by hand. That is what makes the face
 * read as a volume instead of two capsules on a blob. Once the body stops being
 * a circle the eyes have to be pulled back to the outline's real radius in their
 * own direction (`radiusAtAngle`), or they sit outside a narrow shape entirely.
 *
 * Everything is a pure function of its arguments. There is no clock and no
 * state, so the same bot config always draws exactly the same mark.
 */

export const TAU = Math.PI * 2;

export const clamp = (v: number, lo = 0, hi = 1) => (v < lo ? lo : v > hi ? hi : v);
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const deg = (d: number) => (d * Math.PI) / 180;
/** Short round: roughly halves the weight of every path string built here. */
export const r2 = (v: number) => Math.round(v * 100) / 100;

/**
 * How many angles a profile is sampled at.
 *
 * 64 is enough that centred tangents alone give an outline smooth to the pixel
 * at any size a mark is drawn, while keeping the generated path short.
 */
export const PROFILE_SAMPLES = 64;

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * TAU);
const COS = ANGLES.map(Math.cos);
const SIN = ANGLES.map(Math.sin);

export interface Point {
  x: number;
  y: number;
}

/** Scale every radius so the largest becomes `max`. Keeps shapes at a
 *  comparable visual weight, which raw profiles are not: a squircle's longest
 *  radius is its diagonal, so it would otherwise read smaller than a circle of
 *  the same peak. */
export function normalizeProfile(radii: number[], max = 1): number[] {
  const peak = Math.max(...radii);
  if (peak <= 0) return radii;
  const k = max / peak;
  return radii.map((r) => r * k);
}

/** A profile projected to screen points, `scale` being the body's unit radius in
 *  viewBox units. */
export function toPoints(radii: number[], scale: number): Point[] {
  return radii.map((r, i) => ({
    x: r * (COS[i] ?? 0) * scale,
    y: r * (SIN[i] ?? 0) * scale,
  }));
}

/** A closed polyline as Catmull-Rom cubics — the smooth outline of a body. */
export function closedPath(pts: Point[], tension = 1 / 6): string {
  const n = pts.length;
  if (n < 3) return "";
  const first = pts[0]!;
  let d = `M${r2(first.x)} ${r2(first.y)}`;
  for (let i = 0; i < n; i++) {
    const p0 = pts[(i - 1 + n) % n]!;
    const p1 = pts[i]!;
    const p2 = pts[(i + 1) % n]!;
    const p3 = pts[(i + 2) % n]!;
    const c1x = p1.x + (p2.x - p0.x) * tension;
    const c1y = p1.y + (p2.y - p0.y) * tension;
    const c2x = p2.x - (p3.x - p1.x) * tension;
    const c2y = p2.y - (p3.y - p1.y) * tension;
    d += `C${r2(c1x)} ${r2(c1y)} ${r2(c2x)} ${r2(c2y)} ${r2(p2.x)} ${r2(p2.y)}`;
  }
  return `${d}Z`;
}

/**
 * An arbitrary polygon read back as a radial profile, by casting a ray from
 * `cx, cy` along each sampled angle.
 *
 * The door for shapes that don't express naturally as `r(theta)` — a capsule, a
 * rounded polygon. Run once when the catalogue is built, never per render.
 */
export function profileFromPolygon(poly: Point[], cx: number, cy: number): number[] {
  const radii = new Array<number>(PROFILE_SAMPLES).fill(0);
  const n = poly.length;
  for (let k = 0; k < PROFILE_SAMPLES; k++) {
    const dx = COS[k] ?? 0;
    const dy = SIN[k] ?? 0;
    let best = 0;
    for (let i = 0; i < n; i++) {
      const a = poly[i]!;
      const b = poly[(i + 1) % n]!;
      const ex = b.x - a.x;
      const ey = b.y - a.y;
      const den = dx * ey - dy * ex;
      if (Math.abs(den) < 1e-9) continue;
      const px = a.x - cx;
      const py = a.y - cy;
      // distance along the ray, and where the hit falls on the segment
      const t = (px * ey - py * ex) / den;
      const u = (px * dy - py * dx) / den;
      if (t > best && u >= 0 && u <= 1) best = t;
    }
    radii[k] = best;
  }
  return radii;
}

/** The convex hull of two circles — a capsule, at any angle. */
export function hullOfCircles(
  x1: number,
  y1: number,
  r1: number,
  x2: number,
  y2: number,
  r2v: number,
  steps = 96,
): Point[] {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const dist = Math.hypot(dx, dy) || 1e-6;
  // where the two common external tangents leave each circle
  const base = Math.atan2(dy, dx);
  const spread = Math.acos(Math.max(-1, Math.min(1, (r1 - r2v) / dist)));
  const pts: Point[] = [];
  const half = steps / 2;
  for (let i = 0; i <= half; i++) {
    const a = base + spread + ((TAU - 2 * spread) * i) / half;
    pts.push({ x: x1 + Math.cos(a) * r1, y: y1 + Math.sin(a) * r1 });
  }
  for (let i = 0; i <= half; i++) {
    const a = base - spread + (2 * spread * i) / half;
    pts.push({ x: x2 + Math.cos(a) * r2v, y: y2 + Math.sin(a) * r2v });
  }
  return pts;
}

/**
 * The profile's radius in an arbitrary direction, interpolated between the two
 * samples either side of it.
 *
 * This is what keeps anything sitting ON the body — an eye — inside it once the
 * outline stops being a circle. An eye placed at 0.62 of the unit radius lands
 * outside a shape whose edge is at 0.55 in that direction, and reads as a
 * floating capsule.
 */
export function radiusAtAngle(radii: number[], angle: number): number {
  const n = radii.length;
  const t = ((((angle / TAU) % 1) + 1) % 1) * n;
  const i = Math.floor(t);
  return lerp(radii[i % n] ?? 1, radii[(i + 1) % n] ?? 1, t - i);
}

/** Superellipse `|x/sx|^n + |y/sy|^n = 1`. `n = 2` is an ellipse; around 4 is a
 *  squircle. */
export function superellipseProfile(n: number, sx = 1, sy = 1): number[] {
  return ANGLES.map((_, i) => {
    const c = Math.abs((COS[i] ?? 0) / sx) ** n;
    const s = Math.abs((SIN[i] ?? 0) / sy) ** n;
    return (c + s) ** (-1 / n);
  });
}

/**
 * The radial profile of a UNION of discs: at each angle, the furthest of the
 * ray's intersections with any of them.
 *
 * Exact as long as the origin is inside the union, which is what produces the
 * lobes of a cloud with no boolean path operation anywhere.
 */
export function unionOfCirclesProfile(
  circles: Array<{ x: number; y: number; r: number }>,
): number[] {
  const out = new Array<number>(PROFILE_SAMPLES).fill(0);
  for (let i = 0; i < PROFILE_SAMPLES; i++) {
    const dx = COS[i] ?? 0;
    const dy = SIN[i] ?? 0;
    let best = 0;
    for (const c of circles) {
      const b = dx * c.x + dy * c.y;
      const disc = b * b - (c.x * c.x + c.y * c.y - c.r * c.r);
      if (disc < 0) continue;
      const t = b + Math.sqrt(disc);
      if (t > best) best = t;
    }
    out[i] = best;
  }
  return out;
}

/**
 * A polygon with rounded corners, as the Minkowski sum with a disc: every edge
 * is pushed `rc` outward and every vertex becomes an arc of radius `rc`. So the
 * vertices go in at the radius you want MINUS `rc`.
 *
 * Expects a clockwise polygon in screen axes (y running down).
 */
function roundedPolygon(verts: Point[], rc: number, arcSteps = 10): Point[] {
  const n = verts.length;
  const out: Point[] = [];
  const normal = (a: Point, b: Point) => {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // clockwise with y down puts the outward normal at (dy, -dx)
    return Math.atan2(-dx / len, dy / len);
  };
  for (let i = 0; i < n; i++) {
    const prev = verts[(i - 1 + n) % n]!;
    const cur = verts[i]!;
    const next = verts[(i + 1) % n]!;
    const a0 = normal(prev, cur);
    const a1 = normal(cur, next);
    let d = a1 - a0;
    while (d > Math.PI) d -= TAU;
    while (d < -Math.PI) d += TAU;
    for (let k = 0; k <= arcSteps; k++) {
      const a = a0 + (d * k) / arcSteps;
      out.push({ x: cur.x + Math.cos(a) * rc, y: cur.y + Math.sin(a) * rc });
    }
  }
  return out;
}

/** A regular polygon with rounded corners, inscribed in `radius`. */
export function regularPolygonProfile(
  sides: number,
  radius: number,
  rc: number,
  rotationDeg = 0,
): number[] {
  const rot = deg(rotationDeg);
  const verts = Array.from({ length: sides }, (_, i) => {
    // clockwise on screen: theta grows while y runs down
    const a = rot + (i / sides) * TAU;
    return { x: Math.cos(a) * (radius - rc), y: Math.sin(a) * (radius - rc) };
  });
  return profileFromPolygon(roundedPolygon(verts, rc), 0, 0);
}

/** A stadium centred on the origin: the exact shape of an eye. */
export function capsulePath(w: number, h: number): string {
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

// ── the eyes on their sphere ────────────────────────────────────────────────

type Vec3 = [number, number, number];

/** Half the separation of the eyes across the sphere, in degrees. */
export const EYE_SPLIT = 15.46;
/** Eye size at rest, in units of the body's unit radius. */
export const EYE_W = 0.186;
export const EYE_H = 0.412;

/** Head orientation at rest. The -13deg roll is the face's signature lean; the
 *  yaw and pitch put it slightly up and to its right. */
export const REST_GAZE: HeadGaze = { yaw: 28.49, pitch: 28.62, roll: -13 };

export interface HeadGaze {
  /** degrees, positive looks right */
  yaw: number;
  /** degrees, positive looks up */
  pitch: number;
  /** degrees, head tilt */
  roll: number;
}

export interface EyePose {
  x: number;
  y: number;
  /** tangent 2x2, in the sense of SVG `matrix(a,b,c,d,e,f)` */
  a: number;
  b: number;
  c: number;
  d: number;
  /** z of the normal: > 0 means this side of the sphere faces us */
  depth: number;
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
 * The head frame, then the two eye frames.
 *
 * Screen axes: x right, y down, z toward the viewer. Index 0 is the inner eye,
 * index 1 the outer one — which is why an expression can hand them different
 * sizes and get a lopsided face rather than a mirrored one.
 */
export function eyePoses(gaze: HeadGaze, scale: number, split = EYE_SPLIT): [EyePose, EyePose] {
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
    const [ef, er] = spin(f, right, deg(split * side));
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

/** A half-closed lid as a vertical squash factor. Never quite zero, so a shut
 *  eye stays a line rather than vanishing. */
export function lidScale(open: number): number {
  return 0.06 + 0.94 * clamp(open);
}
