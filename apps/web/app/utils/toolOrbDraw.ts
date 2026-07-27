export type ToolOrbFamily =
  | "read" | "write" | "search" | "intel" | "run" | "web" | "agent" | "del" | "neutral";

export type OrbTheme = { isDark: boolean; reduced: boolean };
export type OrbDrawCtx = {
  ctx: CanvasRenderingContext2D;
  size: number;
  width?: number;
  height?: number;
  time: number;
  waitSec?: number;
  hueDeg: number;
  theme: OrbTheme;
};

type Dot = { x: number; y: number; z: number; r?: number; a?: number; active?: boolean };
const TAU = Math.PI * 2;
const clamp = (n: number, lo = 0, hi = 1) => Math.max(lo, Math.min(hi, n));
const smooth = (n: number) => { const x = clamp(n); return x * x * (3 - 2 * x); };
const fract = (n: number) => n - Math.floor(n);
const hash = (n: number) => fract(Math.sin(n * 91.37 + 17.11) * 43758.5453);

export function hexToHueDeg(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 6) return 240;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 240;
  const raw = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return raw * 60;
}

function paint(c: OrbDrawCtx, dots: Dot[]) {
  const { ctx, theme, size, hueDeg } = c;
  dots.sort((a, b) => a.z - b.z);
  for (const d of dots) {
    const depth = clamp((d.z + 1) / 2);
    const alpha = (d.a ?? 0.72) * (0.38 + depth * 0.62);
    if (alpha < 0.025) continue;
    const light = theme.isDark ? 72 + depth * 22 : 36 + (1 - depth) * 28;
    const chroma = d.active ? 0.09 : 0.045;
    c.ctx.fillStyle = `oklch(${light}% ${chroma} ${hueDeg} / ${alpha})`;
    c.ctx.beginPath();
    c.ctx.arc(d.x, d.y, Math.max(0.42, (d.r ?? 0.72) * (0.72 + depth * 0.55)), 0, TAU);
    c.ctx.fill();
  }
}

function dot(c: OrbDrawCtx, x: number, y: number, z = 0, active = false, a = 0.8, r = 0.72): Dot {
  return { x: c.size / 2 + x * c.size, y: c.size / 2 + y * c.size, z, active, a, r };
}
function line(c: OrbDrawCtx, a: [number, number], b: [number, number], n: number, z = 0, activeAt = -1): Dot[] {
  return Array.from({ length: n }, (_, i) => {
    const u = n === 1 ? 0 : i / (n - 1);
    return dot(c, a[0] + (b[0] - a[0]) * u, a[1] + (b[1] - a[1]) * u, z + Math.sin(u * Math.PI) * 0.12, i === activeAt, 0.5, 0.62);
  });
}

function drawNeutral(c: OrbDrawCtx) {
  const dots: Dot[] = [];
  for (let i = 0; i < 10; i++) {
    const a = i / 10 * TAU;
    dots.push(dot(c, Math.cos(a) * 0.31, Math.sin(a) * 0.31, Math.sin(a) * 0.5, false, 0.55, 0.66));
  }
  dots.push(dot(c, 0, 0, 0.2, true, 0.7, 0.9));
  paint(c, dots);
}

/** Working: a small relay wheel, with three packets circulating through a stable engine shape. */
function drawWorking(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 0.42 : c.time;
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU;
    const r = 0.28 + Math.cos(a * 3) * 0.055;
    dots.push(dot(c, Math.cos(a) * r, Math.sin(a) * r, Math.sin(a) * 0.35, false, 0.58, 0.6));
  }
  for (let k = 0; k < 3; k++) {
    const a = t * 1.8 + k * TAU / 3;
    dots.push(dot(c, Math.cos(a) * 0.29, Math.sin(a) * 0.29, Math.sin(a), true, 1, 1.05));
    dots.push(dot(c, Math.cos(a + 0.17) * 0.29, Math.sin(a + 0.17) * 0.29, Math.sin(a), true, 0.5, 0.65));
  }
  dots.push(dot(c, 0, 0, 0.25, true, 0.5, 0.62));
  paint(c, dots);
}

