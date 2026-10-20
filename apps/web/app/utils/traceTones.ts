/** The three kinds a request's sent tokens split into, as its trace draws them. */
export type TraceTokenKind = "cached" | "written" | "fresh";

/** One hue per kind, validated against the panel in both schemes (CVD
 *  separation and lightness band), so dark is steps of the same three hues
 *  rather than a flip. */
export const TRACE_TONES = {
  light: { cached: "#2a9d8f", written: "#d9952b", fresh: "#3f6fd1" },
  dark: { cached: "#21a08f", written: "#bd801c", fresh: "#5580e0" },
} satisfies Record<"light" | "dark", Record<TraceTokenKind, string>>;
