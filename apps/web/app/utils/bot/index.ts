/**
 * A bot, drawn: one body shape in one colour, wearing one expression.
 *
 * This is an agent's OTHER mark, and it is worth being clear about why there are
 * two. An avatar is a picture of somebody — it says who is speaking, and it
 * belongs in a transcript beside a name. A bot is a creature the agent drives,
 * and it belongs where the agent is *doing* something rather than saying it,
 * which is the composer. So a bot is built to move (see `./geometry` on why
 * every shape is a radial profile) even though nothing animates it yet, and an
 * avatar never will.
 *
 * The eyes are painted onto the body, not punched out of it with a mask. A mask
 * needs an id, one mark is mounted many times across a pane, and every mount
 * resolves `url(#id)` against the first copy in the document — which may sit in
 * a subtree that never paints, at which point every bot on screen goes blank.
 * Painted eyes carry no references, so a mark is self-contained wherever it
 * lands.
 */
import {
  botColor,
  botExpression,
  botShape,
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_EXPRESSION,
  DEFAULT_BOT_SHAPE,
  SHAPE_HEADROOM,
  type BotColorId,
  type BotExpressionId,
  type BotShapeId,
} from "./catalog";
import {
  capsulePath,
  clamp,
  closedPath,
  eyePoses,
  lidScale,
  r2,
  radiusAtAngle,
  toPoints,
} from "./geometry";

export type { BotColor, BotColorId, BotExpression, BotExpressionId, BotShape, BotShapeId } from "./catalog";
export {
  BOT_COLORS,
  BOT_EXPRESSIONS,
  BOT_SHAPES,
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_EXPRESSION,
  DEFAULT_BOT_SHAPE,
} from "./catalog";

/**
 * The three choices that make a bot. Stored on an agent as-is, so it is a plain
 * object of ids and nothing derived — the geometry is this build's to supply, and
 * a stored bot must not freeze a copy of it.
 */
export interface AgentBot {
  shape: BotShapeId;
  color: BotColorId;
  expression: BotExpressionId;
}

/** The bot an agent gets when somebody opens the picker and changes nothing. */
export const DEFAULT_BOT: AgentBot = {
  shape: DEFAULT_BOT_SHAPE,
  color: DEFAULT_BOT_COLOR,
  expression: DEFAULT_BOT_EXPRESSION,
};

/** A bot read back out of the store, with anything unrecognised answered by the
 *  default. Returns null for nothing at all, which is an agent with no bot —
 *  a different thing from an agent with the default one. */
export function readBot(value: unknown): AgentBot | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as Partial<Record<keyof AgentBot, unknown>>;
  return {
    shape: botShape(typeof raw.shape === "string" ? raw.shape : null).id,
    color: botColor(typeof raw.color === "string" ? raw.color : null).id,
    expression: botExpression(typeof raw.expression === "string" ? raw.expression : null).id,
  };
}

/**
 * How much of the tile the body fills.
 *
 * Nearly all of it: a bot is the subject of whatever mounts it, not a sticker
 * floating in a margin. The couple of units held back are the room the outline's
 * smoothing needs — a Catmull-Rom curve bulges very slightly past its control
 * points, and at a full 100 the widest shapes would clip on the edge.
 */
const TILE = 100;
const FILL = 0.96;

/**
 * Ink dark enough or pale enough to read on a given body.
 *
 * Perceived luminance rather than a plain average: the eye weighs green far
 * above blue, so a mid-blue body and a mid-green one need opposite ink despite
 * averaging to nearly the same number.
 */
function inkFor(hex: string): string {
  const v = Number.parseInt(hex.slice(1), 16);
  const r = (v >> 16) & 255;
  const g = (v >> 8) & 255;
  const b = v & 255;
  const luminance = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
  return luminance > 0.55 ? "#14141a" : "#f6f5f3";
}

/**
 * A ground a bot reads against, when it is drawn somewhere small enough that
 * losing its silhouette would lose the bot.
 *
 * Fixed light or fixed dark rather than a theme role, for the same reason the
 * bodies are literal hex: the two neutral bodies let a bot opt out of having a
 * colour, and an ink bot on the dark scheme or a cream one on paper would
 * otherwise vanish into the surface it was drawn on. Pinning the ground to the
 * body means the pair is legible on either scheme and stops moving when the
 * scheme changes.
 *
 * It comes out the same tone the eyes are painted in, which is not a shortcut
 * but the same question asked twice: what reads against this body. So a bot on
 * its ground looks like one drawn with its eyes open onto it.
 */
