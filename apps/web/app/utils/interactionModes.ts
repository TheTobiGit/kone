import type { InteractionMode } from "~/types/desktop";

// The autonomy ladder — how much the agent may do without asking — as the
// composer's mode control and the Composer settings page both draw it. One
// table so the rung a new chat opens on and the rung the composer cycles to
// always carry the same name, words and hue.
//
// Each rung maps to a real approval/sandbox pairing downstream. The hue is a
// soft cue that climbs with the autonomy: calm at the bottom, warm at the top.

export type InteractionModeMeta = {
  id: InteractionMode;
  label: string;
  /** The rung in a sentence, for the composer's tooltip. */
  title: string;
  hue: string;
  /** What it does alone and what it stops for, the settings hint's two halves. */
  alone: string;
  asks: string;
};

export const INTERACTION_MODES: readonly InteractionModeMeta[] = [
  {
    id: "ask",
    label: "Ask user",
    title: "Ask user — reads and asks before any change",
    hue: "#6E8BEF",
    alone: "Reads and searches on its own",
    asks: "asks before it edits or runs anything",
  },
  {
    id: "accept-edits",
    label: "Edits only",
    title: "Edits only — auto-approves file edits, asks before commands",
    hue: "#5EAF8C",
    alone: "Reads and edits files on its own",
    asks: "asks before running commands",
  },
  {
    id: "full-access",
    label: "Full access",
    title: "Full access — runs everything without prompting",
    hue: "#D08466",
    alone: "Reads, edits and runs commands on its own",
    asks: "never stops to ask",
  },
];

/** The rung a project opens on when nothing is stored — the middle one. */
export const FALLBACK_MODE: InteractionMode = "accept-edits";

export function isInteractionMode(value: unknown): value is InteractionMode {
  return INTERACTION_MODES.some((m) => m.id === value);
}
