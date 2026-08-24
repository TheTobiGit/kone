/**
 * A bot, drawn: one body shape in one colour, wearing one expression.
 *
 * This is an agent's OTHER mark, and it is worth being clear about why there are
 * two. An avatar is a picture of somebody — it says who is speaking, and it
 * belongs in a transcript beside a name. A bot is a creature the agent drives,
 * and it belongs where the agent is *doing* something rather than saying it,
 * which is the composer. So a bot is built to move (see `./geometry` on why
 * every shape is a radial profile), and the composer bead is what actually
 * does: the same idle life as a guest's face, wearing the expression the
 * maker picked. An avatar never will.
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
  botForm,
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_EXPRESSION,
  DEFAULT_BOT_FORM,
  FORM_HEADROOM,
  type BotColorId,
  type BotExpressionId,
  type BotFormId,
} from "./catalog";
import {
  capsulePath,
  clamp,
  closedPath,
  eyePoses,
  lerp,
  lidScale,
  r2,
  radiusAtAngle,
  toPoints,
  type HeadGaze,
} from "./geometry";
import { liveliness, PITCH_MAX, PITCH_REST, YAW_MAX } from "../idleLife";

export type { BotColor, BotColorId, BotExpression, BotExpressionId, BotForm, BotFormId } from "./catalog";
export {
  BOT_COLORS,
  BOT_EXPRESSIONS,
  BOT_FORMS,
  DEFAULT_BOT_COLOR,
  DEFAULT_BOT_EXPRESSION,
  DEFAULT_BOT_FORM,
} from "./catalog";

/**
 * The three choices that make a bot. Stored on an agent as-is, so it is a plain
 * object of ids and nothing derived — the geometry is this build's to supply, and
 * a stored bot must not freeze a copy of it.
 */
export interface AgentBot {
  form: BotFormId;
  color: BotColorId;
  expression: BotExpressionId;
}

/** The bot an agent gets when somebody opens the picker and changes nothing. */
export const DEFAULT_BOT: AgentBot = {
  form: DEFAULT_BOT_FORM,
  color: DEFAULT_BOT_COLOR,
  expression: DEFAULT_BOT_EXPRESSION,
};

/** A bot read back out of the store, with anything unrecognised answered by the
 *  default. Returns null for nothing at all, which is an agent with no bot —
 *  a different thing from an agent with the default one. Accepts the stored
 *  key `shape` as well as `form`, so a bot saved before the rename still reads. */
/** A bot as persisted on an agent record: the three ids, plus the pre-rename
 *  `shape` key, each unvalidated until read. */
export interface StoredBot {
  form?: string | null;
  color?: string | null;
  expression?: string | null;
  "shape"?: string | null;
}