export function botGround(bot: AgentBot): string {
  return inkFor(botColor(bot.color).hex);
}

const cache = new Map<string, string>();
/** Body outlines, kept apart from the marks that wear them: a bot that is
 *  looking around redraws its eyes many times a second and its body never
 *  changes, and the outline is the expensive half. */
const bodies = new Map<BotShapeId, string>();

/**
 * Where a bot is looking, over and above the expression it is wearing.
 *
 * Degrees, in the same frame as the expressions' own gaze: positive yaw looks
 * right, positive pitch looks up. This is what lets a bot follow something —
 * the expression stays whatever it is, and the head turns.
 */
export interface BotAim {
  yaw: number;
  pitch: number;
}

/**
 * A bot as an inline SVG string on a 100-unit tile, sized by whatever mounts it.
 *
 * The same tile and the same viewBox as an agent's marble face, so the two are
 * interchangeable wherever one identity mark is drawn.
 *
 * An aim turns the head without touching the expression. Only the resting mark
 * is memoised — a following bot passes through a continuum of angles, and
 * keeping every one of them would be a cache that only grows.
 */
export function botMark(bot: AgentBot, aim?: BotAim): string {
  const key = `${bot.shape}|${bot.color}|${bot.expression}`;
  const hit = aim ? undefined : cache.get(key);
  if (hit) return hit;

  const shape = botShape(bot.shape);
  const color = botColor(bot.color);
  const resting = botExpression(bot.expression);
  const expression = aim
    ? {
        ...resting,
        gaze: {
          ...resting.gaze,
          yaw: resting.gaze.yaw + aim.yaw,
          pitch: resting.gaze.pitch + aim.pitch,
        },
      }
    : resting;
  const ink = inkFor(color.hex);

  // Every shape is scaled by the widest one in the catalogue, so the tile fits
  // all of them and their relative weights survive — a triangle stays visibly
  // smaller than the circle it is measured against, which is how it was drawn.
  const R = ((TILE / 2) * FILL) / SHAPE_HEADROOM;
  let bodyPath = bodies.get(shape.id);
  if (bodyPath === undefined) {
    bodyPath = closedPath(toPoints(shape.radii, R));
    bodies.set(shape.id, bodyPath);
  }

  // The eyes live on a sphere of unit radius. Once the body is not a circle they
  // have to come back to the outline's real radius in their own direction, or a
  // narrow shape wears them outside itself.
  const poses = eyePoses(expression.gaze, R, expression.split);
  const eyes = poses
    .map((pose, i) => {
      // Past the limb of the sphere this eye has turned away from us entirely.
      if (pose.depth <= 0.02) return "";
      const cfg = expression.eyes[i]!;
      const fit = radiusAtAngle(shape.radii, Math.atan2(pose.y, pose.x));

      // The capsule's own tilt composes with the tangent frame, which is what
      // lets the two eyes lean opposite ways.
      const phi = (cfg.tilt * Math.PI) / 180;
      const cp = Math.cos(phi);
      const sp = Math.sin(phi);
      const ax = pose.a * cp + pose.c * sp;
      const ay = pose.b * cp + pose.d * sp;
      const cx = -pose.a * sp + pose.c * cp;
      const cy = -pose.b * sp + pose.d * cp;

      // A half-shut lid squashes the eye VERTICALLY ON SCREEN, not along the
      // capsule's own tilted axis, so it is composed last and touches only y.
      const k = lidScale(cfg.open);
      const matrix =
        `matrix(${r2(ax)},${r2(ay * k)},${r2(cx)},${r2(cy * k)},` +
        `${r2(pose.x * fit)},${r2(pose.y * fit)})`;
      // Fades out over the last sliver of the sphere instead of blinking off.
      const alpha = r2(clamp(pose.depth / 0.12));
      return (
        `<path d="${capsulePath(cfg.w * R, cfg.h * R)}" transform="${matrix}"` +
        ` opacity="${alpha}" fill="${ink}"/>`
      );
    })
    .join("");

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${TILE} ${TILE}">` +
    `<g transform="translate(${TILE / 2} ${TILE / 2})">` +
    `<path d="${bodyPath}" fill="${color.hex}"/>${eyes}` +
    `</g></svg>`;

  if (!aim) cache.set(key, svg);
  return svg;
}

/** What a bot is called in one line — for a closed row's summary. */
export function botSummary(bot: AgentBot): string {
  return `${botColor(bot.color).label} ${botShape(bot.shape).label.toLowerCase()} · ${botExpression(bot.expression).label.toLowerCase()}`;
}
