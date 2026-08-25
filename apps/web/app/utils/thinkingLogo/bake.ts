import type { LogoPointSet, LogoStyle, ShellMode } from "./cloud";

export interface AlphaMask {
  w: number;
  h: number;
  a: Float32Array;
}

export type Pt = [number, number];

export interface ShellPoint {
  x: number;
  y: number;
  z: number;
  e: number;
}

export type LogoSource =
  | { svg: string }
  | { path: string; viewBox?: number }
  | { image: CanvasImageSource }
  | { mask: AlphaMask };

export interface BakeOptions {
  count?: number;
  style?: LogoStyle;
  shell?: ShellMode;
  depth?: number;
  resolution?: number;
  threshold?: number;
  margin?: number;
  seed?: number;
}

const DEFAULTS: Required<Omit<BakeOptions, "count">> & { count: number } = {
  count: 260,
  style: "fill",
  shell: "dome",
  depth: 0.34,
  resolution: 256,
  threshold: 0.5,
  margin: 0.06,
  seed: 1,
};

export function recommendedCount(size: number, style: LogoStyle): number {
  const area = Math.round((size * size) / 5.5);
  const n = style === "outline" ? Math.round(size * 2.6) : area;
  return Math.max(24, Math.min(900, n));
}

export function maskAt(m: AlphaMask, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= m.w || y >= m.h) return 0;
  return m.a[y * m.w + x] ?? 0;
}

