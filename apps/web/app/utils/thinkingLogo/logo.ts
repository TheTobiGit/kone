import type { LogoPointSet, SeatMap } from "./cloud";
import type { Dot, ModeFrame, OrbFrame } from "./core";
import { angleDelta, clamp01, fibDir, finalizeFrame, hashD, makeProj, radiusScale, smoothE, vnoise } from "./core";

const TURN = Math.PI * 2;

/**
 * Smootherstep — zero first AND second derivative at both ends.
 */
export function smootherE(x: number): number {
  return x * x * x * (x * (x * 6 - 15) + 10);
}

/**
 * easeInOutExpo — the CSS `cubic-bezier(0.87, 0, 0.13, 1)` curve.
 */
export function expoInOut(x: number): number {
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  return x < 0.5 ? 2 ** (20 * x - 10) / 2 : (2 - 2 ** (-20 * x + 10)) / 2;
}

export function morphEase(x: number, expo: number): number {
  const smooth = x * x * x * (x * (x * 6 - 15) + 10);
  return smooth + (expoInOut(x) - smooth) * expo;
}

function cruise(x: number, edge: number): number {
  const a = Math.min(0.49, Math.max(0.001, edge));
  const v = 1 / (1 - a);
  if (x <= 0) return 0;
  if (x >= 1) return 1;
  if (x < a) {
    const u = x / a;
    return v * a * (u * u * u - (u * u * u * u) / 2);
  }
  if (x > 1 - a) {
    const u = (1 - x) / a;
    return 1 - v * a * (u * u * u - (u * u * u * u) / 2);
  }
  return v * (a * 0.5 + (x - a));
}

/**
 * Pair every logo dot with the sphere seat it flies home from.
 */
export function seatMap(points: LogoPointSet): SeatMap {
  const n = points.n;
  const byLogo = new Uint32Array(n);
  const bySeat = new Uint32Array(n);
  const logoAng = new Float32Array(n);
  const seatAng = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    byLogo[i] = i;
    bySeat[i] = i;
    logoAng[i] = Math.atan2(points.p[i * 3 + 1] ?? 0, points.p[i * 3] ?? 0);
    const [sx = 0, sy = 0] = fibDir(i, n);
    seatAng[i] = Math.atan2(sy, sx);
  }
  byLogo.sort((a, b) => (logoAng[a] ?? 0) - (logoAng[b] ?? 0));
  bySeat.sort((a, b) => (seatAng[a] ?? 0) - (seatAng[b] ?? 0));

  const seats = new Uint32Array(n);
  for (let k = 0; k < n; k++) {
    const lIdx = byLogo[k] ?? 0;
    seats[lIdx] = bySeat[k] ?? 0;
  }
  return seats;
}

export interface Beat {
  /** 0 = working form, 1 = the mark. */
  m: number;
  /** Whole turns completed; lands on an integer before the mark appears. */
  turns: number;
  /** Seconds into the working-form dwell — what `solve` and `scan` run on. */
  workT: number;
  local: number;
  cycle: number;
}

export function beatAt(
  t: number,
  dwell: number,
  morph: number,
  turns: number,
  settle: number,
  expo = 0.3,
): Beat {
  const cycle = dwell + morph * 2;
  const local = t % cycle;

  const spinSpan = dwell + morph * settle;
  const spun = turns * cruise(Math.min(1, local / spinSpan), 0.22);

  if (local < dwell) return { m: 0, turns: spun, workT: local, local, cycle };
  const intoMorph = local - dwell;
  if (intoMorph < morph) {
    return { m: morphEase(intoMorph / morph, expo), turns: spun, workT: -1, local, cycle };
  }
  return { m: morphEase(1 - (intoMorph - morph) / morph, expo), turns: spun, workT: -1, local, cycle };
}

export function dotAssembly(i: number, m: number, stagger: number): number {
  return smoothE(clamp01(m * (1 + stagger) - hashD(i, 3.1) * stagger));
}