/** Thinking: reciprocal inward/outward spirals, not a globe. */
function drawThinking(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 0.6 : c.time;
  for (let arm = 0; arm < 2; arm++) for (let i = 0; i < 13; i++) {
    const u = i / 12, a = arm * Math.PI + u * TAU * 0.72 + t * (arm ? -0.16 : 0.16);
    const r = 0.06 + u * 0.31;
    const packet = fract(t * 0.34 + arm * 0.5);
    const active = Math.abs(u - packet) < 0.09;
    dots.push(dot(c, Math.cos(a) * r, Math.sin(a) * r, arm ? -0.1 : 0.1, active, active ? 1 : 0.48, active ? 0.95 : 0.62));
  }
  paint(c, dots);
}

/** Read: open folio, with a highlight advancing line by line through the pages. */
function drawRead(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 0.5 : c.time;
  const row = Math.floor(fract(t * 0.42) * 4);
  for (let side = -1; side <= 1; side += 2) {
    for (let r = 0; r < 4; r++) {
      const y = -0.22 + r * 0.14;
      const start = side < 0 ? -0.34 : 0.08, end = side < 0 ? -0.08 : 0.34;
      dots.push(...line(c, [start, y], [end, y + side * 0.015], 4, side * 0.08, r === row ? 2 : -1));
    }
  }
  dots.push(...line(c, [0, -0.31], [0, 0.31], 5, 0.2, row === 3 ? 3 : -1));
  paint(c, dots);
}

/** Write: a nib travels across accumulating baselines, leaving ink behind. */
function drawWrite(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 0.55 : c.time;
  const cycle = fract(t * 0.34), row = Math.floor(cycle * 3), u = fract(cycle * 3);
  for (let r = 0; r < 3; r++) {
    const end = r < row ? 0.34 : r === row ? -0.34 + u * 0.68 : -0.34;
    if (end > -0.33) dots.push(...line(c, [-0.34, -0.2 + r * 0.2], [end, -0.2 + r * 0.2], Math.max(2, Math.round((end + 0.34) * 22)), 0.05, -1));
  }
  dots.push(dot(c, -0.34 + u * 0.68, -0.2 + row * 0.2, 0.3, true, 1, 1.05));
  paint(c, dots);
}

/** Search: lens silhouette and a chord that inspects one slice. */
function drawSearch(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 0.45 : c.time;
  const angle = -0.7 + Math.sin(t * 0.7) * 0.42;
  for (let i = 0; i < 16; i++) {
    const a = i / 16 * TAU;
    dots.push(dot(c, Math.cos(a) * 0.27, Math.sin(a) * 0.27, Math.sin(a) * 0.2, false, 0.65, 0.65));
  }
  dots.push(...line(c, [0.19, 0.19], [0.37, 0.37], 5, 0.2, 4));
  const cx = Math.cos(angle) * 0.08, cy = Math.sin(angle) * 0.08;
  dots.push(...line(c, [cx - Math.sin(angle) * 0.23, cy + Math.cos(angle) * 0.23], [cx + Math.sin(angle) * 0.23, cy - Math.cos(angle) * 0.23], 5, 0.3, 2));
  paint(c, dots);
}

/** Intel: evidence fragments converge into a locked diamond, then disperse. */
function drawIntel(c: OrbDrawCtx) {
  const dots: Dot[] = [], t = c.theme.reduced ? 1.1 : c.time, p = fract(t * 0.24);
  const lock = smooth(clamp((p - 0.42) / 0.18));
  const targets: [number, number][] = [[0, -0.25], [0.25, 0], [0, 0.25], [-0.25, 0]];
  for (let i = 0; i < 4; i++) {
    const target = targets[i]!;
    const a = i * 1.7 + 0.4;
    const sx = Math.cos(a) * 0.34, sy = Math.sin(a) * 0.34;
    const x = sx + (target[0] - sx) * lock, y = sy + (target[1] - sy) * lock;
    dots.push(dot(c, x, y, 0.1 + i * 0.04, lock > 0.75, 0.85, 0.86));
  }
  for (let i = 0; i < 4; i++) dots.push(...line(c, targets[i]!, targets[(i + 1) % 4]!, 3, 0.02, -1));
  paint(c, dots);
}

/** Run: a chevron launches through a command gate. */
function drawRun(c: OrbDrawCtx) {
  const t = c.theme.reduced ? 0.72 : c.time, u = smooth(fract(t * 0.9)), dots: Dot[] = [];
  dots.push(...line(c, [-0.31, -0.25], [-0.31, 0.25], 5, -0.05));
  dots.push(...line(c, [0.31, -0.25], [0.31, 0.25], 5, 0.05));
  const x = -0.25 + u * 0.5;
  dots.push(...line(c, [x - 0.1, -0.1], [x, 0], 3, 0.3, 2));
  dots.push(...line(c, [x, 0], [x - 0.1, 0.1], 3, 0.3, 2));
  paint(c, dots);
}

