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
import {
  drawThinkingLogo,
  logoForToolFamily,
  LOGO_STATE_TO_MODE,
  type LogoPointSet,
  type LogoState,
} from "~/utils/thinkingLogo";

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
  logoPoints?: LogoPointSet | null,
  classic = false,
): void {
  const hues = activeHues();
  const hex = hues.orbStates[state] || hues.orbStates.neutral || "#5E6AD2";

  if (!classic) {
    const points = logoPoints ?? logoForToolFamily(state);
    if (points) {
      // SAFETY: Checked membership in LOGO_STATE_TO_MODE guarantees valid LogoState
      const logoState: LogoState =
        state === "thinking"
          ? "thinking"
          : state === "working"
            ? "working"
            : (state in LOGO_STATE_TO_MODE ? (state as LogoState) : "thinking");
      drawThinkingLogo({
        ctx,
        size,
        time,
        state: logoState,
        points,
        tint: hex,
        dark,
        reduced,
      });
      return;
    }
  }

  const drawContext: OrbDrawCtx = {
    ctx,
    size,
    time,
    waitSec: time,
    hueDeg: hexToHueDeg(hex),
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
