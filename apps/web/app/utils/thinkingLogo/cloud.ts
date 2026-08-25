/**
 * The wire format between the two halves of the thinking-logos engine.
 *
 * Everything here is plain data. No methods, no classes, no closures.
 */

/** How the mark was turned into dots. */
export type LogoStyle = "outline" | "fill" | "both";

/** How the flat silhouette was lifted into 3D. */
export type ShellMode = "flat" | "dome" | "slab";

/**
 * A baked logo. `p` is xyz triples in the engine's unit-sphere space
 * (origin-centred, y up, the mark inscribed within radius 1); `e` is each
 * point's normalised distance from the silhouette edge, which modes use to
 * weight ink so an interior can sit back from its outline.
 *
 * Flat typed arrays because this is indexed once per point per frame at
 * 60fps — an array of objects would cost a pointer chase per dot.
 */
export interface LogoPointSet {
  readonly version: 1;
  readonly n: number;
  readonly p: Float32Array;
  readonly e: Float32Array;
  readonly style: LogoStyle;
  readonly shell: ShellMode;
}

/**
 * Which sphere seat each logo dot flies home from, as a logo-index →
 * sphere-index permutation.
 *
 * Computed once when a preset is resolved, never per frame: building it
 * needs two sorts, and the engine's frame functions must stay
 * allocation-light. Shipping it alongside the points also means every port
 * assembles the logo in exactly the same order.
 */
export type SeatMap = Uint32Array;