export function maskAtF(m: AlphaMask, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const a = maskAt(m, x0, y0);
  const b = maskAt(m, x0 + 1, y0);
  const c = maskAt(m, x0, y0 + 1);
  const d = maskAt(m, x0 + 1, y0 + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

function lerpT(va: number, vb: number, thr: number): number {
  const d = vb - va;
  if (Math.abs(d) < 1e-9) return 0.5;
  return Math.min(1, Math.max(0, (thr - va) / d));
}

type Edge = "T" | "R" | "B" | "L";
const CASES: Record<number, ReadonlyArray<readonly [Edge, Edge]>> = {
  1: [["T", "L"]],
  2: [["R", "T"]],
  3: [["R", "L"]],
  4: [["B", "R"]],
  5: [
    ["T", "L"],
    ["B", "R"],
  ],
  6: [["B", "T"]],
  7: [["B", "L"]],
  8: [["L", "B"]],
  9: [["T", "B"]],
  10: [
    ["R", "T"],
    ["L", "B"],
  ],
  11: [["R", "B"]],
  12: [["L", "R"]],
  13: [["T", "R"]],
  14: [["L", "T"]],
};

const CASES_ALT: Record<number, ReadonlyArray<readonly [Edge, Edge]>> = {
  5: [
    ["T", "R"],
    ["B", "L"],
  ],
  10: [
    ["R", "B"],
    ["L", "T"],
  ],
};

function crossing(
  edge: Edge,
  x: number,
  y: number,
  va: number,
  vb: number,
  vc: number,
  vd: number,
  thr: number,
): Pt {
  switch (edge) {
    case "T":
      return [x + lerpT(va, vb, thr), y];
    case "R":
      return [x + 1, y + lerpT(vb, vc, thr)];
    case "B":
      return [x + lerpT(vd, vc, thr), y + 1];
    default:
      return [x, y + lerpT(va, vd, thr)];
  }
}

export function traceContours(m: AlphaMask, thr: number): Pt[][] {
  const segs: Array<[Pt, Pt]> = [];
  for (let y = 0; y < m.h - 1; y++) {
    for (let x = 0; x < m.w - 1; x++) {
      const va = maskAt(m, x, y);
      const vb = maskAt(m, x + 1, y);
      const vc = maskAt(m, x + 1, y + 1);
      const vd = maskAt(m, x, y + 1);
      let code = 0;
      if (va >= thr) code |= 1;
      if (vb >= thr) code |= 2;
      if (vc >= thr) code |= 4;
      if (vd >= thr) code |= 8;
      if (code === 0 || code === 15) continue;
      let table = CASES[code] ?? [];
      if ((code === 5 || code === 10) && (va + vb + vc + vd) / 4 >= thr) {
        table = CASES_ALT[code] ?? table;
      }
      for (const [from, to] of table) {
        segs.push([
          crossing(from, x, y, va, vb, vc, vd, thr),
          crossing(to, x, y, va, vb, vc, vd, thr),
        ]);
      }
    }
  }

  const byStart = new Map<string, number[]>();
  const ptKey = (p: Pt) => `${Math.round(p[0] * 1000)},${Math.round(p[1] * 1000)}`;
  segs.forEach(([s], i) => {
    const k = ptKey(s);
    const list = byStart.get(k);
    if (list) list.push(i);
    else byStart.set(k, [i]);
  });

  const used = new Uint8Array(segs.length);
  const loops: Pt[][] = [];
  for (let i = 0; i < segs.length; i++) {
    if (used[i]) continue;
    const seg0 = segs[i];
    if (!seg0) continue;
    const loop: Pt[] = [seg0[0]];
    let cur = i;
    used[cur] = 1;
    for (let guard = 0; guard < segs.length; guard++) {
      const curSeg = segs[cur];
      if (!curSeg) break;
      const end = curSeg[1];
      loop.push(end);
      const next = (byStart.get(ptKey(end)) || []).find((j) => !used[j]);
      if (next === undefined) break;
      used[next] = 1;
      cur = next;
    }
    if (loop.length > 3) loops.push(loop);
  }
  return loops;
}

export function loopLength(loop: Pt[]): number {
  let total = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    if (a && b) total += Math.hypot(b[0] - a[0], b[1] - a[1]);
  }
  return total;
}

export function resampleLoop(loop: Pt[], n: number): Pt[] {
  const total = loopLength(loop);
  if (total <= 0 || n <= 0) return [];
  const out: Pt[] = [];
  let seg = 0;
  let acc = 0;
  for (let i = 0; i < n; i++) {
    const target = (i / n) * total;
    while (seg < loop.length - 1) {
      const a = loop[seg];
      const b = loop[(seg + 1) % loop.length];
      if (!a || !b) break;
      const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (acc + l >= target) break;
      acc += l;
      seg++;
    }
    const a = loop[seg];
    const b = loop[(seg + 1) % loop.length];
    if (!a || !b) continue;
    const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const f = l > 0 ? Math.min(1, (target - acc) / l) : 0;
    out.push([a[0] + (b[0] - a[0]) * f, a[1] + (b[1] - a[1]) * f]);
  }
  return out;
}

export function sampleOutline(m: AlphaMask, thr: number, budget: number, minLen: number): Pt[] {
  const loops = traceContours(m, thr).filter((l) => loopLength(l) >= minLen);
  if (!loops.length) return [];
  const lens = loops.map(loopLength);
  const total = lens.reduce((s, l) => s + l, 0);
  const out: Pt[] = [];
  for (let i = 0; i < loops.length; i++) {
    const loop = loops[i];
    const len = lens[i] ?? 0;
    if (!loop) continue;
    const n = Math.max(3, Math.round((len / total) * budget));
    out.push(...resampleLoop(loop, n));
  }
  return out;
}

export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function samplePoisson(m: AlphaMask, thr: number, spacing: number, seed: number): Pt[] {
  const rand = rng(seed);
  const cell = spacing / Math.SQRT2;
  const gw = Math.ceil(m.w / cell);
  const gh = Math.ceil(m.h / cell);
  const grid = new Int32Array(gw * gh).fill(-1);
  const pts: Pt[] = [];
  const active: number[] = [];

  const gridIdx = (p: Pt) => Math.floor(p[1] / cell) * gw + Math.floor(p[0] / cell);

  const fits = (p: Pt): boolean => {
    if (p[0] < 0 || p[1] < 0 || p[0] >= m.w || p[1] >= m.h) return false;
    if (maskAtF(m, p[0], p[1]) < thr) return false;
    const cx = Math.floor(p[0] / cell);
    const cy = Math.floor(p[1] / cell);
    for (let y = Math.max(0, cy - 2); y <= Math.min(gh - 1, cy + 2); y++) {
      for (let x = Math.max(0, cx - 2); x <= Math.min(gw - 1, cx + 2); x++) {
        const i = grid[y * gw + x];
        if (i === undefined || i < 0) continue;
        const q = pts[i];
        if (q && Math.hypot(q[0] - p[0], q[1] - p[1]) < spacing) return false;
      }
    }
    return true;
  };

  const push = (p: Pt) => {
    grid[gridIdx(p)] = pts.length;
    active.push(pts.length);
    pts.push(p);
  };

  const step = Math.max(1, Math.floor(spacing / 2));
  let scanX = 0;
  let scanY = 0;
  const nextSeed = (): Pt | null => {
    for (; scanY < m.h; scanY += step, scanX = 0) {
      for (; scanX < m.w; scanX += step) {
        const p: Pt = [scanX + 0.5, scanY + 0.5];
        if (fits(p)) return p;
      }
    }
    return null;
  };

  for (;;) {
    const seedPt = nextSeed();
    if (!seedPt) break;
    push(seedPt);
    while (active.length) {
      const ai = Math.floor(rand() * active.length);
      const activeIdx = active[ai];
      if (activeIdx === undefined) break;
      const p = pts[activeIdx];
      if (!p) {
        active.splice(ai, 1);
        continue;
      }
      let placed = false;
      for (let k = 0; k < 24; k++) {
        const ang = rand() * Math.PI * 2;
        const rad = spacing * (1 + rand());
        const cand: Pt = [p[0] + Math.cos(ang) * rad, p[1] + Math.sin(ang) * rad];
        if (!fits(cand)) continue;
        push(cand);
        placed = true;
        break;
      }
      if (!placed) active.splice(ai, 1);
    }
  }
  return pts;
}

export function fillToCount(m: AlphaMask, thr: number, target: number, seed: number): Pt[] {
  let ink = 0;
  for (let i = 0; i < m.a.length; i++) {
    if ((m.a[i] ?? 0) >= thr) ink++;
  }
  if (!ink) return [];

  const guess = Math.max(0.5, Math.sqrt(ink / target) * 1.07);
  let lo = guess / 2;
  let hi = guess * 2;
  let best = samplePoisson(m, thr, guess, seed);
  for (let iter = 0; iter < 7; iter++) {
    if (Math.abs(best.length - target) <= Math.max(2, target * 0.04)) break;
    const mid = (lo + hi) / 2;
    const trial = samplePoisson(m, thr, mid, seed);
    if (trial.length > target) lo = mid;
    else hi = mid;
    if (Math.abs(trial.length - target) < Math.abs(best.length - target)) best = trial;
  }
  return best;
}

export function edgeDistance(m: AlphaMask, thr: number): Float32Array {
  const { w, h } = m;
  const INF = 1e9;
  const d = new Float32Array(w * h);
  for (let i = 0; i < d.length; i++) {
    d[i] = (m.a[i] ?? 0) >= thr ? INF : 0;
  }

  const at = (x: number, y: number): number => {
    if (x < 0 || y < 0 || x >= w || y >= h) return 0;
    return d[y * w + x] ?? 0;
  };

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i] ?? INF,
        at(x - 1, y) + 3,
        at(x, y - 1) + 3,
        at(x - 1, y - 1) + 4,
        at(x + 1, y - 1) + 4,
      );
    }
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      if (d[i] === 0) continue;
      d[i] = Math.min(
        d[i] ?? INF,
        at(x + 1, y) + 3,
        at(x, y + 1) + 3,
        at(x + 1, y + 1) + 4,
        at(x - 1, y + 1) + 4,
      );
    }
  }
  for (let i = 0; i < d.length; i++) {
    const cur = d[i] ?? 0;
    d[i] = cur / 3;
  }
  return d;
}

