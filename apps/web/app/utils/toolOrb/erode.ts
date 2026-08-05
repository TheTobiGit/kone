// Erode: an erosion front consumes the dotted globe, and the taken dots
// funnel into a corner sink (del). The front sweeps the diagonal of the
// projected field; dots ahead of it hold the globe, dots behind stream to
// the sink and fade.

import type { Dot, ModeDraw } from "./types";
import { clamp01, frac, makeProj, paint, radiusScale, smooth } from "./core";

export const drawErode: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.8;
  const pt = makeProj(t * 0.42, 0.32, cx, cy, R);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const p = frac(t * 0.22);
  const latRings = o.latRings ?? 9;
  const lonDensity = o.lonDensity ?? 22;

  // the sink: a fixed point on the sphere, projected once per frame
  const sl = Math.hypot(0.5, 0.5, 0.25);
  const [sx, sy] = pt(0.5 / sl, 0.5 / sl, 0.25 / sl);

  const dots: Dot[] = [];
  for (let li = 0; li <= latRings; li++) {
    const lat = -Math.PI / 2 + (li / latRings) * Math.PI;
    const cosLat = Math.cos(lat);
    const sinLat = Math.sin(lat);
    const lonCount = Math.max(1, Math.round(Math.abs(cosLat) * lonDensity));
    for (let lj = 0; lj < lonCount; lj++) {
      const lon = (lj / lonCount) * 2 * Math.PI;
      const [px, py, z] = pt(cosLat * Math.cos(lon), sinLat, cosLat * Math.sin(lon));
      const depth = (z + 1) / 2;
      // front coordinate: the diagonal across projected space, 0..1
      const s = clamp01(((px - cx) / R + 1) * 0.25 + ((py - cy) / R + 1) * 0.25);
      if (s >= p) {
        dots.push({
          x: px,
          y: py,
          z,
          r: ((o.rBase ?? 0.9) + (o.rDepth ?? 1.6) * depth) * rs,
          white: (o.inkFar ?? 0.6) - (o.inkSpan ?? 0.5) * depth,
          a: 0.55 + 0.45 * depth,
        });
      } else {
        // taken: stream to the sink, shrinking and fading on the way
        const q = smooth(clamp01((p - s) * 4));
        dots.push({
          x: px + (sx - px) * q,
          y: py + (sy - py) * q,
          z: z - q * 0.1,
          r: ((o.rBase ?? 0.9) + (o.rActive ?? 0.7) * (1 - q)) * rs,
          white: 0.6 + 0.2 * q,
          a: (1 - q) * 0.9,
        });
      }
    }
  }
  // the sink mouth
  dots.push({
    x: sx,
    y: sy,
    z: 0.2,
    r: ((o.rBase ?? 0.9) + (o.rActive ?? 0.7) + 0.3) * rs,
    white: 0.25,
    a: 0.9,
  });
  paint(ctx, dots, dark, hueDeg, o.rMin);
};
