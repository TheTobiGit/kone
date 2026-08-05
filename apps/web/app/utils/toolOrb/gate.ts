// Gate: a chevron packet launches through a command gate (run). The mark
// sits inside a faint ghost globe — the orb's body — with a dotted track
// across it; two rails frame the gate, and the bright chevron runs the
// track with a fading wake behind it.

import type { Dot, ModeDraw } from "./types";
import { fibDir, frac, makeProj, paint, radiusScale, smooth } from "./core";

export const drawGate: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.82;
  const pt = makeProj(t * 0.3, 0.26, cx, cy, R);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const ghostN = o.ghostN ?? 60;
  const rails = o.rails ?? 8;
  const chev = o.chev ?? 5;
  const wake = o.wake ?? 4;
  const baseN = o.baseN ?? 9;
  const u = smooth(frac(t * 0.8));
  const ax = -0.22 + u * 0.44;
  const zSpan = 0.35;

  const dots: Dot[] = [];
  // the orb body — a faint ghost sphere behind the gate
  for (let i = 0; i < ghostN; i++) {
    const d = fibDir(i, ghostN);
    const [px, py, z] = pt(d[0], d[1], d[2]);
    const depth = (z + 1) / 2;
    dots.push({ x: px, y: py, z, r: 0.8 * rs, white: 0.74, a: 0.07 + 0.18 * depth });
  }
  // the track the packet runs along
  for (let i = 0; i < baseN; i++) {
    const x = -0.42 + (baseN === 1 ? 0 : (i / (baseN - 1)) * 0.84);
    const [px, py, z] = pt(x, 0, 0.02);
    const depth = (z / zSpan + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 1) + (o.rDepth ?? 1.5) * depth) * 0.8 * rs,
      white: 0.5,
      a: 0.6,
    });
  }
  // the gate — two dotted rails
  for (const sx of [-0.4, 0.4]) {
    for (let i = 0; i < rails; i++) {
      const y = -0.28 + (rails === 1 ? 0 : (i / (rails - 1)) * 0.56);
      const [px, py, z] = pt(sx, y, 0);
      const depth = (z / zSpan + 1) / 2;
      dots.push({
        x: px,
        y: py,
        z,
        r: ((o.rBase ?? 1) + (o.rDepth ?? 1.5) * depth) * rs,
        white: 0.5,
        a: 0.9,
      });
    }
  }
  // the wake — fading dots trailing the apex along the track
  for (let w = 1; w <= wake; w++) {
    const wx = ax - w * 0.06;
    if (wx < -0.42) break;
    const k = w / (wake + 1);
    const [px, py, z] = pt(wx, 0, 0.24 - k * 0.05);
    dots.push({
      x: px,
      y: py,
      z,
      r: ((o.rBase ?? 1) + (o.rActive ?? 0.9) * (1 - k)) * rs,
      white: 0.12 + 0.3 * k,
      a: 1 - k * 0.7,
    });
  }
  // the chevron — apex runs left → right through the gate
  for (let k = 0; k < chev; k++) {
    const f = chev === 1 ? 0 : k / (chev - 1);
    for (const arm of [-1, 1]) {
      const [px, py, z] = pt(ax - f * 0.13, arm * f * 0.1, 0.28);
      dots.push({
        x: px,
        y: py,
        z,
        r: ((o.rBase ?? 1) + (o.rActive ?? 0.9) * (1 - f)) * rs,
        white: 0.1 + 0.3 * f,
        a: 1 - f * 0.5,
      });
    }
  }
  // the apex
  const [apx, apy, az] = pt(ax, 0, 0.32);
  dots.push({
    x: apx,
    y: apy,
    z: az,
    r: ((o.rBase ?? 1) + (o.rActive ?? 0.9) + 0.4) * rs,
    white: 0.05,
    a: 1,
  });
  paint(ctx, dots, dark, hueDeg, o.rMin);
};
