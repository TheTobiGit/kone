import {
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

const STATE_HUES: Record<TurnOrbState, string> = {
  working: "#71717a",
  thinking: "#8b5cf6",
  read: "#5b9dd9",
  write: "#8b7ff0",
  search: "#d99a4e",
  intel: "#48b0b8",
  run: "#4fae86",
  web: "#3fa9c9",
  agent: "#d97aa8",
  del: "#d96b6b",
  neutral: "#71717a",
};

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
    hueDeg: hexToHueDeg(STATE_HUES[state]),
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
