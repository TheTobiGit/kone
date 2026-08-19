/**
 * Colour maths for the theme builder.
 *
 * None of this runs at paint time — CSS `color-mix()` does that work in the
 * browser. These functions exist so a theme can be *grown* from a handful of
 * authored colours while the module evaluates: a palette that names only its
 * ground and its accent still ends up with a full role table, and the values it
 * gets are computed rather than guessed.
 *
 * Two spaces, for two different jobs. Straight sRGB interpolation is what the
 * surface ladder uses, because the ladder's job is to land on specific
 * lightness steps and sRGB is what those steps were originally picked in.
 * OKLCh is what hue work uses — rotating an accent to find its counter-hue, or
 * pulling chroma out of a colour — because only a perceptual space keeps
 * lightness steady while the hue moves.
 */

/** Channels in 0..1. */
export type Rgb = readonly [number, number, number];

/** Lightness 0..1, chroma 0..~0.4, hue in degrees 0..360. */
export type Oklch = readonly [number, number, number];

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));

/** Map each channel, keeping the three-tuple in the type rather than letting
 *  `Array.map` widen it to `number[]`. */
function mapRgb(rgb: Rgb, f: (v: number, i: number) => number): Rgb {
  return [f(rgb[0], 0), f(rgb[1], 1), f(rgb[2], 2)];
}

// ── sRGB ────────────────────────────────────────────────────────────────────
function srgbToLinear(c: number): number {
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

function linearToSrgb(c: number): number {
  return c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
}

/** `#rgb`, `#rrggbb` (with or without the hash) to channels in 0..1. */
export function parseHex(hex: string): Rgb {
  const t = hex.replace("#", "").toLowerCase();
  const full =
    t.length === 3
      ? t
          .split("")
          .map((c) => c + c)
          .join("")
      : t;
  const n = parseInt(full.slice(0, 6), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

export function toHex(rgb: Rgb): string {
  return `#${rgb
    .map((v) =>
      Math.round(clamp01(v) * 255)
        .toString(16)
        .padStart(2, "0"),
    )
    .join("")}`;
}

/**
 * Straight per-channel sRGB interpolation of two hex colours. This is the
 * surface ladder's mix: `mixHex(ground, "#ffffff", 0.85)` is "85% of the way to
 * white", which is how the raised surfaces were originally chosen.
 */
export function mixHex(a: string, b: string, t: number): string {
  const ca = parseHex(a);
  const cb = parseHex(b);
  return toHex(mapRgb(ca, (v, i) => v + (cb[i]! - v) * t));
}

// ── OKLab / OKLCh ───────────────────────────────────────────────────────────
function linearToOklab(rgb: Rgb): Rgb {
  const [r, g, b] = rgb;
  const l = 0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b;
  const m = 0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b;
  const s = 0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b;
  const l_ = Math.cbrt(l);
  const m_ = Math.cbrt(m);
  const s_ = Math.cbrt(s);
  return [
    0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_,
    1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_,
    0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_,
  ];
}

function oklabToLinear(lab: Rgb): Rgb {
  const [L, a, b] = lab;
  const l_ = L + 0.3963377774 * a + 0.2158037573 * b;
  const m_ = L - 0.1055613458 * a - 0.0638541728 * b;
  const s_ = L - 0.0894841775 * a - 1.291485548 * b;
  const l = l_ ** 3;
  const m = m_ ** 3;
  const s = s_ ** 3;
  return [
    4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
    -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
    -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s,
  ];
}

export function hexToOklch(hex: string): Oklch {
  const lin = mapRgb(parseHex(hex), srgbToLinear);
  const [L, a, b] = linearToOklab(lin);
  const C = Math.sqrt(a * a + b * b);
  // A neutral has no meaningful hue; report 0 rather than an artefact of noise.
  const h = C < 1e-6 ? 0 : ((Math.atan2(b, a) * 180) / Math.PI + 360) % 360;
  return [L, C, h];
}

/**
 * OKLCh back to a hex. Out-of-gamut requests are brought back by reducing
 * chroma while holding lightness and hue, which is what a designer means by
 * "the most saturated version of this colour that still exists" — clipping the
 * channels instead would shift the hue.
 */
export function oklchToHex([L, C, h]: Oklch): string {
  const rad = (h * Math.PI) / 180;
  let chroma = Math.max(0, C);
  for (let i = 0; i < 24; i++) {
    const lab: Rgb = [L, chroma * Math.cos(rad), chroma * Math.sin(rad)];
    const lin = oklabToLinear(lab);
    if (lin.every((v) => v >= -1e-4 && v <= 1 + 1e-4)) {
      return toHex(mapRgb(mapRgb(lin, linearToSrgb), clamp01));
    }
    chroma *= 0.92;
  }
  const lin = oklabToLinear([L, 0, 0]);
  return toHex(mapRgb(mapRgb(lin, linearToSrgb), clamp01));
}

/**
 * Rotate a colour's hue, holding its lightness and chroma. This is how an
 * unspecified secondary accent is found: the counter-hue of the primary at the
 * same perceived weight, so the two read as a deliberate pair rather than as
 * one strong colour and one weak one.
 */
export function rotateHue(hex: string, degrees: number): string {
  const [L, C, h] = hexToOklch(hex);
  return oklchToHex([L, C, (h + degrees + 360) % 360]);
}

/** Same hue, different lightness — the ladder step for a single hue. */
export function withLightness(hex: string, L: number): string {
  const [, C, h] = hexToOklch(hex);
  return oklchToHex([clamp01(L), C, h]);
}

/** Scale chroma. Below 1 calms a colour; above 1 pushes it toward the gamut edge. */
export function scaleChroma(hex: string, factor: number): string {
  const [L, C, h] = hexToOklch(hex);
  return oklchToHex([L, Math.max(0, C * factor), h]);
}

/**
 * Nudge a colour to a target lightness *and* calm it at the same time. Used for
 * the domain-identity roles, which must stay legible against the ground without
 * competing with the accent for attention.
 */
export function toned(hex: string, L: number, chromaFactor: number): string {
  const [, C, h] = hexToOklch(hex);
  return oklchToHex([clamp01(L), Math.max(0, C * chromaFactor), h]);
}

/** WCAG 2.1 relative luminance of a hex colour. */
export function luminance(hex: string): number {
  const [r, g, b] = parseHex(hex).map(srgbToLinear);
  return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
}

/** WCAG 2.1 contrast ratio between two opaque hex colours. */
export function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The better of black and white to place on a colour. A theme may always name
 * `accentInk` explicitly; this is the fallback when it doesn't, and it picks by
 * measurement rather than by assuming dark accents want white.
 */
export function readableInk(on: string, dark: string, light: string): string {
  return contrast(on, dark) >= contrast(on, light) ? dark : light;
}
