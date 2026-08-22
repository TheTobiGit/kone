/**
 * What there is to choose from when you give an agent a bot: a body shape, a
 * colour, and a resting expression.
 *
 * Three independent axes, deliberately. A bot is an agent's mark, and a maker
 * picking one wants to land somewhere nobody else is — three small lists
 * multiply out to 1,536 distinct bots, which is enough that a roster of a dozen
 * agents never collides, while each axis stays short enough to scan in a picker.
 *
 * The ids are spelled out as unions rather than derived from the arrays. That is
 * what lets a stored bot be type-checked against what this build actually
 * offers, so a shape dropped from a later build fails to compile at every reader
 * instead of silently drawing nothing.
 */
import {
  EYE_H,
  EYE_SPLIT,
  EYE_W,
  hullOfCircles,
  normalizeProfile,
  PROFILE_SAMPLES,
  profileFromPolygon,
  regularPolygonProfile,
  REST_GAZE,
  superellipseProfile,
  TAU,
  unionOfCirclesProfile,
  type HeadGaze,
} from "./geometry";

// ── shapes ──────────────────────────────────────────────────────────────────

export type BotFormId =
  | "circle"
  | "pebble"
  | "squircle"
  | "capsule"
  | "triangle"
  | "hexagon"
  | "cloud"
  | "droplet";

export interface BotForm {
  id: BotFormId;
  /** What a picker calls it. */
  label: string;
  /** `r(theta)` at `PROFILE_SAMPLES` angles, in units of the body's unit radius. */
  radii: number[];
}

const ANGLES = Array.from({ length: PROFILE_SAMPLES }, (_, i) => (i / PROFILE_SAMPLES) * TAU);

/** A circle pushed around by two low harmonics — irregular but still smooth. */
const pebble = normalizeProfile(
  ANGLES.map((a) => 1 + 0.075 * Math.cos(2 * a + 0.5) + 0.035 * Math.cos(3 * a + 2.1)),
  1.02,
);

/** Lobes: wide along the bottom, two humps on top. */
const cloud = normalizeProfile(
  unionOfCirclesProfile([
    { x: -0.44, y: 0.2, r: 0.54 },
    { x: 0.46, y: 0.2, r: 0.5 },
    { x: 0.02, y: 0.3, r: 0.6 },
    { x: -0.24, y: -0.3, r: 0.48 },
    { x: 0.3, y: -0.24, r: 0.44 },
  ]),
  1.02,
);

/** A broad disc below, tapering to a point above. */
const droplet = normalizeProfile(
  profileFromPolygon(hullOfCircles(0, 0.28, 0.66, 0, -0.96, 0.05), 0, 0),
  1.04,
);

/** Lying down: the hull of two discs side by side. */
const capsule = profileFromPolygon(hullOfCircles(-0.42, 0, 0.62, 0.42, 0, 0.62), 0, 0);

export const BOT_FORMS: readonly BotForm[] = [
  { id: "circle", label: "Circle", radii: new Array(PROFILE_SAMPLES).fill(1) },
  { id: "pebble", label: "Pebble", radii: pebble },
  // Normalised to 1.15 rather than ~1.02: a superellipse's longest radius is its
  // diagonal, so peaking it at the circle's radius leaves a shape that reads
  // noticeably smaller than the circle beside it.
  { id: "squircle", label: "Squircle", radii: normalizeProfile(superellipseProfile(4.2), 1.15) },
  { id: "capsule", label: "Capsule", radii: capsule },
  // -90deg puts one vertex at the top of the screen, since y runs down.
  { id: "triangle", label: "Triangle", radii: regularPolygonProfile(3, 1.12, 0.34, -90) },
  // 0deg puts vertices left and right, so the top and bottom edges are flat.
  { id: "hexagon", label: "Hexagon", radii: regularPolygonProfile(6, 1.04, 0.26, 0) },
  { id: "cloud", label: "Cloud", radii: cloud },
  { id: "droplet", label: "Droplet", radii: droplet },
];

export const DEFAULT_BOT_FORM: BotFormId = "circle";

/**
 * The largest radius any shape here reaches.
 *
 * The renderer divides by this so every shape fits the tile it is given. Taken
 * from the catalogue rather than written down, so adding a wider shape can't
 * quietly start clipping the ones already drawn.
 */
export const FORM_HEADROOM = BOT_FORMS.reduce(
  (peak, form) => Math.max(peak, ...form.radii),
  1,
);

// ── colours ─────────────────────────────────────────────────────────────────

export type BotColorId =
  | "ink"
  | "cream"
  | "brown"
  | "red"
  | "orange"
  | "amber"
  | "green"
  | "teal"
  | "blue"
  | "violet"
  | "pink"
  | "grey";

