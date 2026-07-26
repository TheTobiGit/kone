// Canvas drawers for inline tool-step orbs — dotted thought-orb language at the
// 16px step-icon scale. Each tool family gets a distinct motion while running;
// settled steps fall back to the static Phosphor glyph in ConversationThread.

export type ToolOrbFamily =
  | "read"
  | "write"
  | "search"
  | "intel"
  | "run"
  | "web"
  | "agent"
  | "del"
  | "neutral";

export type OrbTheme = {
  isDark: boolean;
  reduced: boolean;
};

export type OrbDrawCtx = {
  ctx: CanvasRenderingContext2D;
  /** Square orbs — width/height fall back to this. */
  size: number;
  width?: number;
  height?: number;
  time: number;
  /** Seconds since this waiting gap began — drives horizontal growth + density. */
  waitSec?: number;
  hueDeg: number;
  theme: OrbTheme;
};

function orbW(c: OrbDrawCtx): number {
  return c.width ?? c.size;
}
function orbH(c: OrbDrawCtx): number {
  return c.height ?? c.size;
}

// ── helpers ───────────────────────────────────────────────────────────────────

export function hexToHueDeg(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 6) return 240;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 240;
  const d = max - min;
  let hue = 0;
  if (max === r) hue = ((g - b) / d + (g < b ? 6 : 0)) * 60;
  else if (max === g) hue = ((b - r) / d + 2) * 60;
  else hue = ((r - g) / d + 4) * 60;
  return hue;
}

function hash(a: number, b: number): number {
  const n = Math.sin(a * 12.9898 + b * 78.233) * 43758.5453;
  return n - Math.floor(n);
}

function projector(yaw: number, tilt: number, cx: number, cy: number) {
  const o = Math.sin(tilt);
  const u = Math.cos(tilt);
  const si = Math.sin(yaw);
  const co = Math.cos(yaw);
  return (x: number, y: number, z: number): [number, number, number] => {
    const p = x * co + z * si;
    const v = -x * si + z * co;
    const g = y * u - v * o;
    const w = y * o + v * u;
    return [cx + p, cy - g, w];
  };
}

function paintDot(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  depth: number,
  alpha: number,
  hueDeg: number,
  theme: OrbTheme,
  bright = false,
) {
  if (alpha < 0.02) return;
  const { isDark } = theme;
  let L: number;
  if (isDark) {
    L = 82 + depth * 14 + (bright ? 5 : 0);
  } else {
    L = 44 + (1 - depth) * 26 - (bright ? 3 : 0);
  }
  const C = bright ? 0.1 : 0.065;
  ctx.fillStyle = `oklch(${L}% ${C} ${hueDeg} / ${alpha})`;
  ctx.beginPath();
  ctx.arc(x, y, Math.max(0.35, r), 0, Math.PI * 2);
  ctx.fill();
}

type GlobePt = { lat: number; lon: number };

function buildGlobe(rings: number, density: number): GlobePt[] {
  const out: GlobePt[] = [];
  for (let i = 0; i <= rings; i++) {
    const lat = -Math.PI / 2 + (Math.PI * i) / rings;
    const ringR = Math.cos(lat);
    const n = Math.max(1, Math.round(density * ringR));
    const off = (i % 2) * 0.5;
    for (let j = 0; j < n; j++) {
      out.push({ lat, lon: ((j + off) / n) * Math.PI * 2 });
    }
  }
  return out;
}

function projectGlobe(
  pts: GlobePt[],
  time: number,
  cx: number,
  cy: number,
  rad: number,
  spin: number,
  warpAmp: number,
): { x: number; y: number; z: number }[] {
  const tilt = -0.42 + Math.sin(time * 0.55) * 0.18;
  const roll = Math.sin(time * 0.33) * 0.07;
  const cosT = Math.cos(tilt);
  const sinT = Math.sin(tilt);
  const cosR = Math.cos(roll);
  const sinR = Math.sin(roll);
  const out: { x: number; y: number; z: number }[] = [];

  for (const p of pts) {
    const lon = p.lon + spin + 0.18 * Math.sin(time * 0.65 + p.lat * 2.1);
    const warp =
      1 +
      warpAmp *
        (0.55 * Math.sin(p.lon * 3 + time * 1.2) +
          0.35 * Math.sin(p.lat * 4 - time * 1.5));
    const cl = Math.cos(p.lat) * warp;
    const bx = Math.cos(lon) * cl;
    const by = Math.sin(p.lat) * warp;
    const bz = Math.sin(lon) * cl;
    const y2 = by * cosT - bz * sinT;
    const z = by * sinT + bz * cosT;
    const x = bx * cosR - y2 * sinR;
    const y = bx * sinR + y2 * cosR;
    out.push({ x: cx + x * rad, y: cy + y * rad, z });
  }
  return out;
}

