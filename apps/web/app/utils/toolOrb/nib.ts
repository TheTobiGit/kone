// Nib: a writing nib travels across accumulating baselines, leaving ink
// behind — rows fill left to right and the bright nib leads the current
// line (write). The rows stack in depth so the page reads as a tilted
// plane, shaded by the shared z-sorted painter.

import type { Dot, ModeDraw } from "./types";
import { frac, makeProj, paint, radiusScale } from "./core";

export const drawNib: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const pt = makeProj(t * 0.22, 0.3, cx, cy, 1);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const rows = o.rows ?? 4;
  const cols = o.cols ?? 11;
  const cycle = frac(t * 0.34);
  const row = Math.min(rows - 1, Math.floor(cycle * rows));
  const u = frac(cycle * rows);
  const step = 0.16;

  const dots: Dot[] = [];
  for (let r = 0; r < rows; r++) {
    const y = -0.24 + r * step;
    const zRow = r * 0.05;
    for (let cc = 0; cc < cols; cc++) {
      const x = -0.3 + (cols === 1 ? 0 : (cc / (cols - 1)) * 0.6);
      const filled = r < row || (r === row && cc < Math.floor(u * cols));
      const [px, py, z] = pt(x, y, zRow);
      const depth = (z / 0.35 + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z,
        r: ((o.rBase ?? 1) + (o.rDepth ?? 1.6) * depth) * rs,
        white: filled ? 0.24 : 0.58,
        a: filled ? 0.9 : 0.6,
      });
    }
  }
  // the nib at the writing head — the brightest, largest dot
  const [px, py, z] = pt(-0.3 + u * 0.6, -0.24 + row * step, row * 0.05 + 0.06);
  dots.push({
    x: px,
    y: py,
    z,
    r: ((o.rBase ?? 1) + (o.rActive ?? 0.95)) * rs,
    white: 0.05,
    a: 1,
  });
  paint(ctx, dots, dark, hueDeg, o.rMin);
};