export function buildShell(
  pts2: Pt[],
  outline: Pt[],
  m: AlphaMask,
  thr: number,
  mode: ShellMode,
  depth: number,
): ShellPoint[] {
  const dist = edgeDistance(m, thr);
  let maxD = 1e-6;
  for (let i = 0; i < dist.length; i++) {
    const v = dist[i] ?? 0;
    if (v > maxD) maxD = v;
  }

  const half = m.w / 2;
  const toX = (px: number) => (px - half) / half;
  const toY = (py: number) => -(py - m.h / 2) / (m.h / 2);
  const sampleDist = (x: number, y: number) => {
    const xi = Math.min(m.w - 1, Math.max(0, Math.round(x)));
    const yi = Math.min(m.h - 1, Math.max(0, Math.round(y)));
    return dist[yi * m.w + xi] ?? 0;
  };
  const edgeOf = (p: Pt) => Math.min(1, sampleDist(p[0], p[1]) / maxD);

  const out: ShellPoint[] = [];

  if (mode === "flat") {
    for (const p of pts2) out.push({ x: toX(p[0]), y: toY(p[1]), z: 0, e: edgeOf(p) });
    return out;
  }

  if (mode === "dome") {
    for (const p of pts2) {
      const e = edgeOf(p);
      out.push({ x: toX(p[0]), y: toY(p[1]), z: depth * Math.sqrt(e), e });
    }
    return out;
  }

  const hz = depth / 2;
  for (const p of pts2) {
    const e = edgeOf(p);
    out.push({ x: toX(p[0]), y: toY(p[1]), z: hz, e });
    out.push({ x: toX(p[0]), y: toY(p[1]), z: -hz, e });
  }
  const rings = Math.max(1, Math.round(depth * 6));
  for (let r = 1; r <= rings; r++) {
    const z = hz - (r / (rings + 1)) * depth;
    for (const p of outline) out.push({ x: toX(p[0]), y: toY(p[1]), z, e: 0 });
  }
  return out;
}