function drawGlobe(
  c: OrbDrawCtx,
  rings: number,
  density: number,
  spinRate: number,
  warpAmp: number,
  scan?: { speed: number; width: number },
) {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  const rad = size * 0.38;
  const pts = buildGlobe(rings, density);
  const spin = theme.reduced ? 0.65 : time * spinRate;
  const projected = projectGlobe(pts, time, cx, cy, rad, spin, warpAmp);
  projected.sort((a, b) => a.z - b.z);

  const scanLon = scan ? ((time * scan.speed) % (Math.PI * 2)) - Math.PI : null;
  const scanWidth = scan?.width ?? 0;

  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = projected[i]!;
    const depth = (q.z / rad + 1) / 2;
    let bright = false;
    let alpha = 0.12 + Math.pow(depth, 1.5) * 0.75;
    if (scanLon != null) {
      const lon = p.lon + spin;
      const dLon = Math.abs(Math.atan2(Math.sin(lon - scanLon), Math.cos(lon - scanLon)));
      if (dLon < scanWidth) {
        bright = true;
        alpha = 0.35 + (1 - dLon / scanWidth) * 0.65;
      }
    }
    paintDot(ctx, q.x, q.y, 0.45 + depth * 0.35, depth, alpha, hueDeg, theme, bright);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawOrbits(c: OrbDrawCtx, orbitN: number, ghostN: number, particles: number) {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  const R = size * 0.38;
  const t = theme.reduced ? 0.55 : time;
  const proj = projector(t * 0.12, 0.3, cx, cy);
  const rScale = size / 64;
  type Dot = { x: number; y: number; z: number; r: number; depth: number; a: number; bright: boolean };
  const dots: Dot[] = [];

  for (let g = 0; g < orbitN; g++) {
    const h1 = hash(g, 1.7);
    const h2 = hash(g, 5.2);
    const h3 = hash(g, 8.9);
    const rad = R * (0.45 + 0.52 * h1);
    const theta = h1 * 2 * Math.PI;
    const phi = Math.acos(2 * h2 - 1);
    const nx = Math.sin(phi) * Math.cos(theta);
    const ny = Math.cos(phi);
    const nz = Math.sin(phi) * Math.sin(theta);
    let ex = -ny;
    let ey = nx;
    const ez = 0;
    const en = Math.max(1e-6, Math.sqrt(ex * ex + ey * ey));
    ex /= en;
    ey /= en;
    const jx = ny * ez - nz * ey;
    const jy = nz * ex - nx * ez;
    const jz = nx * ey - ny * ex;
    const spin = (0.25 + 0.55 * h3) * (h3 > 0.5 ? 1 : -1);

    for (let k = 0; k < ghostN; k++) {
      const ang = (k / ghostN) * 2 * Math.PI;
      const px = (ex * Math.cos(ang) + jx * Math.sin(ang)) * rad;
      const py = (ey * Math.cos(ang) + jy * Math.sin(ang)) * rad;
      const pz = (ez * Math.cos(ang) + jz * Math.sin(ang)) * rad;
      const [sx, sy, sz] = proj(px, py, pz);
      const depth = (sz / rad + 1) / 2;
      dots.push({
        x: sx,
        y: sy,
        z: sz,
        r: 0.55 * rScale,
        depth,
        a: 0.45 * (0.4 + 0.6 * depth),
        bright: false,
      });
    }
    for (let k = 0; k < particles; k++) {
      const ang = t * spin + (k / particles) * 2 * Math.PI + h2 * 6;
      const px = (ex * Math.cos(ang) + jx * Math.sin(ang)) * rad;
      const py = (ey * Math.cos(ang) + jy * Math.sin(ang)) * rad;
      const pz = (ez * Math.cos(ang) + jz * Math.sin(ang)) * rad;
      const [sx, sy, sz] = proj(px, py, pz);
      const depth = (sz / rad + 1) / 2;
      dots.push({
        x: sx,
        y: sy,
        z: sz,
        r: (0.75 + depth * 0.45) * rScale,
        depth,
        a: 1,
        bright: true,
      });
    }
  }

  dots.sort((a, b) => a.z - b.z);
  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (const d of dots) {
    paintDot(ctx, d.x, d.y, d.r, d.depth, d.a, hueDeg, theme, d.bright);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawSash(c: OrbDrawCtx) {
  const { ctx, size, time, hueDeg, theme } = c;
  const bands = 4;
  const t = theme.reduced ? 0.4 : time;
  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let b = 0; b < bands; b++) {
    const yBase = size * (0.22 + (b / (bands - 1)) * 0.56);
    const n = 10 + b * 2;
    for (let i = 0; i < n; i++) {
      const u = i / (n - 1);
      const x = size * 0.12 + u * size * 0.76;
      const wave = Math.sin(u * 4 + t * 2.2 + b * 0.9) * size * 0.04;
      const y = yBase + wave;
      const depth = 0.35 + 0.65 * Math.sin(u * Math.PI);
      paintDot(ctx, x, y, 0.42, depth, 0.25 + depth * 0.55, hueDeg, theme, i % 3 === b % 3);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawSolve(c: OrbDrawCtx) {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  const rad = size * 0.36;
  const pts = buildGlobe(6, 14);
  const cycle = theme.reduced ? 0 : time * 1.6;
  const scramble = (Math.sin(cycle * 2.1) + 1) / 2;
  const spin = theme.reduced ? 0.5 : time * 0.35;
  const projected = projectGlobe(pts, time, cx, cy, rad * (0.92 + scramble * 0.08), spin, 0.06 + scramble * 0.12);
  projected.sort((a, b) => a.z - b.z);

  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let i = 0; i < projected.length; i++) {
    const q = projected[i]!;
    const depth = (q.z / rad + 1) / 2;
    const jitter = scramble * 0.8;
    const jx = q.x + Math.sin(i * 1.7 + cycle * 3) * jitter;
    const jy = q.y + Math.cos(i * 2.3 + cycle * 2.5) * jitter;
    paintDot(ctx, jx, jy, 0.4 + depth * 0.35, depth, 0.2 + depth * 0.7, hueDeg, theme, scramble < 0.15);
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawRipple(c: OrbDrawCtx) {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  drawGlobe(c, 5, 12, 0.28, 0.05);
  const t = theme.reduced ? 0.5 : time;
  const pulse = (t * 1.4) % 1;
  const rings = 2;
  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let r = 0; r < rings; r++) {
    const p = (pulse + r / rings) % 1;
    const rad = size * (0.15 + p * 0.42);
    const alpha = (1 - p) * 0.55;
    const n = Math.max(8, Math.round(rad * 1.2));
    for (let i = 0; i < n; i++) {
      const ang = (i / n) * Math.PI * 2 + t * 0.4;
      paintDot(ctx, cx + Math.cos(ang) * rad, cy + Math.sin(ang) * rad, 0.38, 0.7, alpha, hueDeg, theme, p < 0.2);
    }
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawContract(c: OrbDrawCtx) {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  const t = theme.reduced ? 0.3 : time;
  const breathe = 0.55 + Math.sin(t * 2.4) * 0.18;
  const n = 16;
  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let i = 0; i < n; i++) {
    const ang = (i / n) * Math.PI * 2 + t * 0.6;
    const rad = size * 0.12 + breathe * size * 0.26 * ((i % 3) / 2 + 0.35);
    paintDot(
      ctx,
      cx + Math.cos(ang) * rad,
      cy + Math.sin(ang) * rad,
      0.42,
      0.5 + (rad / size) * 0.5,
      0.35 + breathe * 0.45,
      hueDeg,
      theme,
      i % 4 === 0,
    );
  }
  ctx.globalCompositeOperation = "source-over";
}

function drawNeutral(c: OrbDrawCtx) {
  drawGlobe(c, 5, 14, 0.45, 0.07);
}

/** Reasoning step — a slow, inward-breathing globe with soft latitude waves.
 *  Distinct from tool scans/sashes: contemplative, not operational. */
export function drawThinkingOrb(c: OrbDrawCtx): void {
  const { ctx, size, time, hueDeg, theme } = c;
  const cx = size / 2;
  const cy = size / 2;
  const t = theme.reduced ? 0.45 : time;
  const breathe = 0.94 + Math.sin(t * 1.35) * 0.08;
  const rad = size * 0.37 * breathe;
  const pts = buildGlobe(7, 17);
  const spin = t * 0.18;
  const projected = projectGlobe(pts, t, cx, cy, rad, spin, 0.05 + Math.sin(t * 0.9) * 0.03);
  projected.sort((a, b) => a.z - b.z);

  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = projected[i]!;
    const depth = (q.z / rad + 1) / 2;
    const wave = 0.55 + 0.45 * Math.sin(p.lat * 2.8 + t * 1.6);
    const alpha = (0.1 + Math.pow(depth, 1.4) * 0.65) * wave;
    paintDot(ctx, q.x, q.y, 0.42 + depth * 0.32, depth, alpha, hueDeg, theme, wave > 0.88);
  }
  ctx.globalCompositeOperation = "source-over";
}

// ── public ────────────────────────────────────────────────────────────────────

/** General agent-working orb — a single-row particle band that grows horizontally,
 *  gains count, and tightens into a denser weave the longer the wait lasts.
 *  Stays one line tall; the canvas width is fixed so layout never wraps. */
export function drawWorkingOrb(c: OrbDrawCtx): void {
  const { ctx, time, hueDeg, theme } = c;
  const W = orbW(c);
  const H = orbH(c);
  const cy = H / 2;
  const t = theme.reduced ? 0.35 : time;
  const wait = Math.max(0, c.waitSec ?? 0);

  // Life ramps asymptotically — keeps evolving on long waits without hitting a wall.
  const life = 1 - Math.exp(-wait * 0.16);
  const pad = W * 0.04;
  const maxSpan = W - pad * 2;
  // Cluster grows from the left; never wider than the canvas.
  const extent = maxSpan * (0.18 + life * 0.82);

  const minGap = 3.6;
  const maxCount = Math.max(5, Math.floor(maxSpan / minGap));
  const count = Math.max(3, Math.round(3 + (maxCount - 3) * life));

  const wave = (t * 0.36) % 1;
  const sparkSlot = Math.floor(t * 2.8) % Math.max(1, count);
  const tipPulse = 0.5 + 0.5 * Math.sin(t * 3.8 + wait * 0.4);

  ctx.globalCompositeOperation = theme.isDark ? "lighter" : "source-over";

  // Faint seeds ahead of the growth front — hints that more is coming.
  if (life < 0.92 && extent < maxSpan * 0.95) {
    const seedN = 3;
    for (let s = 0; s < seedN; s++) {
      const ahead = extent + (s + 1) * (maxSpan - extent) / (seedN + 1);
      const flicker = 0.4 + 0.6 * Math.sin(t * 2.1 + s * 1.7 + wait);
      paintDot(ctx, pad + ahead, cy, 0.32, 0.35, 0.04 + life * 0.06 * flicker, hueDeg, theme);
    }
  }

  for (let i = 0; i < count; i++) {
    const u = count <= 1 ? 0 : i / (count - 1);
    const xBase = pad + u * extent;
    // Less wander as the band densifies — keeps the single row honest.
    const wander = Math.sin(i * 2.4 + t * 1.9) * (1 - life * 0.75) * 0.7;
    const x = Math.min(pad + extent, Math.max(pad, xBase + wander));
    const uNorm = extent > 0 ? (x - pad) / extent : 0;

    let d = uNorm - wave;
    if (d > 0.5) d -= 1;
    if (d < -0.5) d += 1;
    const swell = Math.exp(-d * d * 16);

    const isSpark = i === sparkSlot;
    const spark = isSpark ? 0.35 + 0.65 * (0.5 + 0.5 * Math.sin(t * 10)) : 0;
    const isTip = i === count - 1;
    const tipBoost = isTip ? tipPulse * 0.35 : 0;

    const baseR = 0.48 + life * 0.12;
    const r = baseR + swell * 0.75 + spark * 0.2 + tipBoost * 0.25;
    const alpha = 0.1 + life * 0.12 + swell * 0.5 + spark + tipBoost;
    // Vertical motion stays tiny — one row, no wrap.
    const y = cy + Math.sin(i * 1.8 + t * 2.2) * H * 0.05;

    paintDot(ctx, x, y, r, 0.38 + swell * 0.5 + spark * 0.2, alpha, hueDeg, theme, swell > 0.45 || isSpark || isTip);
  }

  ctx.globalCompositeOperation = "source-over";
}

export const THINKING_ORB_HUE = "#8b5cf6";
export const THINKING_ORB_LABEL = "Thinking…";

/** Neutral ink for the general working orb — not a tool/thinking family hue. */
export const WORKING_ORB_HUE = "#71717a";
export const WORKING_ORB_LABEL = "Working…";

export const TOOL_ORB_LABELS: Record<ToolOrbFamily, string> = {
  read: "Reading…",
  write: "Writing…",
  search: "Searching…",
  intel: "Analysing…",
  run: "Running…",
  web: "Fetching…",
  agent: "Delegating…",
  del: "Deleting…",
  neutral: "Working…",
};

export function drawToolOrb(family: ToolOrbFamily, c: OrbDrawCtx): void {
  switch (family) {
    case "read":
      drawGlobe(c, 6, 16, 0.32, 0.06, { speed: 1.1, width: 0.55 });
      break;
    case "search":
      drawGlobe(c, 6, 18, 0.55, 0.08, { speed: 2.2, width: 0.75 });
      break;
    case "write":
      drawSash(c);
      break;
    case "intel":
      drawSolve(c);
      break;
    case "run":
      drawOrbits(c, 5, 14, 2);
      break;
    case "web":
      drawRipple(c);
      break;
    case "agent":
      drawOrbits(c, 3, 10, 1);
      drawOrbits({ ...c, time: c.time * 1.35 + 0.4 }, 2, 8, 1);
      break;
    case "del":
      drawContract(c);
      break;
    default:
      drawNeutral(c);
  }
}
