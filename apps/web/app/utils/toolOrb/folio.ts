// Folio: an open book — two page grids tent around a vertical spine, and
// a bright cursor row advances line by line down both pages (read). The
// pages are genuinely 3D: the tent lifts out of the screen, spins slowly
// on the spine, and the shared z-sorted painter shades it.

import type { Dot, ModeDraw } from "./types";
import { frac, makeProj, paint, radiusScale } from "./core";

export const drawFolio: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const pt = makeProj(t * 0.28, 0.3, cx, cy, 1);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const cols = o.cols ?? 7;
  const rows = o.rows ?? 6;
  const halfW = 0.3;
  const halfH = 0.26;
  const tent = 0.5;
  const row = Math.floor(frac(t * 0.36) * rows);
  const zSpan = 0.35;

  const dots: Dot[] = [];
  for (let side = -1; side <= 1; side += 2) {
    for (let r = 0; r < rows; r++) {
      const y = -halfH + (rows === 1 ? 0 : (r / (rows - 1)) * halfH * 2);
      // the page's reading state: already read, the cursor line, or ahead
      const cursor = r === row;
      const read = r < row;
      for (let cc = 0; cc < cols; cc++) {
        const x = side * halfW * (cols === 1 ? 0 : cc / (cols - 1));
        const [px, py, z] = pt(x, y, Math.abs(x) * tent);
        const depth = (z / zSpan + 1) / 2;
        dots.push({
          x: px,
          y: py,
          z,
          r: ((o.rBase ?? 1) + (o.rDepth ?? 1.6) * depth + (cursor ? (o.rActive ?? 0.85) : 0)) *
            rs,
          white: cursor ? 0.1 : read ? 0.42 : 0.62,
          a: cursor ? 1 : 0.8,
        });
      }
    }
  }
  // the spine — the deepest line of the tent
  for (let i = 0; i < 5; i++) {
    const y = -halfH + (i / 4) * halfH * 2;
    const [px, py, z] = pt(0, y, 0);
    const depth = (z / zSpan + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 1) + (o.rDepth ?? 1.6) * depth) * 0.8 * rs,
      white: 0.5,
      a: 0.7,
    });
  }
  paint(ctx, dots, dark, hueDeg, o.rMin);
};