export function trimAndCenter(m: AlphaMask, out: number, margin: number, thr: number): AlphaMask {
  let minX = m.w;
  let minY = m.h;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < m.h; y++) {
    for (let x = 0; x < m.w; x++) {
      if ((m.a[y * m.w + x] ?? 0) < thr) continue;
      if (x < minX) minX = x;
      if (x > maxX) maxX = x;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
  }
  if (maxX < 0) return { w: out, h: out, a: new Float32Array(out * out) };

  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  const inner = out * (1 - 2 * margin);
  const scale = inner / Math.max(bw, bh);
  const dw = bw * scale;
  const dh = bh * scale;
  const ox = (out - dw) / 2;
  const oy = (out - dh) / 2;

  const result = new Float32Array(out * out);
  for (let dy = 0; dy < out; dy++) {
    const sy = (dy - oy) / scale + minY;
    if (sy < 0 || sy >= m.h) continue;
    for (let dx = 0; dx < out; dx++) {
      const sx = (dx - ox) / scale + minX;
      if (sx < 0 || sx >= m.w) continue;
      result[dy * out + dx] = maskAtF(m, sx, sy);
    }
  }
  return { w: out, h: out, a: result };
}

export function rasterizePathHeadless(d: string, viewBox: number, res: number): AlphaMask {
  const result = new Float32Array(res * res);
  const commands = d.match(/[a-df-z][^a-df-z]*/gi) || [];
  const lines: Array<[number, number, number, number]> = [];
  let curX = 0;
  let curY = 0;
  let startX = 0;
  let startY = 0;

  for (const cmd of commands) {
    const type = cmd[0];
    const args = cmd.slice(1).trim().split(/[\s,]+/).filter(Boolean).map(Number);
    if (type === "M" || type === "m") {
      const isRel = type === "m";
      curX = isRel ? curX + (args[0] ?? 0) : (args[0] ?? 0);
      curY = isRel ? curY + (args[1] ?? 0) : (args[1] ?? 0);
      startX = curX;
      startY = curY;
    } else if (type === "L" || type === "l") {
      const isRel = type === "l";
      for (let i = 0; i < args.length; i += 2) {
        const nx = isRel ? curX + (args[i] ?? 0) : (args[i] ?? 0);
        const ny = isRel ? curY + (args[i + 1] ?? 0) : (args[i + 1] ?? 0);
        lines.push([curX, curY, nx, ny]);
        curX = nx;
        curY = ny;
      }
    } else if (type === "H" || type === "h") {
      const isRel = type === "h";
      for (const nx of args) {
        const x2 = isRel ? curX + nx : nx;
        lines.push([curX, curY, x2, curY]);
        curX = x2;
      }
    } else if (type === "V" || type === "v") {
      const isRel = type === "v";
      for (const ny of args) {
        const y2 = isRel ? curY + ny : ny;
        lines.push([curX, curY, curX, y2]);
        curY = y2;
      }
    } else if (type === "C" || type === "c") {
      const isRel = type === "c";
      for (let i = 0; i < args.length; i += 6) {
        const x1 = isRel ? curX + (args[i] ?? 0) : (args[i] ?? 0);
        const y1 = isRel ? curY + (args[i + 1] ?? 0) : (args[i + 1] ?? 0);
        const x2 = isRel ? curX + (args[i + 2] ?? 0) : (args[i + 2] ?? 0);
        const y2 = isRel ? curY + (args[i + 3] ?? 0) : (args[i + 3] ?? 0);
        const x3 = isRel ? curX + (args[i + 4] ?? 0) : (args[i + 4] ?? 0);
        const y3 = isRel ? curY + (args[i + 5] ?? 0) : (args[i + 5] ?? 0);
        const steps = 16;
        let px = curX;
        let py = curY;
        for (let s = 1; s <= steps; s++) {
          const t = s / steps;
          const it = 1 - t;
          const qx = it * it * it * curX + 3 * it * it * t * x1 + 3 * it * t * t * x2 + t * t * t * x3;
          const qy = it * it * it * curY + 3 * it * it * t * y1 + 3 * it * t * t * y2 + t * t * t * y3;
          lines.push([px, py, qx, qy]);
          px = qx;
          py = qy;
        }
        curX = x3;
        curY = y3;
      }
    } else if (type === "Z" || type === "z") {
      lines.push([curX, curY, startX, startY]);
      curX = startX;
      curY = startY;
    }
  }

  const s = res / viewBox;
  const strokeRadius = Math.max(1.5, s * 0.75);

  for (const [x1, y1, x2, y2] of lines) {
    const rx1 = x1 * s;
    const ry1 = y1 * s;
    const rx2 = x2 * s;
    const ry2 = y2 * s;
    const dist = Math.hypot(rx2 - rx1, ry2 - ry1);
    const steps = Math.max(1, Math.ceil(dist * 2));
    for (let st = 0; st <= steps; st++) {
      const t = st / steps;
      const cx = rx1 + (rx2 - rx1) * t;
      const cy = ry1 + (ry2 - ry1) * t;
      const minX = Math.max(0, Math.floor(cx - strokeRadius));
      const maxX = Math.min(res - 1, Math.ceil(cx + strokeRadius));
      const minY = Math.max(0, Math.floor(cy - strokeRadius));
      const maxY = Math.min(res - 1, Math.ceil(cy + strokeRadius));
      for (let y = minY; y <= maxY; y++) {
        for (let x = minX; x <= maxX; x++) {
          const d = Math.hypot(x - cx, y - cy);
          if (d <= strokeRadius) {
            const alpha = 1 - d / strokeRadius;
            const idx = y * res + x;
            const curVal = result[idx] ?? 0;
            result[idx] = Math.max(curVal, alpha);
          }
        }
      }
    }
  }

  return { w: res, h: res, a: result };
}

