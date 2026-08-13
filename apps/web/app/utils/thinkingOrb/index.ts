import {
  activeHues,
  drawThinkingOrb,
  drawToolOrb,
  drawWorkingOrb,
  hexToHueDeg,
  type OrbDrawCtx,
  type ToolOrbFamily,
  type TurnOrbState,
} from "~/utils/toolOrbDraw";

export type { ToolOrbFamily, TurnOrbState };

export function stateForToolFamily(family: ToolOrbFamily | undefined): TurnOrbState {
  return family ?? "neutral";
}

export function drawTurnOrb(
  ctx: CanvasRenderingContext2D,
  size: number,
  time: number,
  dark: boolean,
  state: TurnOrbState,
  reduced = false,
): void {
  const drawContext: OrbDrawCtx = {
    ctx,
    size,
    time,
    waitSec: time,
    hueDeg: hexToHueDeg(activeHues().orbStates[state]!),
    theme: { isDark: dark, reduced },
  };

  if (state === "thinking") {
    drawThinkingOrb(drawContext);
    return;
  }
  if (state === "working") {
    drawWorkingOrb(drawContext);
    return;
  }
  drawToolOrb(state, drawContext);
}