export function inkOf(o: Record<string, number | undefined>, zx: number, edge: number): number {
  const far = o.inkFar ?? 0.6;
  const span = o.inkSpan ?? 0.5;
  const rim = o.inkRim ?? 0.16;
  return far - span * zx - rim * (1 - edge);
}

function emptyFrame(): OrbFrame {
  return { dots: [], lines: [] };
}

// --- Assemble: sphere ⇄ logo (Thinking) --------------------------------
export const frameLogoAssemble: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);

  const b = beatAt(
    t,
    o.dwell ?? 5.5,
    o.morph ?? 1.9,
    o.turns ?? 1,
    o.settle ?? 0.45,
    o.expo ?? 0.3,
  );
  const m = b.m;

  const pt = makeProj(TURN * b.turns, (o.tiltAmp ?? 0.34) * (1 - m), cx, cx, R);

  const stagger = o.stagger ?? 0;
  const arc = o.arc ?? 0;
  const churn = o.churn ?? 0.09;
  const sphereR = o.sphereR ?? 0.92;
  const share = o.haloShare ?? 0.12;

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const mi = stagger > 0 ? dotAssembly(i, m, stagger) : m;
    const seat = seats[i] ?? 0;
    const [fx = 0, fy = 0, fz = 0] = fibDir(seat, n);
    const wob = sphereR * (1 + churn * (vnoise(fx * 2 + t * 0.7, fz * 2) - 0.5) * 2);

    let lx = p[i * 3] ?? 0;
    let ly = p[i * 3 + 1] ?? 0;
    let lz = p[i * 3 + 2] ?? 0;

    let halo = 0;
    if (hashD(i, 6.7) < share) {
      halo = m;
      const osc = Math.sin(t * (o.haloRate ?? 0.9) + hashD(i, 8.3) * TURN);
      const out = 1 + (o.haloOut ?? 0.18) * (0.5 + 0.5 * osc) * halo;
      lx *= out;
      ly *= out;
      lz += (o.haloZ ?? 0.8) * osc * halo;
    }

    let x = fx * wob + (lx - fx * wob) * mi;
    let y = fy * wob + (ly - fy * wob) * mi;
    let z3 = fz * wob + (lz - fz * wob) * mi;
    if (arc > 0) {
      const bow = 1 + arc * Math.sin(Math.PI * mi);
      x *= bow;
      y *= bow;
      z3 *= bow;
    }

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);
    const travel = Math.sin(Math.PI * mi);
    const edge = e[i] ?? 0;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 0.55) + (o.rDepth ?? 1.5) * zx + (o.haloR ?? 0.22) * halo) * rs,
      white: inkOf(o, zx, edge * mi + (1 - mi)),
      a: 1 - (o.flightFade ?? 0.25) * travel,
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};

