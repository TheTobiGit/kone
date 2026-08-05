// Shared types for the dotted 3D thought-orb engine. The states follow the
// to one tuned mode, and each mode ships two size presets (inline-text and
// chat-avatar) as separate designs, not a scale factor.

export type ModeOpts = Record<string, number | undefined>;

// The 3D primitives live in core.ts; re-exported here so the mode painters
// import one module.
export type { Dot, Line, Projector } from "./core";

/** The tool families kone's thread rows can be running. */
export type ToolOrbFamily =
  | "read"
  | "write"
  | "search"
  | "intel"
  | "run"
  | "web"
  | "agent"
  | "del"
  | "neutral";

/** Every orb the UI can ask for: the two meta states plus the tool families. */
export type TurnOrbState = "working" | "thinking" | ToolOrbFamily;

/** The two tuned size presets. Sizes between them resolve to the nearest. */
export type OrbSize = 20 | 64;

/** One frame painter: mode opts are resolved once per (mode, size) pair. */
export type ModeDraw = (
  ctx: CanvasRenderingContext2D,
  size: number,
  t: number,
  dark: boolean,
  hueDeg: number,
  o: ModeOpts,
) => void;
