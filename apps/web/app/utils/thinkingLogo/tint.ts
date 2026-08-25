import type { OrbFrame } from "./core";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

/** Parse `#rgb`, `#rrggbb`, or `r,g,b`. Returns null on anything else. */
export function parseTint(value: string): Rgb | null {
  const s = value.trim();
  const hex = s.startsWith("#") ? s.slice(1) : null;
  if (hex && (hex.length === 3 || hex.length === 6)) {
    const full = hex.length === 3 ? hex.replace(/./g, (c) => c + c) : hex;
    const n = Number.parseInt(full, 16);
    if (Number.isNaN(n)) return null;
    return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
  }
  const parts = s.split(",").map((p) => Number.parseInt(p, 10));
  if (parts.length === 3 && parts.every((p) => Number.isFinite(p))) {
    const [r = 0, g = 0, b = 0] = parts;
    return { r, g, b };
  }
  return null;
}

/**
 * Pull a brand colour far enough off the substrate to survive.
 */
export function adaptTint(tint: Rgb, dark: boolean): Rgb {
  const l = (0.2126 * tint.r + 0.7152 * tint.g + 0.0722 * tint.b) / 255;
  if (dark && l < 0.42) {
    const f = (0.42 - l) / (1 - l);
    return {
      r: Math.round(tint.r + (255 - tint.r) * f),
      g: Math.round(tint.g + (255 - tint.g) * f),
      b: Math.round(tint.b + (255 - tint.b) * f),
    };
  }
  if (!dark && l > 0.62) {
    const f = (l - 0.62) / l;
    return {
      r: Math.round(tint.r * (1 - f)),
      g: Math.round(tint.g * (1 - f)),
      b: Math.round(tint.b * (1 - f)),
    };
  }
  return tint;
}

function ramp(tint: Rgb, v: number, dark: boolean, k = 1): string {
  const g = 255 * v;
  const mix = (c: number) => {
    const col = dark ? c * v : 255 + (c - 255) * (1 - v);
    const grey = dark ? g : 255 - (255 - g);
    return Math.round(grey + (col - grey) * k);
  };
  return `${mix(tint.r)},${mix(tint.g)},${mix(tint.b)}`;
}

/** Paint a finished frame in a brand colour. Lines first, as usual. */
export function paintFrameTinted(
  ctx: CanvasRenderingContext2D,
  frame: OrbFrame,
  dark: boolean,
  tint: Rgb,
): void {
  for (const l of frame.lines) {
    const w = Math.min(1, Math.max(0, l.white));
    ctx.strokeStyle = `rgba(${ramp(tint, dark ? 1 - w : w, dark)},${l.a ?? 1})`;
    ctx.lineWidth = l.w;
    ctx.beginPath();
    ctx.moveTo(l.x1, l.y1);
    ctx.lineTo(l.x2, l.y2);
    ctx.stroke();
  }
  for (const d of frame.dots) {
    const w = Math.min(1, Math.max(0, d.white));
    ctx.fillStyle = `rgba(${ramp(tint, dark ? 1 - w : w, dark, d.k ?? 1)},${d.a ?? 1})`;
    ctx.beginPath();
    ctx.arc(d.x, d.y, d.r, 0, Math.PI * 2);
    ctx.fill();
  }
}
