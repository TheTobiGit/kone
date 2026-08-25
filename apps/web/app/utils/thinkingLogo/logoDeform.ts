import type { Dot, ModeFrame, OrbFrame } from "./core";
import { clamp01, fibDir, finalizeFrame, hashD, makeProj, radiusScale, vnoise } from "./core";
import { beatAt, inkOf } from "./logo";

function emptyFrame(): OrbFrame {
  return { dots: [], lines: [] };
}

// --- Solving: Rubik cube solve ⇄ logo ---------------------------------
interface Move {
  axis: 0 | 1 | 2;
  lo: number;
  hi: number;
  ang: number;
}

function cubeSeat(i: number, n: number, half: number): [number, number, number] {
  const [x = 0, y = 0, z = 0] = fibDir(i, n);
  const m = Math.max(Math.abs(x), Math.abs(y), Math.abs(z)) || 1;
  return [(x / m) * half, (y / m) * half, (z / m) * half];
}

function makeCubeMoves(count: number, half: number): Move[] {
  const moves: Move[] = [];
  const band = (2 * half) / 3;
  for (let i = 0; i < count; i++) {
    const axis = Math.min(2, Math.floor(hashD(i, 2.3) * 3)) as 0 | 1 | 2;
    const lo = -half + band * Math.min(2, Math.floor(hashD(i, 5.9) * 3));
    const dir = hashD(i, 7.7) < 0.5 ? 1 : -1;
    moves.push({ axis, lo, hi: lo + band, ang: (dir * Math.PI) / 2 });
  }
  return moves;
}

function rotAxis(p: [number, number, number], axis: 0 | 1 | 2, a: number): [number, number, number] {
  const c = Math.cos(a);
  const s = Math.sin(a);
  if (axis === 0) return [p[0], p[1] * c - p[2] * s, p[1] * s + p[2] * c];
  if (axis === 1) return [p[0] * c + p[2] * s, p[1], -p[0] * s + p[2] * c];
  return [p[0] * c - p[1] * s, p[0] * s + p[1] * c, p[2]];
}

function applyCubeMoves(
  pt: [number, number, number],
  moves: Move[],
  activeMove: number,
  moveFrac: number,
): [number, number, number, boolean] {
  let cur: [number, number, number] = [pt[0], pt[1], pt[2]];
  let inActive = false;

  for (let m = 0; m < moves.length; m++) {
    const mv = moves[m];
    if (!mv) continue;
    const coord = cur[mv.axis];
    if (coord < mv.lo || coord > mv.hi) continue;

    if (m < activeMove) {
      cur = rotAxis(cur, mv.axis, mv.ang);
    } else if (m === activeMove) {
      inActive = true;
      cur = rotAxis(cur, mv.axis, mv.ang * moveFrac);
    }
  }
  return [cur[0], cur[1], cur[2], inActive];
}

