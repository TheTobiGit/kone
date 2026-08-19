// Density profiles + the multiplier machinery that scales them, ported
// shipped preset (mode × size) applies count / radius multipliers on top,
// resolved once per mount.

import type { ModeOpts } from "./types";

// 2-D lattices (rings × dots-per-ring, grid rows × cols, rails × chevrons)
// come in pairs — each side takes √scale so the TOTAL dot count scales by
// `scale`; flat lists scale linearly.
const COUNT_PAIRS: ReadonlyArray<readonly [string, string]> = [
  ["latRings", "lonDensity"],
  ["rings", "lonDensity"],
  ["lanes", "segs"],
  ["cols", "rows"],
  ["rails", "chev"],
];
const COUNT_KEYS = ["orbitN", "ghostN", "nodeN", "signals", "ringN", "wake", "baseN"] as const;

// Every key that sets a dot's rendered radius — scaling all of them keeps
// a dot's near/far falloff intact while shrinking or growing the mark.
const RADIUS_KEYS = [
  "rBase",
  "rDepth",
  "rActive",
  "rDot",
  "ghostR",
  "partR",
  "partRDepth",
  "nodeR",
  "nodeRDepth",
] as const;

export function scaleCounts(opts: ModeOpts, scale: number): ModeOpts {
  const out: ModeOpts = { ...opts };
  const done = new Set<string>();
  const rt = Math.sqrt(scale);
  for (const [a, b] of COUNT_PAIRS) {
    const va = out[a];
    const vb = out[b];
    if (va != null && vb != null && !done.has(a) && !done.has(b)) {
      out[a] = Math.max(2, Math.round(va * rt));
      out[b] = Math.max(2, Math.round(vb * rt));
      done.add(a);
      done.add(b);
    }
  }
  for (const k of COUNT_KEYS) {
    const v = out[k];
    // 0 means the mode opted out of that layer entirely (ring has no ghost
    // sphere) — scaling must not resurrect it as a single stray dot
    if (v != null && v !== 0 && !done.has(k)) out[k] = Math.max(1, Math.round(v * scale));
  }
  return out;
}

export function scaleRadii(opts: ModeOpts, scale: number): ModeOpts {
  const out: ModeOpts = { ...opts };
  for (const k of RADIUS_KEYS) {
    const v = out[k];
    if (v != null) out[k] = v * scale;
  }
  return out;
}

/** Base (fine) profiles per mode, before preset multipliers. */
export const BASE_PROFILES = {
  globe: {
    latRings: 17,
    lonDensity: 44,
    rBase: 0.6,
    rDepth: 1.7,
    rBoost: 1.0,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  orbits: {
    orbitN: 12,
    ghostN: 40,
    ghostR: 0.9,
    ghostA: 0.5,
    particles: 3,
    partR: 1.2,
    partRDepth: 1.6,
    rsPow: 0.6,
    rMin: 0.3,
  },
  rubik: {
    latRings: 15,
    lonDensity: 40,
    moveCount: 14,
    rBase: 0.6,
    rDepth: 1.7,
    rActive: 0.3,
    inkFar: 0.62,
    inkSpan: 0.54,
    rsPow: 0.6,
    rMin: 0.3,
  },
  web: {
    nodeN: 30,
    thr: 0.72,
    signals: 5,
    nodeR: 1.4,
    nodeRDepth: 1.8,
    lineW: 0.8,
    rsPow: 0.6,
    rMin: 0.3,
  },
  // ring shares ribbon's painter; `faceOn` cancels the camera tilt and moves
  // the undulation onto the radius, and there is no ghost sphere behind it.
  ring: {
    lanes: 5,
    segs: 88,
    ghostN: 0,
    faceOn: 1,
    rBase: 1.1,
    rDepth: 1.7,
    rsPow: 0.6,
    rMin: 0.3,
  },
  folio: {
    cols: 7,
    rows: 6,
    rBase: 1.0,
    rDepth: 1.6,
    rActive: 0.85,
    rsPow: 0.6,
    rMin: 0.3,
  },
  nib: {
    rows: 4,
    cols: 11,
    rBase: 1.0,
    rDepth: 1.6,
    rActive: 0.95,
    rsPow: 0.6,
    rMin: 0.3,
  },
  gate: {
    ghostN: 60,
    rails: 8,
    chev: 5,
    wake: 4,
    baseN: 9,
    rBase: 1.0,
    rDepth: 1.5,
    rActive: 0.9,
    rsPow: 0.6,
    rMin: 0.3,
  },
  delegate: {
    ghostN: 50,
    nodeR: 1.3,
    nodeRDepth: 1.7,
    lineW: 0.8,
    rsPow: 0.6,
    rMin: 0.3,
  },
  erode: {
    latRings: 9,
    lonDensity: 22,
    rBase: 0.9,
    rDepth: 1.6,
    rActive: 0.7,
    inkFar: 0.6,
    inkSpan: 0.5,
    rsPow: 0.6,
    rMin: 0.3,
  },
  neutral: {
    ringN: 8,
    rBase: 0.9,
    rDepth: 1.5,
    rsPow: 0.6,
    rMin: 0.3,
  },
} satisfies Record<string, ModeOpts>;
