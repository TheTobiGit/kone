import { useStorage } from "@vueuse/core";
import type { PaneKind } from "~/types/studio";
import { LADDER_PX } from "~/utils/stripScroll";

// What width a *newly opened* pane takes, per kind. Not board state: a pane that
// already exists carries its own width on its entry (PaneEntry.width), and this
// never touches it — it only decides what a fresh thread / terminal / scratchpad
// opens at, the way the app-wide model and approval defaults seed a fresh chat.
//
// A width here is an index into the strip's rung ladder (utils/stripScroll's
// LADDER_PX), the same unit an entry stores, so nothing has to convert between a
// preference and a layout.
//
// Module-scope useStorage, like useStripPrefs: the settings pane writes it and
// useStudio reads it at open time, with no props threaded between them and no
// reload — and a change in one window is picked up by a board in another.

/** Widest rung a preference may name. */
const LAST_RUNG = LADDER_PX.length - 1;

/** The rung a pane opens at with nothing stored: the narrowest, which is what
 *  the studio has always defaulted to. */
export const DEFAULT_PANE_WIDTH = 0;

const paneWidths = useStorage<Record<PaneKind, number>>(
  "kone.studio.pane-widths",
  { thread: DEFAULT_PANE_WIDTH, terminal: DEFAULT_PANE_WIDTH, scratchpad: DEFAULT_PANE_WIDTH },
  undefined,
  // A kind added later inherits the default instead of reading undefined out of
  // a record written by an older build.
  { listenToStorageChanges: true, mergeDefaults: true },
);

function clampRung(value: number | string | undefined | null): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PANE_WIDTH;
  return Math.min(LAST_RUNG, Math.max(0, Math.round(n)));
}

export function usePaneWidthPrefs() {
  /** The rung a new pane of this kind opens at. */
  function defaultWidth(kind: PaneKind): number {
    return clampRung(paneWidths.value[kind]);
  }

  function setDefaultWidth(kind: PaneKind, rung: number): void {
    paneWidths.value = { ...paneWidths.value, [kind]: clampRung(rung) };
  }

  return { paneWidths, defaultWidth, setDefaultWidth };
}
