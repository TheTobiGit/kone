// Delegate: a parent node delegates to two children and the result packet
// runs back — three nodes on a ghost sphere with live edges (agent). A
// pocket version of the web constellation: fixed topology, one packet
// cycling parent → child → parent → child, so the delegation reads at a
// glance.

import type { Dot, ModeDraw } from "./types";
import { fibDir, frac, lerp, makeProj, paint, radiusScale, vnoise } from "./core";

// parent top-centre, children low left / right
const NODES: Array<[number, number, number]> = [
  [0, 0.52, 0.12],
  [-0.5, -0.3, 0.18],
  [0.5, -0.3, 0.18],
];
const EDGES: Array<[number, number]> = [
  [0, 1],
  [0, 2],
];

export const drawDelegate: ModeDraw = (ctx, size, t, dark, hueDeg, o) => {
  const cx = size / 2;
  const cy = size / 2;
  const R = (size / 2) * 0.8;
  const pt = makeProj(t * 0.12, 0.3, cx, cy, R);
  const rs = radiusScale(size, o.rsPow ?? 0.6);
  const ghostN = o.ghostN ?? 50;

  const dots: Dot[] = [];
  // ghost sphere — the orb's body behind the constellation
  for (let i = 0; i < ghostN; i++) {
    const d = fibDir(i, ghostN);
    const [px, py, z] = pt(d[0], d[1], d[2]);
    const depth = (z + 1) / 2;
    dots.push({ x: px, y: py, z, r: 0.8 * rs, white: 0.74, a: 0.08 + 0.2 * depth });
  }

  // nodes drift slowly on the surface under value noise
  const nodes = NODES.map(([nx, ny, nz], i) => {
    const x = nx + 0.14 * (vnoise(i * 0.31 + 9, t * 0.2) - 0.5) * 2;
    const y = ny + 0.14 * (vnoise(i * 0.53 + 27, t * 0.18) - 0.5) * 2;
    const z = nz + 0.14 * (vnoise(i * 0.77 + 55, t * 0.22) - 0.5) * 2;
    const l = Math.sqrt(x * x + y * y + z * z);
    return [x / l, y / l, z / l] as [number, number, number];
  });

  // one round trip per beat: parent → child 1 → parent → child 2
  const beat = Math.floor(t * 0.42);
  const f = frac(t * 0.42);
  const edgeIdx = [0, 1, 0, 1][beat % 4] ?? 0;

  // edges as dot chains — the edge being traversed inks brighter
  for (let e = 0; e < EDGES.length; e++) {
    const [a, b] = EDGES[e] ?? [0, 1];
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const active = e === edgeIdx;
    for (let k = 0; k < 5; k++) {
      const u = k / 4;
      const x = lerp(na[0], nb[0], u);
      const y = lerp(na[1], nb[1], u);
      const z = lerp(na[2], nb[2], u);
      const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
      const [px, py, zr] = pt(x / l, y / l, z / l);
      dots.push({
        x: px,
        y: py,
        z: zr,
        r: 0.5 * rs,
        white: active ? 0.25 : 0.5,
        a: active ? 0.9 : 0.55,
      });
    }
  }

  // the result packet running the active edge
  {
    const [a, b] = EDGES[edgeIdx] ?? [0, 1];
    const na = nodes[a]!;
    const nb = nodes[b]!;
    const x = lerp(na[0], nb[0], f);
    const y = lerp(na[1], nb[1], f);
    const z = lerp(na[2], nb[2], f);
    const l = Math.max(1e-6, Math.sqrt(x * x + y * y + z * z));
    const [px, py, zr] = pt(x / l, y / l, z / l);
    const depth = (zr + 1) / 2;
    dots.push({
      x: px,
      y: py,
      z: zr,
      r: ((o.nodeR ?? 1.3) + (o.nodeRDepth ?? 1.7) * depth) * 1.3 * rs,
      white: 0.05,
      a: 0.9,
    });
  }

  // the nodes — the parent is the largest and brightest
  for (let i = 0; i < nodes.length; i++) {
    const [x, y, z] = nodes[i] ?? [0, 0, 0];
    const [px, py, zr] = pt(x, y, z);
    const depth = (zr + 1) / 2;
    const isParent = i === 0;
    dots.push({
      x: px,
      y: py,
      z: zr,
      r: ((o.nodeR ?? 1.3) + (o.nodeRDepth ?? 1.7) * depth + (isParent ? 0.5 : 0)) * rs,
      white: (isParent ? 0.18 : 0.4) - 0.3 * depth,
      a: 1,
    });
  }

  paint(ctx, dots, dark, hueDeg, o.rMin);
};
