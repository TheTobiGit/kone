/** The five kinds a turn's tokens split into, as a request trace draws them. */
export type TraceTokenKind = "cached" | "written" | "fresh" | "output" | "reasoning";

/** One hue per kind, validated against the panel in both schemes (CVD
 *  separation and lightness band), so dark is steps of the same five hues
 *  rather than a flip. */
export const TRACE_TONES = {
  light: { cached: "#2a9d8f", written: "#d9952b", fresh: "#3f6fd1", output: "#d97757", reasoning: "#8a63d2" },
  dark: { cached: "#21a08f", written: "#bd801c", fresh: "#5580e0", output: "#d8704f", reasoning: "#9277e0" },
} satisfies Record<"light" | "dark", Record<TraceTokenKind, string>>;
