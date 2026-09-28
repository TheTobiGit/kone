import type { UsageRange } from "~/types/desktop";

// The windows a usage report can be asked for, once, with every name a surface
// gives them. The order is the reading order and also the order to read them in:
// each window holds the one before it, so reading them shortest first lets every
// scan reuse the transcripts the last one parsed.

export const USAGE_RANGES = [
  { id: "1d", label: "Today", short: "1D", long: "Today" },
  { id: "7d", label: "7 days", short: "7D", long: "Last 7 days" },
  { id: "30d", label: "30 days", short: "30D", long: "Last 30 days" },
  { id: "all", label: "All time", short: "All", long: "All time" },
] as const satisfies readonly {
  id: UsageRange;
  /** The segmented control's name for it. */
  label: string;
  /** For a control with little room. */
  short: string;
  /** For a sentence ("… · last 30 days"). */
  long: string;
}[];

export const USAGE_RANGE_IDS: readonly UsageRange[] = USAGE_RANGES.map((r) => r.id);

/** The windows longer than a day — where a surface already gives today its own
 *  figure. */
export const LONGER_USAGE_RANGES = USAGE_RANGES.filter((r) => r.id !== "1d");
