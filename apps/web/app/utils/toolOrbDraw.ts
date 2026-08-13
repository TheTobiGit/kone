// The dispatch layer for kone's turn orbs. The drawers themselves live in
// depth-shaded, two tuned size presets) and tinted by the turn's family
// hue. This file keeps the long-lived public surface stable: the same
// state vocabulary, draw helpers and hue helpers the components import.

import { useTheme } from "~/composables/useTheme";
import type { ThemeHues } from "~/theme/roles";
import { MODE_DRAWS } from "~/utils/toolOrb/registry";
import { STATE_TO_MODE, resolveMode, type ModeKey } from "~/utils/toolOrb/presets";
import type { OrbSize, ToolOrbFamily, TurnOrbState } from "~/utils/toolOrb/types";

export type { OrbSize, ToolOrbFamily, TurnOrbState };

export type OrbTheme = { isDark: boolean; reduced: boolean };
export type OrbDrawCtx = {
  ctx: CanvasRenderingContext2D;
  size: number;
  width?: number;
  height?: number;
  time: number;
  waitSec?: number;
  hueDeg: number;
  theme: OrbTheme;
};

export function hexToHueDeg(hex: string): number {
  const h = hex.replace("#", "");
  if (h.length < 6) return 240;
  const r = parseInt(h.slice(0, 2), 16) / 255;
  const g = parseInt(h.slice(2, 4), 16) / 255;
  const b = parseInt(h.slice(4, 6), 16) / 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), d = max - min;
  if (!d) return 240;
  const raw = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return raw * 60;
}

/** Non-reactive read of the active theme's hue tables, for plain modules that
 *  cannot call a composable in setup. Reads resolve the live theme at call time,
 *  so a swap is picked up the next time a drawer or a meta table runs. */
export function activeHues(): ThemeHues {
  return useTheme().theme.value.hues;
}

/** The thinking orb's hue, read from the active theme on each call so a swap
 *  isn't frozen out. Returned as a bare string: callers interpolate it as a
 *  CSS value. */
export function thinkingOrbHue(): string {
  return activeHues().orbStates.thinking!;
}

/** Draw one mode's frame — preset (speed + scaled opts) resolved per size. */
function paintMode(c: OrbDrawCtx, mode: ModeKey): void {
  const { ctx, size, time, hueDeg, theme } = c;
  const { speed, opts } = resolveMode(mode, size);
  const t = theme.reduced ? 0.6 : time * speed;
  MODE_DRAWS[mode](ctx, size, t, theme.isDark, hueDeg, opts);
}

export function drawThinkingOrb(c: OrbDrawCtx): void {
  paintMode(c, "ring");
}

export function drawWorkingOrb(c: OrbDrawCtx): void {
  paintMode(c, "orbits");
}

export function drawToolOrb(family: ToolOrbFamily, c: OrbDrawCtx): void {
  paintMode(c, STATE_TO_MODE[family]);
}