export const frameLogoSolve: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const half = o.cubeHalf ?? 0.62;

  const dwell = o.dwell ?? 5.5;
  const b = beatAt(t, dwell, o.morph ?? 1.9, o.turns ?? 1, o.settle ?? 0.45, o.expo ?? 0.3);
  const m = b.m;
  const c = 1 - m;

  const pt = makeProj(Math.PI * 2 * b.turns, (o.tiltAmp ?? 0.36) * c, cx, cx, R);

  const moveCount = o.moveCount ?? 6;
  const solveProgress = clamp01(b.workT < 0 ? 1 : b.workT / dwell);
  const totalPhase = solveProgress * 2 * moveCount;
  const isForward = totalPhase < moveCount;
  const phaseInDir = isForward ? totalPhase : 2 * moveCount - totalPhase;
  const activeIdx = Math.min(moveCount - 1, Math.floor(phaseInDir));
  const activeFrac = clamp01(phaseInDir - activeIdx);
  const easedFrac = activeFrac * activeFrac * (3 - 2 * activeFrac);

  const moves = makeCubeMoves(moveCount, half);

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const cubePt = cubeSeat(seat, n, half);
    const [tx, ty, tz, inActive] = applyCubeMoves(cubePt, moves, activeIdx, easedFrac);

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;
    const x = lx + (tx - lx) * c;
    const y = ly + (ty - ly) * c;
    const z3 = lz + (tz - lz) * c;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);
    const edge = e[i] ?? 0;
    dots.push({
      x: px,
      y: py,
      z,
      r:
        ((o.rBase ?? 0.55) +
          (o.rDepth ?? 1.4) * zx +
          (inActive ? (o.rActive ?? 0.3) : 0) * c) *
        rs,
      white: inkOf(o, zx, edge * m + (1 - m)),
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};

// --- Listening: floating pulsing waveform volume ⇄ logo -----------------
export const frameLogoWave: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);

  const b = beatAt(t, o.dwell ?? 5.5, o.morph ?? 1.9, 0, o.settle ?? 0.45, o.expo ?? 0.3);
  const m = b.m;
  const c = 1 - m;

  const pt = makeProj(
    (o.yawAmp ?? 0.42) * Math.sin(t * (o.yawRate ?? 0.55)) * c,
    (o.tiltAmp ?? 0.26) * c,
    cx,
    cx,
    R,
  );

  const wide = o.wide ?? 1.12;
  const tall = o.tall ?? 0.5;
  const k1 = o.waveK ?? 3.1;
  const k2 = o.waveK2 ?? 6.7;
  const rate = o.waveRate ?? 1.9;
  const swing = o.swing ?? 0.52;

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const [fx = 0, fy = 0, fz = 0] = fibDir(seat, n);

    const w = Math.sin(fx * k1 - t * rate) * 0.62 + Math.sin(fx * k2 + t * rate * 0.55) * 0.38;
    const amp = 1 + swing * w;
    const lumpy = 1 + (o.lumps ?? 0.12) * (vnoise(fx * 2 + t * 0.35, fz * 2) - 0.5) * 2;

    const bx = fx * wide * lumpy;
    const by = fy * tall * lumpy * amp;
    const bz = fz * wide * lumpy;

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;
    const x = lx + (bx - lx) * c;
    const y = ly + (by - ly) * c;
    const z3 = lz + (bz - lz) * c;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);
    const loud = clamp01(w * 0.5 + 0.5);
    const edge = e[i] ?? 0;
    dots.push({
      x: px,
      y: py,
      z,
      r:
        ((o.rBase ?? 0.55) +
          (o.rDepth ?? 1.5) * zx +
          (o.loudR ?? 0.3) * loud * c) *
        rs,
      white: inkOf(o, zx, edge * m + (1 - m)) - (o.loudInk ?? 0.14) * loud * c,
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};

// --- Waiting: stacked breathing rings ⇄ logo ---------------------------
export const frameLogoWait: ModeFrame = (size, t, o, logo) => {
  if (!logo) return emptyFrame();
  const { p, e, n } = logo.points;
  const seats = logo.seats;
  const cx = size / 2;
  const R = (size / 2) * 0.82;
  const rs = radiusScale(size, o.rsPow ?? 0.6);

  const b = beatAt(t, o.dwell ?? 5.5, o.morph ?? 1.9, 0, o.settle ?? 0.1, o.expo ?? 0.3);
  const m = b.m;
  const c = 1 - m;

  const pt = makeProj(
    (o.yawAmp ?? 0.22) * Math.sin(t * (o.yawRate ?? 0.3)) * c,
    (o.tilt ?? 0.42) * c,
    cx,
    cx,
    R,
  );

  const rings = Math.max(3, Math.round(o.rings ?? 9));
  const perRing = Math.ceil(n / rings);

  const breath = Math.sin(t * (o.breatheRate ?? 0.75));
  const amp = o.breatheAmp ?? 0.2;
  const height = (o.height ?? 1.5) * (1 + amp * breath);
  const wide = (o.wide ?? 0.82) * (1 - amp * 0.72 * breath);
  const spin = t * (o.spin ?? 0.16);

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const ring = seat % rings;
    const u = rings > 1 ? ring / (rings - 1) - 0.5 : 0;

    const taper = Math.cos(u * Math.PI * (o.taper ?? 0.78));
    const rad = wide * taper;
    const ang = (Math.floor(seat / rings) / perRing) * Math.PI * 2 + spin;

    const bx = Math.cos(ang) * rad;
    const by = u * height;
    const bz = Math.sin(ang) * rad;

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;
    const x = lx + (bx - lx) * c;
    const y = ly + (by - ly) * c;
    const z3 = lz + (bz - lz) * c;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);
    const loud = clamp01(taper);
    const edge = e[i] ?? 0;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 0.55) + (o.rDepth ?? 1.4) * zx + (o.loudR ?? 0.25) * loud * c) * rs,
      white: inkOf(o, zx, edge * m + (1 - m)) - (o.loudInk ?? 0.12) * loud * c,
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};

