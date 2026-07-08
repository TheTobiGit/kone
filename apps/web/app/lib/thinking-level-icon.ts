export function getEffortLevelIndex(levels: ReadonlyArray<{ id: string }>, effortId: string) {
  const index = levels.findIndex((level) => level.id === effortId);
  return index >= 0 ? index : 0;
}

export function isNoThinkingLevel(effortId: string) {
  const normalized = effortId.toLowerCase();
  return normalized === "none" || normalized === "off";
}

export function isUltrathinkLevel(effortId: string) {
  return effortId.toLowerCase() === "ultrathink";
}

export const BRAIN_ICON_SIZE = 12;
export const BRAIN_ICON_OVERLAP = 8;

/**
 * Effort color tiers follow a cool → balanced → deep → intense progression:
 * - Sky: quick/light reasoning (low cognitive load, fast path)
 * - Emerald: balanced default effort
 * - Indigo: deep focused reasoning
 * - Violet: maximum reasoning depth
 * - Fuchsia: peak / ultrathink
 *
 * Inspired by common AI effort UI patterns (gray → yellow → green → lavender → purple)
 * and color psychology for cognitive load (cool tones for ease, warm/deep tones for intensity).
 */
export type EffortColorTier = "none" | "low" | "medium" | "high" | "max" | "peak";

export const EFFORT_COLOR_CLASS: Record<EffortColorTier, string> = {
  none: "text-zinc-500 dark:text-zinc-400",
  low: "text-sky-500 dark:text-sky-400",
  medium: "text-emerald-500 dark:text-emerald-400",
  high: "text-indigo-500 dark:text-indigo-400",
  max: "text-violet-600 dark:text-violet-400",
  peak: "text-fuchsia-600 dark:text-fuchsia-400",
};

const ORDERED_EFFORT_TIERS = ["low", "medium", "high", "max"] as const;

export function getEffortColorTier(
  levelIndex: number,
  levelTotal: number,
  effortId: string,
): EffortColorTier {
  if (isNoThinkingLevel(effortId)) return "none";
  if (isUltrathinkLevel(effortId)) return "peak";
  if (levelTotal <= 1) return "medium";

  const bucket = Math.round(
    (levelIndex / (levelTotal - 1)) * (ORDERED_EFFORT_TIERS.length - 1),
  );

  return ORDERED_EFFORT_TIERS[bucket] ?? "medium";
}

export function getThinkingIconWidth(brainCount: number) {
  if (brainCount <= 1) return BRAIN_ICON_SIZE;
  return BRAIN_ICON_SIZE + (brainCount - 1) * (BRAIN_ICON_SIZE - BRAIN_ICON_OVERLAP);
}

export function getThinkingBrainCount(levelIndex: number, levelTotal: number, effortId: string) {
  if (isNoThinkingLevel(effortId)) return 1;
  if (isUltrathinkLevel(effortId)) return 3;
  if (levelTotal <= 1) return 1;

  const maxBrains = Math.min(3, levelTotal);
  return Math.min(maxBrains, Math.ceil(((levelIndex + 1) / levelTotal) * maxBrains));
}

export function getThinkingStrokeWidth(levelIndex: number, levelTotal: number, effortId: string) {
  if (isNoThinkingLevel(effortId)) return 2;
  if (isUltrathinkLevel(effortId)) return 2.5;
  if (levelTotal <= 1) return 2;

  const ratio = levelIndex / (levelTotal - 1);
  return 1.5 + ratio;
}

export function getThinkingColorClass(
  levelIndex: number,
  levelTotal: number,
  effortId: string,
) {
  return EFFORT_COLOR_CLASS[getEffortColorTier(levelIndex, levelTotal, effortId)];
}

export function isThinkingSlashed(effortId: string) {
  return isNoThinkingLevel(effortId);
}