export interface BotColor {
  id: BotColorId;
  label: string;
  hex: string;
}

/**
 * Literal hex, not theme roles.
 *
 * Every other colour in the app is a role that re-themes, and this is the one
 * place that would be wrong: a bot's colour is a choice the maker made to tell
 * their agent apart from the others, so it has to survive a theme switch
 * unchanged. The two neutrals at the ends are what keep a bot able to opt out of
 * having a colour at all.
 */
export const BOT_COLORS: readonly BotColor[] = [
  { id: "ink", label: "Ink", hex: "#0a0a0c" },
  { id: "brown", label: "Brown", hex: "#8b5e3c" },
  { id: "red", label: "Red", hex: "#e8483f" },
  { id: "orange", label: "Orange", hex: "#f08a24" },
  { id: "amber", label: "Amber", hex: "#f0b429" },
  { id: "green", label: "Green", hex: "#3ecf8e" },
  { id: "teal", label: "Teal", hex: "#2fbfa0" },
  { id: "blue", label: "Blue", hex: "#3b93f0" },
  { id: "violet", label: "Violet", hex: "#8b5cf6" },
  { id: "pink", label: "Pink", hex: "#e152b0" },
  { id: "grey", label: "Grey", hex: "#a3a3a3" },
  { id: "cream", label: "Cream", hex: "#f1efe9" },
];

export const DEFAULT_BOT_COLOR: BotColorId = "ink";

// ── expressions ─────────────────────────────────────────────────────────────

export type BotExpressionId =
  | "neutral"
  | "attentive"
  | "surprised"
  | "excited"
  | "happy"
  | "gleeful"
  | "angry"
  | "sad"
  | "afraid"
  | "wary"
  | "confused"
  | "curious"
  | "proud"
  | "shy"
  | "bored"
  | "sleepy";

/** One eye. Sizes are in units of the body's unit radius. */
export interface BotEye {
  /** Width — the capsule's short axis. */
  w: number;
  /** Height — its long axis. */
  h: number;
  /** 1 is open, 0 shut. */
  open: number;
  /**
   * The capsule's own tilt in degrees, positive leaning its top to the right,
   * applied AFTER the sphere's tangent frame.
   *
   * Without it both eyes can only lean the same way — that is head roll — and
   * anger and sadness, which both want the two eyes tilted opposite each other,
   * are simply out of reach.
   */
  tilt: number;
}

export interface BotExpression {
  id: BotExpressionId;
  label: string;
  gaze: HeadGaze;
  /** Half the separation of the eyes across the sphere, in degrees. */
  split: number;
  /** Inner eye, then outer. */
  eyes: [BotEye, BotEye];
}

const eye = (w: number, h: number, tilt = 0, open = 1): BotEye => ({ w, h, tilt, open });

/** Both eyes alike, tilts mirrored. */
const pair = (w: number, h: number, tilt = 0, open = 1): [BotEye, BotEye] => [
  eye(w, h, tilt, open),
  eye(w, h, -tilt, open),
];

/**
 * The sixteen resting faces.
 *
 * The whole vocabulary is eye width, eye height, tilt and gaze — there is no
 * mouth and no brow — so each expression has to be legible from those four
 * alone. Two rules fall out of that and are worth knowing before adjusting any
 * of these: a squinted eye must stay clearly flat (a width-to-height ratio near
 * 1 reads as round, and its tilt then becomes invisible), and an expression that
 * wants asymmetry has to break symmetry on both axes at once — mismatched sizes
 * AND mismatched tilts — or it just looks like a wink.
 */