/** Web: a packet traverses a small graph, changing route only after arrival. */
function drawWeb(c: OrbDrawCtx) {
  const t = c.theme.reduced ? 0.55 : c.time, u = fract(t * 0.48), nodes: [number, number][] = [[-0.25, -0.2], [0.22, -0.25], [0.28, 0.2], [-0.2, 0.24]];
  const edges: [number, number][] = [[0, 1], [1, 2], [2, 3], [3, 0], [0, 2]];
  const e = Math.floor(u * edges.length), local = fract(u * edges.length);
  const edge = edges[e] ?? edges[0]!;
  const [a, b] = edge;
  const dots: Dot[] = [];
  for (const [x, y] of nodes) dots.push(dot(c, x, y, 0.1, false, 0.8, 0.85));
  for (const [ai, bi] of edges) dots.push(...line(c, nodes[ai]!, nodes[bi]!, 3, -0.05));
  const p = nodes[a]!, q = nodes[b]!;
  dots.push(dot(c, p[0] + (q[0] - p[0]) * local, p[1] + (q[1] - p[1]) * local, 0.35, true, 1, 1.1));
  paint(c, dots);
}

/** Agent: parent delegates to two children, then receives the result packet. */
function drawAgent(c: OrbDrawCtx) {
  const t = c.theme.reduced ? 1.0 : c.time, p = fract(t * 0.28), child = p < 0.35 ? smooth(p / 0.35) : 1;
  const dots: Dot[] = [dot(c, -0.02, 0, 0.25, true, 0.9, 0.95)];
  const targets: [number, number][] = [[-0.28, -0.22], [0.28, 0.22]];
  for (let i = 0; i < 2; i++) {
    const target = targets[i]!;
    const x = target[0] * child, y = target[1] * child;
    dots.push(...line(c, [-0.02, 0], [x, y], 3, -0.02));
    dots.push(dot(c, x, y, 0.2, true, 0.95, 0.88));
  }
  const route = p > 0.65 ? smooth((p - 0.65) / 0.25) : 0;
  const firstTarget = targets[0]!;
  dots.push(dot(c, firstTarget[0] * (1 - route) - 0.02 * route, firstTarget[1] * (1 - route), 0.35, true, route, 0.92));
  paint(c, dots);
}

/** Delete: an erosion front consumes the field and sends dots to a sink. */
function drawDelete(c: OrbDrawCtx) {
  const t = c.theme.reduced ? 0.55 : c.time, p = fract(t * 0.2), dots: Dot[] = [], sink: [number, number] = [0.34, 0.34];
  for (let i = 0; i < 18; i++) {
    const a = i / 18 * TAU, x = Math.cos(a) * 0.28, y = Math.sin(a) * 0.28;
    const gone = (x + y + 0.56) / 1.12 < p;
    if (!gone) dots.push(dot(c, x, y, Math.sin(a) * 0.12, false, 0.65, 0.7));
    else {
      const q = smooth(clamp((p - (x + y + 0.56) / 1.12) * 4));
      dots.push(dot(c, x + (sink[0] - x) * q, y + (sink[1] - y) * q, 0.25, true, 1 - q, 0.75));
    }
  }
  dots.push(dot(c, sink[0], sink[1], 0.3, true, 0.9, 0.82));
  paint(c, dots);
}

export function drawThinkingOrb(c: OrbDrawCtx): void { drawThinking(c); }
export function drawWorkingOrb(c: OrbDrawCtx): void { drawWorking(c); }
export const THINKING_ORB_HUE = "#8b5cf6";
export const THINKING_ORB_LABEL = "Thinking…";
export const WORKING_ORB_HUE = "#71717a";
export const WORKING_ORB_LABEL = "Working…";
export const TOOL_ORB_LABELS: Record<ToolOrbFamily, string> = {
  read: "Reading…", write: "Writing…", search: "Searching…", intel: "Analysing…", run: "Running…", web: "Fetching…", agent: "Delegating…", del: "Deleting…", neutral: "Working…",
};
export function drawToolOrb(family: ToolOrbFamily, c: OrbDrawCtx): void {
  ({ read: drawRead, write: drawWrite, search: drawSearch, intel: drawIntel, run: drawRun, web: drawWeb, agent: drawAgent, del: drawDelete, neutral: drawNeutral }[family] ?? drawNeutral)(c);
}