// --- Scan: sphere swept by meridian ⇄ logo (Searching) -----------------
export const frameLogoScan: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);

  const b = beatAt(
    t,
    o.dwell ?? 5.5,
    o.morph ?? 1.9,
    o.turns ?? 1,
    o.settle ?? 0.1,
    o.expo ?? 0.3,
  );
  const m = b.m;
  const g = 1 - m;

  const yaw = TURN * b.turns;
  const pt = makeProj(yaw, (o.tiltAmp ?? 0.34) * g, cx, cx, R);

  const sphereR = o.sphereR ?? 0.94;
  const width = o.scanWidth ?? 0.22;
  const scan = yaw + Math.PI / 2 + (o.scanSwing ?? 1.05) * Math.sin(t * (o.scanRate ?? 0.85));
  const dimBase = o.dimBase ?? 0.4;
  const ease = o.poleEase ?? 1.4;
  const arms = Math.max(3, Math.round(o.arms ?? 13));
  const armDepth = o.armDepth ?? 0.55;

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const [ax = 0, ay = 0, az = 0] = fibDir(seat, n);
    const lat = (ay < 0 ? -1 : 1) * Math.abs(ay) ** ease;
    const ring0 = Math.sqrt(Math.max(1e-9, 1 - ay * ay));
    const ring = Math.sqrt(Math.max(0, 1 - lat * lat)) / ring0;
    const fx = ax * ring;
    const fy = lat;
    const fz = az * ring;

    const tier = (seat % arms) % 3;
    const arm = 1 - armDepth * (tier === 0 ? 0 : tier === 1 ? 0.5 : 1);

    const gx = fx * sphereR;
    const gy = fy * sphereR;
    const gz = fz * sphereR;

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;

    const x = lx + (gx - lx) * g;
    const y = ly + (gy - ly) * g;
    const z3 = lz + (gz - lz) * g;

    const d = angleDelta(Math.atan2(fz, fx), scan);
    const boost = Math.exp(-(d * d) / width) * g;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);
    const edge = e[i] ?? 0;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 0.5) + (o.rDepth ?? 1.4) * zx * arm + (o.rBoost ?? 1.3) * boost) * rs,
      white:
        inkOf(o, zx, edge * m + (1 - m)) +
        (o.armInk ?? 0.16) * (1 - arm) * g -
        (o.scanInk ?? 0.3) * boost,
      a: 1 - (1 - dimBase) * g * (1 - Math.min(1, boost)),
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};

// --- Work: torus knot winding ⇄ logo (Working) -------------------------
export const frameLogoWork: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);

  const dwell = o.dwell ?? 5.5;
  const morph = o.morph ?? 1.9;
  const b = beatAt(t, dwell, morph, o.turns ?? 0, o.settle ?? 0.1, o.expo ?? 0.3);
  const m = b.m;
  const c = 1 - m;

  const pt = makeProj(
    (o.lean ?? 0.4) + (o.yawAmp ?? 0.3) * Math.sin(t * (o.yawRate ?? 0.26)) * c,
    (o.tilt ?? 0.4) * c,
    cx,
    cx,
    R,
  );

  const into = b.local - dwell;
  const prog =
    b.local < dwell ? b.local / dwell : into < morph ? 1 : clamp01(1 - (into - morph) / morph);

  const pKnot = o.p ?? 2;
  const qKnot = o.q ?? 3;
  const rTorus = o.rTorus ?? 0.68;
  const rTube = o.rTube ?? 0.28;
  const spin = t * (o.spin ?? 0.35);

  const head = prog * n;
  const feather = Math.max(1, n * (o.feather ?? 0.04));
  const headW = Math.max(1, n * (o.headWidth ?? 0.015));

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const u = (seat / n) * TURN * pKnot + spin;
    const v = (seat / n) * TURN * qKnot;

    const rad = rTorus + rTube * Math.cos(v);
    const kx = rad * Math.cos(u);
    const ky = rad * Math.sin(u);
    const kz = rTube * Math.sin(v);

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;
    const x = lx + (kx - lx) * c;
    const y = ly + (ky - ly) * c;
    const z3 = lz + (kz - lz) * c;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);

    const dist = seat - head;
    const ahead = dist > 0;
    const dHead = Math.abs(dist);
    const brightHead = Math.exp(-(dHead * dHead) / (headW * headW));
    const laid = ahead ? Math.exp(-(dist * dist) / (feather * feather)) : 1;
    const presence = m + c * laid;
    const edge = e[i] ?? 0;

    dots.push({
      x: px,
      y: py,
      z,
      r:
        ((o.rBase ?? 0.55) +
          (o.rDepth ?? 1.4) * zx +
          (o.headR ?? 0.55) * brightHead * c) *
        presence *
        rs,
      white:
        inkOf(o, zx, edge * m + (1 - m)) -
        (o.headInk ?? 0.3) * brightHead * c,
      a: presence,
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};