// --- Generating: crystal stitched / unstitched ⇄ logo -------------------
export const frameLogoCrystal: ModeFrame = (size, t, o, logo) => {
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
    (o.lean ?? 0.5) + (o.yawAmp ?? 0.24) * Math.sin(t * (o.yawRate ?? 0.32)) * c,
    (o.tilt ?? 0.2) * c,
    cx,
    cx,
    R,
  );

  const half = o.crystalR ?? 0.94;
  const spin = t * (o.spin ?? 0.3);

  const into = b.local - dwell;
  const prog =
    b.local < dwell ? b.local / dwell : into < morph ? 1 : clamp01(1 - (into - morph) / morph);

  const head = prog * n;
  const feather = Math.max(1, n * (o.feather ?? 0.03));
  const headW = Math.max(1, n * (o.headWidth ?? 0.012));

  const dots: Dot[] = [];
  for (let i = 0; i < n; i++) {
    const seat = seats[i] ?? 0;
    const [ax = 0, ay = 0, az = 0] = fibDir(seat, n);

    const manhattan = Math.abs(ax) + Math.abs(ay) + Math.abs(az) || 1;
    const unrotated: [number, number, number] = [
      (ax / manhattan) * half,
      (ay / manhattan) * half,
      (az / manhattan) * half,
    ];
    const [cx3, cy3, cz3] = rotAxis(unrotated, 1, spin);

    const lx = p[i * 3] ?? 0;
    const ly = p[i * 3 + 1] ?? 0;
    const lz = p[i * 3 + 2] ?? 0;
    const x = lx + (cx3 - lx) * c;
    const y = ly + (cy3 - ly) * c;
    const z3 = lz + (cz3 - lz) * c;

    const [px, py, z] = pt(x, y, z3);
    const zx = clamp01((z + 1) / 2);

    const dist = seat - head;
    const ahead = dist > 0;
    const dHead = Math.abs(dist);
    const brightHead = Math.exp(-(dHead * dHead) / (headW * headW));
    const stitched = ahead ? Math.exp(-(dist * dist) / (feather * feather)) : 1;
    const k = m + c * stitched;
    const edge = e[i] ?? 0;

    dots.push({
      x: px,
      y: py,
      z,
      r:
        ((o.rBase ?? 0.55) +
          (o.rDepth ?? 1.4) * zx +
          (o.headR ?? 0.5) * brightHead * c) *
        rs,
      white:
        inkOf(o, zx, edge * m + (1 - m)) -
        (o.headInk ?? 0.3) * brightHead * c +
        (o.dimUnstitched ?? 0.3) * (1 - k) * c,
      k,
    });
  }
  return finalizeFrame(dots, [], o.rMin);
};
