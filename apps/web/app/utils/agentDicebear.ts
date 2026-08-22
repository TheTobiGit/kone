/**
 * Drawn portraits — the picture for an agent that shouldn't wear a photograph.
 *
 * A generated photo says "a person"; these say "a character", which is the right
 * answer for an agent a maker thinks of as a tool rather than a colleague. Both
 * land on the same stored shape, so nothing downstream can tell them apart.
 *
 * This module is loaded on demand, and that is the whole reason it is a module.
 * Each style carries its own library of parts, so importing six of them is a
 * few hundred kilobytes that would otherwise sit in the first paint of an app
 * where almost nobody opens this picker.
 *
 * A portrait is stored by value like every other picture, as the SVG itself
 * rather than a raster: it is a fraction of the size of the JPEG a photo needs,
 * and it stays sharp at any size the app grows into. Nothing is stored about
 * which style or seed made it — the picture is the choice, and re-deriving it
 * later would only be a way for it to change.
 */
import { createAvatar, type Options, type Style } from "@dicebear/core";
import {
  adventurerNeutral,
  lorelei,
  micah,
  notionists,
  openPeeps,
  personas,
} from "@dicebear/collection";
import type { AgentAvatar } from "~/utils/agents";

/** A style the picker offers. Six, out of the thirty-odd there are: the ones
 *  that draw a face rather than a toy, a pattern, or a robot — a robot being
 *  what a bot already is. */
export interface DicebearStyle {
  id: string;
  label: string;
  /** The drawing itself. Each style has its own option schema, so the six here
   *  are held as styles that take only the shared options — which is all this
   *  needs, since the shared ones are the only options passed. */
  style: Style<Options>;
}

export const DICEBEAR_STYLES: readonly DicebearStyle[] = [
  { id: "notionists", label: "Line", style: notionists },
  { id: "lorelei", label: "Soft", style: lorelei },
  { id: "micah", label: "Flat", style: micah },
  { id: "personas", label: "Plain", style: personas },
  { id: "openPeeps", label: "Sketch", style: openPeeps },
  { id: "adventurerNeutral", label: "Storybook", style: adventurerNeutral },
];

/**
 * Grounds a portrait is drawn on.
 *
 * Muted clays, sages and slates — the same family the derived guest faces use,
 * so a roster of pictures reads as one set rather than a sticker album. Passed
 * as a list, since the style picks from it by seed: two agents on the same style
 * still come out different colours.
 */
const GROUNDS = [
  "d8cfc4", "cfd3c8", "cdd3d8", "d9cdc9", "d3ccd8",
  "d8d3c4", "c9d1cf", "d8c9c9",
];

/** A fresh seed. Random rather than derived from the agent's name: the maker is
 *  shuffling for a face they like, and a name they haven't typed yet would hand
 *  back the same portrait every time. */
export function newSeed(): string {
  return Math.random().toString(36).slice(2, 12);
}

/** One portrait, ready to store. */
export function drawPortrait(style: DicebearStyle, seed: string): AgentAvatar {
  const svg = createAvatar(style.style, {
    seed,
    backgroundColor: GROUNDS,
    // Round, so it sits in the same frame a photograph does.
    radius: 50,
    // Inlined SVGs share one document, so their internal ids have to be unique
    // or the first one on the page clips all the others.
    randomizeIds: true,
  }).toString();

  // Encoded rather than base64: an SVG is text, and a percent-encoded data URL
  // stays roughly the size of the markup instead of gaining a third.
  return { source: "dicebear", src: `data:image/svg+xml,${encodeURIComponent(svg)}` };
}
