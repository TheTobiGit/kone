import type { LogoPointSet, SeatMap } from "./cloud";

export interface Dot {
  x: number;
  y: number;
  z: number;
  r: number;
  white: number;
  a?: number;
  k?: number;
  glow?: boolean;
  border?: boolean;
  line?: number;
}

export interface Line {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  z: number;
  w: number;
  white: number;
  a?: number;
}

export interface OrbFrame {
  dots: Dot[];
  lines: Line[];
}

export interface LogoBinding {
  points: LogoPointSet;
  seats: SeatMap;
}

export type ModeFrame = (
  size: number,
  t: number,
  opts: Record<string, number | undefined>,
  logo?: LogoBinding,
) => OrbFrame;

export type Projector = (x: number, y: number, z: number) => [number, number, number];

export function lerp(a: number, b: number, f: number): number {
  return a + (b - a) * f;
}

export function frac(x: number): number {
  return x - Math.floor(x);
}

export function clamp01(n: number): number {
  return Math.max(0, Math.min(1, n));
}

export function smoothE(x: number): number {
  return x * x * (3 - 2 * x);
}

export function smooth(n: number): number {
  return n * n * (3 - 2 * n);
}

/** Value noise on a 2D lattice — smooth, deterministic, cheap. */
export function vnoise(x: number, y: number): number {
  const ix = Math.floor(x);
  const iy = Math.floor(y);
  const fx = x - ix;
  const fy = y - iy;
  const ux = smooth(fx);
  const uy = smooth(fy);

  const h00 = hashD(ix, iy);
  const h10 = hashD(ix + 1, iy);
  const h01 = hashD(ix, iy + 1);
  const h11 = hashD(ix + 1, iy + 1);

  return lerp(lerp(h00, h10, ux), lerp(h01, h11, ux), uy);
}

/** Deterministic hash in [0, 1). */
export function hashD(a: number, b: number): number {
  const s = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return s - Math.floor(s);
}

/** Stable directions on a unit sphere (Fibonacci lattice). */
export function fibDir(i: number, n: number): [number, number, number] {
  if (n <= 1) return [0, 0, 1];
  const phi = Math.acos(1 - (2 * (i + 0.5)) / n);
  const theta = Math.PI * (1 + 5 ** 0.5) * i;
  return [Math.sin(phi) * Math.cos(theta), Math.cos(phi), Math.sin(phi) * Math.sin(theta)];
}

/** Shortest signed angular distance, wrapped to (-π, π]. */
export function angleDelta(a: number, b: number): number {
  return Math.atan2(Math.sin(a - b), Math.cos(a - b));
}

/** Shared spin + tilt + orthographic projection. */
export function makeProj(
  yaw: number,
  tilt: number,
  cx: number,
  cy: number,
  scale: number,
): Projector {
  const cyaw = Math.cos(yaw);
  const syaw = Math.sin(yaw);
  const ctilt = Math.cos(tilt);
  const stilt = Math.sin(tilt);
  return (x, y, z) => {
    const x1 = x * cyaw + z * syaw;
    const z1 = -x * syaw + z * cyaw;
    const y2 = y * ctilt - z1 * stilt;
    const z2 = y * stilt + z1 * ctilt;
    return [cx + x1 * scale, cy - y2 * scale, z2];
  };
}

/**
 * Dot radii were tuned for a 300pt frame; sub-linear scaling keeps small
 * spinners legible. Lower pow = radii shrink less with size.
 */
export function radiusScale(size: number, pow: number): number {
  return (size / 300) ** pow;
}

/**
 * Normalise, sort far-to-near (by z ascending), and enforce the dot floor.
 */
export function finalizeFrame(dots: Dot[], lines: Line[], rMin = 0.3): OrbFrame {
  for (let i = 0; i < dots.length; i++) {
    const d = dots[i];
    if (d && d.r < rMin) d.r = rMin;
  }
  dots.sort((a, b) => a.z - b.z);
  lines.sort((a, b) => a.z - b.z);
  return { dots, lines };
}

/** Greyscale fallback painter. */
export function paintFrame(
  ctx: CanvasRenderingContext2D,
  frame: OrbFrame,
  dark: boolean,
): void {
  for (const l of frame.lines) {
    const w = Math.min(1, Math.max(0, l.white));
    const val = dark ? Math.round(255 * (1 - w)) : Math.round(255 * w);
    ctx.strokeStyle = `rgba(${val},${val},${val},${l.a ?? 1})`;
    ctx.lineWidth = l.w;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  for (const d of frame.dots) {
    const w = Math.min(1, Math.max(0, d.white));
    const val = dark ? Math.round(255 * (1 - w)) : Math.round(255 * w);
    ctx.fillStyle = `rgba(${val},${val},${val},${d.a ?? 1})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
