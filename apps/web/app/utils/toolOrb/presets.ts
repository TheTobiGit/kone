// The shipped tunings: every turn state × two sizes, baked from the
// kone-only modes follow the same ranges). `count`/`size` are multipliers
// over the base fine profiles; `speed` multiplies the shared clock.
// Resolved once per (mode, size) pair and cached — the render loop sees
// plain numbers.

import type { ModeOpts, OrbSize, TurnOrbState } from "./types";
import { BASE_PROFILES, scaleCounts, scaleRadii } from "./profiles";

export type ModeKey =
  | "orbits"
  | "globe"
  | "rubik"
  | "web"
  | "ring"
  | "folio"
  | "nib"
  | "gate"
  | "delegate"
  | "erode"
  | "neutral";

// reference mode is used: working = particles on tilted orbits, searching
// = a scan meridian sweeping a dotted globe, solving = bands scrambling
// back to solved, connecting = a constellation wiring itself, and the
// own "Thinking…" ring for kone's quiet thinking beat. The
// tool families with no reference counterpart (read / write / run / agent /
// del / neutral) are their own modes at the same quality.
export const STATE_TO_MODE: Record<TurnOrbState, ModeKey> = {
  working: "orbits",
  thinking: "ring",
  read: "folio",
  write: "nib",
  search: "globe",
  intel: "rubik",
  run: "gate",
  web: "web",
  agent: "delegate",
  del: "erode",
  neutral: "neutral",
};

interface Preset {
  speed: number;
  count: number;
  size: number;
  /** Extra mode opts merged verbatim after scaling. */
  extra?: ModeOpts;
}

const PRESETS: Record<ModeKey, Record<OrbSize, Preset>> = {
  orbits: {
    64: { speed: 1.885, count: 1, size: 1 },
    20: { speed: 3.9, count: 0.238, size: 2.4 },
  },
  globe: {
    64: { speed: 2.015, count: 0.42, size: 1.15, extra: { scanMul: 4.08, dimBase: 0.45 } },
    20: { speed: 2.665, count: 0.105, size: 1.75, extra: { scanMul: 4.335, dimBase: 0.45 } },
  },
  rubik: {
    64: { speed: 1.82, count: 0.35, size: 1.05 },
    20: { speed: 1.95, count: 0.088, size: 1.9 },
  },
  web: {
    64: { speed: 3.315, count: 1.35, size: 0.95 },
    20: { speed: 6.63, count: 0.25, size: 1.52 },
  },
  ring: {
    64: { speed: 3.24, count: 0.25, size: 0.956, extra: { spin: 0, bandMul: 3.627, wobMul: 0.368 } },
    20: { speed: 3.78, count: 0.028, size: 1.622, extra: { spin: 0, bandMul: 3.968, wobMul: 0.565 } },
  },
  folio: {
    64: { speed: 2.2, count: 0.7, size: 1.1 },
    20: { speed: 2.6, count: 0.4, size: 1.65 },
  },
  nib: {
    64: { speed: 2.4, count: 0.8, size: 1.05 },
    20: { speed: 3.0, count: 0.45, size: 1.6 },
  },
  gate: {
    64: { speed: 2.6, count: 0.8, size: 1.1 },
    20: { speed: 3.4, count: 0.55, size: 1.7 },
  },
  delegate: {
    64: { speed: 2.0, count: 0.8, size: 1.0 },
    20: { speed: 3.2, count: 0.3, size: 1.5 },
  },
  erode: {
    64: { speed: 2.0, count: 0.6, size: 1.1 },
    20: { speed: 2.6, count: 0.2, size: 1.7 },
  },
  neutral: {
    64: { speed: 1.0, count: 1, size: 1.2 },
    20: { speed: 1.0, count: 1, size: 1.8 },
  },
};

export interface Resolved {
  mode: ModeKey;
  speed: number;
  opts: ModeOpts;
}

const cache = new Map<string, Resolved>();

/** The nearest shipped preset for a rendered size (kone orbs render 14–28px). */
function presetSizeOf(size: number): OrbSize {
  return size <= 32 ? 20 : 64;
}

/** Resolve a mode + rendered size to its fully-scaled draw options. */
export function resolveMode(mode: ModeKey, size: number): Resolved {
  const key = `${mode}-${presetSizeOf(size)}`;
  const hit = cache.get(key);
  if (hit) return hit;

  const preset = PRESETS[mode][presetSizeOf(size)];
  let opts: ModeOpts = { ...BASE_PROFILES[mode] };
  if (preset.count !== 1) opts = scaleCounts(opts, preset.count);
  if (preset.size !== 1) opts = scaleRadii(opts, preset.size);
  if (preset.extra) opts = { ...opts, ...preset.extra };

  const resolved: Resolved = { mode, speed: preset.speed, opts };
  cache.set(key, resolved);
  return resolved;
}

/** Resolve a turn state (working / thinking / a tool family) to its mode. */
export function resolvePreset(state: TurnOrbState, size: number): Resolved {
  return resolveMode(STATE_TO_MODE[state], size);
}