export function readBot(value: StoredBot | null | undefined): AgentBot | null {
  if (!value || !(value instanceof Object)) return null;
  const legacy = value["shape"];
  const form =
    value.form && value.form.trim()
      ? value.form
      : legacy && legacy.trim()
        ? legacy
        : null;
  return {
    form: botForm(form).id,
    color: botColor(value.color ?? null).id,
    expression: botExpression(value.expression ?? null).id,
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
const bodies = new Map<BotFormId, string>();

function bodyOf(formId: BotFormId, radii: number[], R: number): string {
  let path = bodies.get(formId);
  if (path === undefined) {
    path = closedPath(toPoints(radii, R));
    bodies.set(formId, path);
  }
  return path;
}

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
  const key = `${bot.form}|${bot.color}|${bot.expression}`;
  const hit = aim ? undefined : cache.get(key);
  if (hit) return hit;

  const form = botForm(bot.form);
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
  const R = ((TILE / 2) * FILL) / FORM_HEADROOM;
  const bodyPath = bodyOf(form.id, form.radii, R);

  // The eyes live on a sphere of unit radius. Once the body is not a circle they
  // have to come back to the outline's real radius in their own direction, or a
  // narrow shape wears them outside itself.
  const poses = eyePoses(expression.gaze, R, expression.split);
  const eyes = poses
    .map((pose, i) => {
      // Past the limb of the sphere this eye has turned away from us entirely.
      if (pose.depth <= 0.02) return "";
      const cfg = expression.eyes[i]!;
      const fit = radiusAtAngle(form.radii, Math.atan2(pose.y, pose.x));

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

/**
 * Pointer command for a live bot, in the same shape the guest face takes: a
 * direction on the unit box and how far the pointer owns it. The sampler
 * replaces the expression's gaze with this as `mix` rises, so a bot that rests
 * looking up and to the right actually looks at you rather than past you. What
 * the expression keeps is the shape of the eyes.
 */
export interface BotLook {
  nx: number;
  ny: number;
  mix: number;
}

export interface BotEyeDraw {
  d: string;
  matrix: string;
  alpha: number;
}

export interface BotFrame {
  bodyPath: string;
  fill: string;
  ink: string;
  driftX: number;
  driftY: number;
  breath: number;
  eyes: BotEyeDraw[];
}

/**
 * One frame of a live bot at time `t`, in seconds.
 *
 * Same idle life as the guest face — wander, blink, a breath — wearing the
 * expression the maker picked. The look, if any, replaces where the head
 * points; the wander is added after, so a following bot still keeps its life.
 */
export function sampleBot(t: number, bot: AgentBot, look?: BotLook): BotFrame {
  const form = botForm(bot.form);
  const color = botColor(bot.color);
  const expression = botExpression(bot.expression);
  const life = liveliness(t);
  const mix = look ? clamp(look.mix) : 0;
  const rest = expression.gaze;
  const gaze: HeadGaze = {
    yaw: lerp(rest.yaw, look ? look.nx * YAW_MAX : rest.yaw, mix) + life.dYaw,
    pitch: lerp(rest.pitch, look ? PITCH_REST - look.ny * PITCH_MAX : rest.pitch, mix) + life.dPitch,
    roll: rest.roll + life.dRoll,
  };

  const R = ((TILE / 2) * FILL) / FORM_HEADROOM;
  const driftX = life.driftX * R;
  const driftY = life.driftY * R;
  const ink = inkFor(color.hex);
  const poses = eyePoses(gaze, R, expression.split);
  const eyes: BotEyeDraw[] = [];
  for (let i = 0; i < poses.length; i++) {
    const pose = poses[i]!;
    if (pose.depth <= 0.02) continue;
    const cfg = expression.eyes[i]!;
    const fit = radiusAtAngle(form.radii, Math.atan2(pose.y, pose.x));
    const phi = (cfg.tilt * Math.PI) / 180;
    const cp = Math.cos(phi);
    const sp = Math.sin(phi);
    const ax = pose.a * cp + pose.c * sp;
    const ay = pose.b * cp + pose.d * sp;
    const cx = -pose.a * sp + pose.c * cp;
    const cy = -pose.b * sp + pose.d * cp;
    // Blink composes with the expression's own lid: a sleepy eye still shuts.
    const k = lidScale(cfg.open * life.lid);
    eyes.push({
      d: capsulePath(cfg.w * R, cfg.h * R),
      matrix:
        `matrix(${r2(ax)},${r2(ay * k)},${r2(cx)},${r2(cy * k)},` +
        `${r2(pose.x * fit + driftX)},${r2(pose.y * fit + driftY)})`,
      alpha: r2(clamp(pose.depth / 0.12)),
    });
  }

  return {
    bodyPath: bodyOf(form.id, form.radii, R),
    fill: color.hex,
    ink,
    driftX: r2(driftX),
    driftY: r2(driftY),
    breath: life.breath,
    eyes,
  };
}

/** What a bot is called in one line — for a closed row's summary. */
export function botSummary(bot: AgentBot): string {
  return `${botColor(bot.color).label} ${botForm(bot.form).label.toLowerCase()} · ${botExpression(bot.expression).label.toLowerCase()}`;
}
