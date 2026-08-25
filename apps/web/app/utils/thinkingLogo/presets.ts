import type { LogoPointSet, SeatMap } from "./cloud";
import type { LogoBinding, ModeFrame } from "./core";
import { frameLogoAssemble, frameLogoScan, frameLogoWork, seatMap } from "./logo";
import { frameLogoCrystal, frameLogoSolve, frameLogoWait, frameLogoWave } from "./logoDeform";

export type LogoMode =
  | "assemble"
  | "scan"
  | "work"
  | "solve"
  | "wave"
  | "wait"
  | "crystal";

export type LogoState =
  | "thinking"
  | "searching"
  | "working"
  | "solving"
  | "listening"
  | "waiting"
  | "generating"
  | "read"
  | "write"
  | "search"
  | "run"
  | "intel"
  | "agent"
  | "del"
  | "web"
  | "neutral";

export const LOGO_STATE_TO_MODE: Record<LogoState, LogoMode> = {
  thinking: "assemble",
  searching: "scan",
  working: "work",
  solving: "solve",
  listening: "wave",
  waiting: "wait",
  generating: "crystal",
  read: "scan",
  write: "crystal",
  search: "scan",
  run: "work",
  intel: "solve",
  agent: "assemble",
  del: "assemble",
  web: "scan",
  neutral: "work",
};

export const LOGO_MODE_FRAMES: Record<LogoMode, ModeFrame> = {
  assemble: frameLogoAssemble,
  scan: frameLogoScan,
  work: frameLogoWork,
  solve: frameLogoSolve,
  wave: frameLogoWave,
  wait: frameLogoWait,
  crystal: frameLogoCrystal,
};

export interface LogoPreset {
  speed: number;
  opts: Record<string, number | undefined>;
}

export const LOGO_PRESETS: Record<LogoMode, LogoPreset> = {
  assemble: {
    speed: 1,
    opts: {
      dwell: 5.5,
      turns: 1,
      morph: 1.9,
      expo: 0.3,
      settle: 0.1,
      tiltAmp: 0.34,
      stagger: 0,
      arc: 0,
      churn: 0.09,
      sphereR: 0.92,
      flightFade: 0.25,
      haloShare: 0.12,
      haloOut: 0.18,
      haloZ: 0.8,
      haloRate: 0.9,
      haloR: 0.22,
      rBase: 0.55,
      rDepth: 1.5,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  scan: {
    speed: 1,
    opts: {
      dwell: 5.5,
      turns: 1,
      morph: 1.9,
      expo: 0.3,
      settle: 0.1,
      tiltAmp: 0.34,
      sphereR: 0.94,
      scanWidth: 0.22,
      scanSwing: 1.05,
      scanRate: 0.85,
      dimBase: 0.4,
      poleEase: 1.4,
      arms: 13,
      armDepth: 0.55,
      rBase: 0.5,
      rDepth: 1.4,
      rBoost: 1.3,
      armInk: 0.16,
      scanInk: 0.3,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  work: {
    speed: 1,
    opts: {
      dwell: 5.5,
      morph: 1.9,
      turns: 0,
      settle: 0.1,
      expo: 0.3,
      lean: 0.4,
      yawAmp: 0.3,
      yawRate: 0.26,
      tilt: 0.4,
      p: 2,
      q: 3,
      rTorus: 0.68,
      rTube: 0.28,
      spin: 0.35,
      feather: 0.04,
      headWidth: 0.015,
      rBase: 0.55,
      rDepth: 1.4,
      headR: 0.55,
      headInk: 0.3,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  solve: {
    speed: 1,
    opts: {
      dwell: 5.5,
      morph: 1.9,
      turns: 1,
      settle: 0.45,
      expo: 0.3,
      tiltAmp: 0.36,
      cubeHalf: 0.62,
      moveCount: 6,
      rBase: 0.55,
      rDepth: 1.4,
      rActive: 0.3,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  wave: {
    speed: 1,
    opts: {
      dwell: 5.5,
      morph: 1.9,
      settle: 0.45,
      expo: 0.3,
      yawAmp: 0.42,
      yawRate: 0.55,
      tiltAmp: 0.26,
      wide: 1.12,
      tall: 0.5,
      waveK: 3.1,
      waveK2: 6.7,
      waveRate: 1.9,
      swing: 0.52,
      lumps: 0.12,
      loudR: 0.3,
      loudInk: 0.14,
      rBase: 0.55,
      rDepth: 1.5,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  wait: {
    speed: 1,
    opts: {
      dwell: 5.5,
      morph: 1.9,
      settle: 0.1,
      expo: 0.3,
      yawAmp: 0.22,
      yawRate: 0.3,
      tilt: 0.42,
      rings: 9,
      breatheRate: 0.75,
      breatheAmp: 0.2,
      height: 1.5,
      wide: 0.82,
      spin: 0.16,
      taper: 0.78,
      loudR: 0.25,
      loudInk: 0.12,
      rBase: 0.55,
      rDepth: 1.4,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
  crystal: {
    speed: 1,
    opts: {
      dwell: 5.5,
      morph: 1.9,
      settle: 0.1,
      expo: 0.3,
      lean: 0.5,
      yawAmp: 0.24,
      yawRate: 0.32,
      tilt: 0.2,
      crystalR: 0.94,
      spin: 0.3,
      feather: 0.03,
      headWidth: 0.012,
      dimUnstitched: 0.3,
      rBase: 0.55,
      rDepth: 1.4,
      headR: 0.5,
      headInk: 0.3,
      inkFar: 0.6,
      inkSpan: 0.5,
      inkRim: 0.16,
      rsPow: 0.6,
      rMin: 0.3,
    },
  },
};

const seatMapCache = new WeakMap<LogoPointSet, SeatMap>();

export function getSeatMap(points: LogoPointSet): SeatMap {
  let seats = seatMapCache.get(points);
  if (!seats) {
    seats = seatMap(points);
    seatMapCache.set(points, seats);
  }
  return seats;
}

export interface ResolvedLogo {
  frame: ModeFrame;
  speed: number;
  opts: Record<string, number | undefined>;
  binding: LogoBinding;
}

export function resolveLogo(
  state: LogoState,
  points: LogoPointSet,
  tune?: Record<string, number | undefined>,
): ResolvedLogo {
  const mode = LOGO_STATE_TO_MODE[state] ?? "assemble";
  const preset = LOGO_PRESETS[mode];
  const frame = LOGO_MODE_FRAMES[mode];
  const seats = getSeatMap(points);
  const opts = tune ? { ...preset.opts, ...tune } : preset.opts;
  return {
    frame,
    speed: preset.speed,
    opts,
    binding: { points, seats },
  };
}
