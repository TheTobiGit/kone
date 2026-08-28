import { describe, expect, it } from "bun:test";
import {
  adaptTint,
  bakeLogo,
  beatAt,
  deserializeLogo,
  expoInOut,
  fibDir,
  finalizeFrame,
  getSeatMap,
  logoForHugeIcon,
  logoForToolFamily,
  LOGO_PRESETS,
  LOGO_STATE_TO_MODE,
  makeProj,
  morphEase,
  parseTint,
  rasterizePathHeadless,
  radiusScale,
  recommendedCount,
  resolveLogo,
  serializeLogo,
  smootherE,
  THINKING_LOGO,
  TOOL_FAMILY_LOGOS,
  WORKING_LOGO,
} from "./thinkingLogo";
import { File01Icon, Search01Icon, AiBrain01Icon } from "@hugeicons/core-free-icons";
import { drawTurnOrb, stateForToolFamily } from "./thinkingOrb";

describe("thinkingLogo math & core", () => {
  it("computes smootherstep with 0 velocity and acceleration at ends", () => {
    expect(smootherE(0)).toBe(0);
    expect(smootherE(1)).toBe(1);
    expect(smootherE(0.5)).toBe(0.5);
  });

  it("computes expoInOut smoothly", () => {
    expect(expoInOut(0)).toBe(0);
    expect(expoInOut(1)).toBe(1);
    expect(expoInOut(0.5)).toBe(0.5);
  });

  it("computes morphEase correctly", () => {
    expect(morphEase(0, 0.3)).toBe(0);
    expect(morphEase(1, 0.3)).toBe(1);
  });

  it("generates Fibonacci sphere directions", () => {
    const dir = fibDir(0, 100);
    expect(dir.length).toBe(3);
    const len = Math.hypot(dir[0], dir[1], dir[2]);
    expect(Math.abs(len - 1)).toBeLessThan(1e-5);
  });

  it("creates orthographic projection without NaN", () => {
    const proj = makeProj(0.2, 0.3, 32, 32, 16);
    const [px, py, z] = proj(0, 0, 0);
    expect(Number.isFinite(px)).toBe(true);
    expect(Number.isFinite(py)).toBe(true);
    expect(Number.isFinite(z)).toBe(true);
  });

  it("computes radiusScale with sub-linear curve for small sizes", () => {
    const scale14 = radiusScale(14);
    const scale20 = radiusScale(20);
    const scale64 = radiusScale(64);
    const scale300 = radiusScale(300);

    expect(scale14).toBeGreaterThan(0.3);
    expect(scale20).toBeGreaterThan(scale14);
    expect(scale64).toBeGreaterThan(scale20);
    expect(scale300).toBeCloseTo(1, 4);
  });

  it("finalizes frame with depth sorting and rMin floor", () => {
    const dots = [
      { x: 10, y: 10, z: 0.5, r: 0.1, white: 0.5 },
      { x: 10, y: 10, z: -0.5, r: 1.2, white: 0.5 },
    ];
    const frame = finalizeFrame(dots, []);
    expect(frame.dots[0]!.z).toBe(-0.5);
    expect(frame.dots[1]!.z).toBe(0.5);
    expect(frame.dots[1]!.r).toBeGreaterThanOrEqual(0.75);
  });
});

describe("thinkingLogo tinting", () => {
  it("parses hex colours and rgb strings", () => {
    expect(parseTint("#ff0000")).toEqual({ r: 255, g: 0, b: 0 });
    expect(parseTint("#00ff00")).toEqual({ r: 0, g: 255, b: 0 });
    expect(parseTint("10, 20, 30")).toEqual({ r: 10, g: 20, b: 30 });
    expect(parseTint("invalid")).toBeNull();
  });

  it("adapts tint against dark and light substrates", () => {
    const black = { r: 0, g: 0, b: 0 };
    const adaptedDark = adaptTint(black, true);
    expect(adaptedDark.r).toBeGreaterThan(0);

    const white = { r: 255, g: 255, b: 255 };
    const adaptedLight = adaptTint(white, false);
    expect(adaptedLight.r).toBeLessThan(255);
  });
});

describe("thinkingLogo presets & states", () => {
  it("maps all tool states to valid modes", () => {
    const states = [
      "thinking",
      "searching",
      "working",
      "solving",
      "listening",
      "waiting",
      "generating",
      "read",
      "write",
      "search",
      "run",
      "intel",
      "agent",
      "del",
      "web",
      "neutral",
    ] as const;

    for (const s of states) {
      const mode = LOGO_STATE_TO_MODE[s];
      expect(mode).toBeDefined();
      expect(LOGO_PRESETS[mode]).toBeDefined();
    }
  });

  it("resolves logo with seat map caching", () => {
    const logo = TOOL_FAMILY_LOGOS.read;
    const resolved = resolveLogo("read", logo);
    expect(resolved.frame).toBeDefined();
    expect(resolved.binding.seats.length).toBe(logo.n);

    const seats1 = getSeatMap(logo);
    const seats2 = getSeatMap(logo);
    expect(seats1).toBe(seats2);
  });

  it("cycles beatAt correctly through dwell and morph", () => {
    const b0 = beatAt(0, 5.5, 1.9, 1, 0.1);
    expect(b0.m).toBe(0);
    expect(b0.workT).toBe(0);

    const bMark = beatAt(5.5 + 1.9, 5.5, 1.9, 1, 0.1);
    expect(bMark.m).toBeCloseTo(1, 1);
  });

  it("computes recommended dot count based on size", () => {
    expect(recommendedCount(14, "fill")).toBeGreaterThanOrEqual(24);
    expect(recommendedCount(64, "fill")).toBeGreaterThan(recommendedCount(20, "fill"));
  });
});

