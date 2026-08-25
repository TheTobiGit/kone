import type { LogoPointSet } from "./cloud";
import { paintFrame } from "./core";
import { resolveLogo, type LogoState } from "./presets";
import { adaptTint, paintFrameTinted, parseTint } from "./tint";

export * from "./cloud";
export * from "./core";
export * from "./tint";
export * from "./logo";
export * from "./logoDeform";
export * from "./presets";
export * from "./bake";
export * from "./toolLogos";

export interface ThinkingLogoDrawOptions {
  ctx: CanvasRenderingContext2D;
  size: number;
  time: number;
  state?: LogoState;
  points: LogoPointSet;
  tint?: string;
  dark?: boolean;
  reduced?: boolean;
  speed?: number;
  tune?: Record<string, number | undefined>;
}

export function drawThinkingLogo(opts: ThinkingLogoDrawOptions): void {
  const {
    ctx,
    size,
    time,
    state = "thinking",
    points,
    tint,
    dark = true,
    reduced = false,
    speed = 1,
    tune,
  } = opts;

  const { frame, speed: baseSpeed, opts: modeOpts, binding } = resolveLogo(state, points, tune);

  const tSec = reduced ? 4.2 : time * baseSpeed * speed;
  const f = frame(size, tSec, modeOpts, binding);

  const parsed = tint ? parseTint(tint) : null;
  if (parsed) {
    const rgb = adaptTint(parsed, dark);
    paintFrameTinted(ctx, f, dark, rgb);
  } else {
    paintFrame(ctx, f, dark);
  }
}
