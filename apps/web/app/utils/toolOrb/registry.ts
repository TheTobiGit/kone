// Mode key → frame painter. Kept separate from the presets so tree shaking
// can in principle drop unused modes in custom builds.

import type { ModeKey } from "./presets";
import type { ModeDraw } from "./types";
import { drawOrbits } from "./orbits";
import { drawGlobe, drawRubik } from "./lattice";
import { drawWeb } from "./web";
import { drawRibbon } from "./ribbon";
import { drawFolio } from "./folio";
import { drawNib } from "./nib";
import { drawGate } from "./gate";
import { drawDelegate } from "./delegate";
import { drawErode } from "./erode";
import { drawNeutral } from "./neutral";

export const MODE_DRAWS = {
  orbits: drawOrbits,
  globe: drawGlobe,
  rubik: drawRubik,
  web: drawWeb,
  // ring shares ribbon's painter — the `faceOn` profile flag switches it
  ring: drawRibbon,
  folio: drawFolio,
  nib: drawNib,
  gate: drawGate,
  delegate: drawDelegate,
  erode: drawErode,
  neutral: drawNeutral,
} satisfies Record<ModeKey, ModeDraw>;