export function rasterizePath(d: string, viewBox: number, res: number): AlphaMask {
  if (typeof document === "undefined") {
    return rasterizePathHeadless(d, viewBox, res);
  }
  const el = document.createElement("canvas");
  el.width = res;
  el.height = res;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) return rasterizePathHeadless(d, viewBox, res);
  const s = res / viewBox;
  ctx.setTransform(s, 0, 0, s, 0, 0);
  ctx.fillStyle = "#fff";
  ctx.strokeStyle = "#fff";
  ctx.lineWidth = 1.5;
  const p = new Path2D(d);
  ctx.fill(p);
  ctx.stroke(p);
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  const px = ctx.getImageData(0, 0, res, res).data;
  const a = new Float32Array(res * res);
  for (let i = 0; i < a.length; i++) a[i] = (px[i * 4 + 3] ?? 0) / 255;
  return { w: res, h: res, a };
}

export async function rasterizeSvg(svgText: string, res: number): Promise<AlphaMask> {
  if (typeof document === "undefined") {
    const paths = Array.from(svgText.matchAll(/d="([^"]+)"/g)).map((m) => m[1]).join(" ");
    const vbMatch = svgText.match(/viewBox="[^"]*?\b(\d+)\s+(\d+)"/);
    const vb = vbMatch && vbMatch[1] && vbMatch[2] ? Math.max(Number(vbMatch[1]), Number(vbMatch[2])) : 24;
    return rasterizePathHeadless(paths, vb, res);
  }
  const doc = new DOMParser().parseFromString(svgText, "image/svg+xml");
  const svg = doc.documentElement;
  if (!svg.getAttribute("viewBox")) {
    const w = Number.parseFloat(svg.getAttribute("width") || "0");
    const h = Number.parseFloat(svg.getAttribute("height") || "0");
    if (w > 0 && h > 0) svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
  }
  svg.setAttribute("width", String(res));
  svg.setAttribute("height", String(res));
  svg.setAttribute("preserveAspectRatio", "xMidYMid meet");

  const serialized = new XMLSerializer().serializeToString(svg);
  const url = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(serialized)}`;
  const img = new Image();
  img.decoding = "sync";
  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("thinking-logos: could not render SVG"));
    img.src = url;
  });

  const el = document.createElement("canvas");
  el.width = res;
  el.height = res;
  const ctx = el.getContext("2d", { willReadFrequently: true });
  if (!ctx) throw new Error("thinking-logos: could not acquire 2D context");
  ctx.drawImage(img, 0, 0, res, res);
  const px = ctx.getImageData(0, 0, res, res).data;
  const a = new Float32Array(res * res);
  for (let i = 0; i < a.length; i++) a[i] = (px[i * 4 + 3] ?? 0) / 255;
  return { w: res, h: res, a };
}

async function toMask(source: LogoSource, res: number): Promise<AlphaMask> {
  if ("mask" in source) return source.mask;
  if ("svg" in source) return rasterizeSvg(source.svg, res);
  if ("path" in source) return rasterizePath(source.path, source.viewBox ?? 24, res);
  if (typeof document !== "undefined") {
    const el = document.createElement("canvas");
    el.width = res;
    el.height = res;
    const ctx = el.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("thinking-logos: could not acquire 2D context");
    ctx.drawImage(source.image, 0, 0, res, res);
    const px = ctx.getImageData(0, 0, res, res).data;
    const a = new Float32Array(res * res);
    for (let i = 0; i < a.length; i++) a[i] = (px[i * 4 + 3] ?? 0) / 255;
    return { w: res, h: res, a };
  }
  return { w: res, h: res, a: new Float32Array(res * res) };
}

export async function bakeLogo(source: LogoSource, options: BakeOptions = {}): Promise<LogoPointSet> {
  const o = { ...DEFAULTS, ...options };
  const raw = await toMask(source, o.resolution);
  const m = trimAndCenter(raw, o.resolution, o.margin, o.threshold);

  const needOutline = o.style !== "fill" || o.shell === "slab";
  const outlineBudget = o.style === "both" ? Math.round(o.count * 0.42) : o.count;
  const minLen = Math.max(6, (o.resolution / Math.sqrt(o.count)) * 3);
  const outline: Pt[] = needOutline ? sampleOutline(m, o.threshold, outlineBudget, minLen) : [];

  let pts: Pt[];
  if (o.style === "outline") {
    pts = outline;
  } else if (o.style === "fill") {
    pts = fillToCount(m, o.threshold, o.count, o.seed);
  } else {
    pts = [...outline, ...fillToCount(m, o.threshold, o.count - outline.length, o.seed)];
  }

  const shell = buildShell(pts, outline, m, o.threshold, o.shell, o.depth);
  const n = shell.length;
  const p = new Float32Array(n * 3);
  const e = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const pt = shell[i];
    if (pt) {
      p[i * 3] = pt.x;
      p[i * 3 + 1] = pt.y;
      p[i * 3 + 2] = pt.z;
      e[i] = pt.e;
    }
  }
  return { version: 1, n, p, e, style: o.style, shell: o.shell };
}

export function serializeLogo(set: LogoPointSet): string {
  const r = (v: number) => Math.round(v * 1000) / 1000;
  return JSON.stringify({
    version: set.version,
    n: set.n,
    style: set.style,
    shell: set.shell,
    p: Array.from(set.p, r),
    e: Array.from(set.e, r),
  });
}

export function deserializeLogo(json: string | Record<string, unknown>): LogoPointSet {
  const raw = (typeof json === "string" ? JSON.parse(json) : json) as {
    version: number;
    n: number;
    style: LogoStyle;
    shell: ShellMode;
    p: number[];
    e: number[];
  };
  if (raw.version !== 1) throw new Error(`thinking-logos: unsupported version ${raw.version}`);
  return {
    version: 1,
    n: raw.n,
    p: Float32Array.from(raw.p),
    e: Float32Array.from(raw.e),
    style: raw.style,
    shell: raw.shell,
  };
}