export const BOT_EXPRESSIONS: readonly BotExpression[] = [
  {
    /**
     * Looking straight out, keeping the signature lean.
     *
     * Deliberately NOT the resting orientation the geometry defines. Idling, the
     * head is turned up and to its right and the eyes ride near the limb of the
     * sphere — alive while it drifts, but held still at that angle the two
     * capsules read as glare on a marble rather than as a face. Aiming forward is
     * the same geometry pointed at the viewer: eyes level, the -13deg roll kept.
     */
    id: "neutral",
    label: "Neutral",
    gaze: { yaw: 0, pitch: 0, roll: REST_GAZE.roll },
    split: EYE_SPLIT,
    eyes: [eye(EYE_W, EYE_H), eye(EYE_W, EYE_H)],
  },
  {
    id: "attentive",
    label: "Attentive",
    gaze: { yaw: 4, pitch: 5, roll: -4 },
    split: 16,
    eyes: pair(0.21, 0.44),
  },
  {
    id: "surprised",
    label: "Surprised",
    gaze: { yaw: 3, pitch: -3, roll: 0 },
    split: 19,
    eyes: pair(0.45, 0.47),
  },
  {
    id: "excited",
    label: "Excited",
    gaze: { yaw: 6, pitch: -14, roll: 0 },
    split: 19.5,
    eyes: pair(0.4, 0.56, -10),
  },
  {
    // squinted into arcs: the tops converge a little
    id: "happy",
    label: "Happy",
    gaze: { yaw: 5, pitch: 9, roll: 0 },
    split: 17,
    eyes: pair(0.27, 0.17, 14),
  },
  {
    id: "gleeful",
    label: "Gleeful",
    gaze: { yaw: 4, pitch: 14, roll: 0 },
    split: 18,
    eyes: pair(0.34, 0.13, 20),
  },
  {
    // tops converging hard toward the centre, over narrowed eyes
    id: "angry",
    label: "Angry",
    gaze: { yaw: 3, pitch: 7, roll: 0 },
    split: 17,
    eyes: pair(0.34, 0.15, 30),
  },
  {
    // the inverse: tops diverging, and the gaze drops
    id: "sad",
    label: "Sad",
    gaze: { yaw: 3, pitch: -13, roll: 0 },
    split: 16,
    eyes: pair(0.22, 0.4, -28),
  },
  {
    id: "afraid",
    label: "Afraid",
    gaze: { yaw: 2, pitch: -20, roll: 0 },
    split: 20.5,
    eyes: pair(0.4, 0.6),
  },
  {
    // one eye distinctly more shut than the other
    id: "wary",
    label: "Wary",
    gaze: { yaw: 12, pitch: 6, roll: -6 },
    split: 16,
    eyes: [eye(0.21, 0.4), eye(0.22, 0.15)],
  },
  {
    id: "confused",
    label: "Confused",
    gaze: { yaw: -14, pitch: 3, roll: 8 },
    split: 16.5,
    eyes: [eye(0.2, 0.44, -18), eye(0.28, 0.17, 14)],
  },
  {
    // the head leans: the roll is what carries the curiosity here
    id: "curious",
    label: "Curious",
    gaze: { yaw: 16, pitch: -9, roll: -15 },
    split: 16.5,
    eyes: [eye(0.24, 0.46, -8), eye(0.2, 0.38, -8)],
  },
  {
    id: "proud",
    label: "Proud",
    gaze: { yaw: 5, pitch: 17, roll: 0 },
    split: 17,
    eyes: pair(0.3, 0.15, 18),
  },
  {
    id: "shy",
    label: "Shy",
    gaze: { yaw: -19, pitch: -14, roll: -7 },
    split: 14,
    eyes: pair(0.17, 0.3),
  },
  {
    // horizontal slits, and the gaze wanders off to the side
    id: "bored",
    label: "Bored",
    gaze: { yaw: -22, pitch: 2, roll: 0 },
    split: 16,
    eyes: pair(0.3, 0.12),
  },
  {
    // lids half down — carried by `open`, so it is a vertical squash on screen
    id: "sleepy",
    label: "Sleepy",
    gaze: { yaw: 6, pitch: -9, roll: -3 },
    split: 16,
    eyes: pair(0.2, 0.42, 0, 0.42),
  },
];

export const DEFAULT_BOT_EXPRESSION: BotExpressionId = "neutral";

// ── lookups ─────────────────────────────────────────────────────────────────
// Keyed by `string`, not by the id unions: a caller is asking with a value read
// back out of the store, so it is exactly the case where the type is a claim
// rather than a fact. Every one of these falls back to the default, so a bot
// stored by a build that offered a shape this one dropped still draws.

const FORM_BY_ID = new Map<string, BotForm>(BOT_FORMS.map((s) => [s.id, s]));
const COLOR_BY_ID = new Map<string, BotColor>(BOT_COLORS.map((c) => [c.id, c]));
const EXPRESSION_BY_ID = new Map<string, BotExpression>(BOT_EXPRESSIONS.map((e) => [e.id, e]));

export function botForm(id: string | null | undefined): BotForm {
  return FORM_BY_ID.get(id ?? "") ?? FORM_BY_ID.get(DEFAULT_BOT_FORM)!;
}

export function botColor(id: string | null | undefined): BotColor {
  return COLOR_BY_ID.get(id ?? "") ?? COLOR_BY_ID.get(DEFAULT_BOT_COLOR)!;
}

export function botExpression(id: string | null | undefined): BotExpression {
  return EXPRESSION_BY_ID.get(id ?? "") ?? EXPRESSION_BY_ID.get(DEFAULT_BOT_EXPRESSION)!;
}