describe("thinkingLogo baking & serialization", () => {
  it("rasterizes bare SVG path in headless mode", () => {
    const mask = rasterizePathHeadless("M2 2 L22 2 L22 22 L2 22 Z", 24, 64);
    expect(mask.w).toBe(64);
    expect(mask.h).toBe(64);
    expect(mask.a.length).toBe(64 * 64);
  });

  it("bakes SVG path into LogoPointSet", async () => {
    const pointSet = await bakeLogo(
      { path: "M4 4 L20 4 L20 20 L4 20 Z", viewBox: 24 },
      { count: 40, shell: "dome" },
    );
    expect(pointSet.version).toBe(1);
    expect(pointSet.n).toBeGreaterThan(0);
    expect(pointSet.p.length).toBe(pointSet.n * 3);
    expect(pointSet.e.length).toBe(pointSet.n);
    expect(pointSet.shell).toBe("dome");
  });

  it("serializes and deserializes LogoPointSet roundtrip", async () => {
    const pointSet = await bakeLogo(
      { path: "M8 8 L16 8 L16 16 L8 16 Z", viewBox: 24 },
      { count: 30, shell: "dome" },
    );
    const json = serializeLogo(pointSet);
    const restored = deserializeLogo(json);
    expect(restored.version).toBe(1);
    expect(restored.n).toBe(pointSet.n);
    expect(restored.p.length).toBe(pointSet.p.length);
    expect(restored.e.length).toBe(pointSet.e.length);
  });
});

describe("pre-baked tool logos & mappings", () => {
  it("has prebaked point sets for all tool families", () => {
    const families = [
      "read",
      "write",
      "search",
      "run",
      "intel",
      "del",
      "web",
      "agent",
      "neutral",
    ] as const;
    for (const fam of families) {
      const logo = TOOL_FAMILY_LOGOS[fam];
      expect(logo).toBeDefined();
      expect(logo.version).toBe(1);
      expect(logo.n).toBeGreaterThan(50);
      expect(logo.p.length).toBe(logo.n * 3);
    }
  });

  it("maps HugeIcon singletons to prebaked logos", () => {
    expect(logoForHugeIcon(File01Icon)).toBe(TOOL_FAMILY_LOGOS.read);
    expect(logoForHugeIcon(Search01Icon)).toBe(TOOL_FAMILY_LOGOS.search);
    expect(logoForHugeIcon(AiBrain01Icon)).toBe(THINKING_LOGO);
  });

  it("returns appropriate logo for tool family or meta state", () => {
    expect(logoForToolFamily("read")).toBe(TOOL_FAMILY_LOGOS.read);
    expect(logoForToolFamily("write")).toBe(TOOL_FAMILY_LOGOS.write);
    expect(logoForToolFamily("thinking")).toBe(THINKING_LOGO);
    expect(logoForToolFamily("working")).toBe(WORKING_LOGO);
    expect(logoForToolFamily(undefined)).toBe(TOOL_FAMILY_LOGOS.neutral);
  });
});

describe("turnOrb integration", () => {
  it("resolves state for tool family", () => {
    expect(stateForToolFamily("read")).toBe("read");
    expect(stateForToolFamily("search")).toBe("search");
    expect(stateForToolFamily(undefined)).toBe("neutral");
  });

  it("executes drawTurnOrb without throwing", () => {
    // SAFETY: Mock CanvasRenderingContext2D subset required for headless rendering unit tests
    const mockCtx = {
      setTransform: () => {},
      clearRect: () => {},
      beginPath: () => {},
      arc: () => {},
      fill: () => {},
      moveTo: () => {},
      lineTo: () => {},
      stroke: () => {},
      fillStyle: "",
      strokeStyle: "",
      lineWidth: 1,
    } as unknown as CanvasRenderingContext2D;

    expect(() => {
      drawTurnOrb(mockCtx, 20, 1.5, true, "read");
      drawTurnOrb(mockCtx, 20, 1.5, true, "thinking");
      drawTurnOrb(mockCtx, 20, 1.5, true, "working");
      drawTurnOrb(mockCtx, 20, 1.5, false, "search");
      drawTurnOrb(mockCtx, 20, 1.5, true, "read", true); // reduced motion
      drawTurnOrb(mockCtx, 20, 1.5, true, "read", false, null, true); // classic mode
    }).not.toThrow();
  });
});
