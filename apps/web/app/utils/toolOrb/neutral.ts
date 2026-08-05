// Neutral: a quiet static orb — a dotted ring around a soft core, barely
// turning (unnamed / misc tools). The calmest mode: near-static, low
// density, one shape.

import type { Dot, ModeDraw } from "./types";
import { makeProj, paint, radiusScale } from "./core";

export const drawNeutral: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const pt = makeProj(t * 0.05, 0.22, cx, cy, 1);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const ringN = o.ringN ?? 8;

  const dots: Dot[] = [];
  for (let i = 0; i < ringN; i++) {
    const a = (i / ringN) * Math.PI * 2;
    const [px, py, z] = pt(Math.cos(a) * 0.26, Math.sin(a) * 0.26, 0);
    const depth = (z / 0.35 + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 0.9) + (o.rDepth ?? 1.5) * depth) * rs,
      white: 0.45,
      a: 0.8,
    });
  }
  const [px, py, z] = pt(0, 0, 0.12);
  dots.push({
    x: px,
    y: py,
    z,
    r: ((o.rBase ?? 0.9) + 0.55) * rs,
    white: 0.18,
    a: 0.85,
  });
  paint(ctx, dots, dark, hueDeg, o.rMin);
};
